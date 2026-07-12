'use strict';
/*
 * ntrip-client.js — NTRIP/2.0 caster client (mirrors the vehicle rtk_driver
 * ntrip_client). Connects to a CORS/VRS caster, performs the NTRIP handshake,
 * then streams raw RTCM3 bytes out as 'rtcm' Buffers. For VRS mountpoints it
 * feeds the rover's GGA back up to the caster via sendGGA().
 *
 * Credentials (username/password) come from a local secrets vault, exported as
 * env by the operator before launch — NEVER hardcode them here.
 *
 * Handshake request (== vehicle rtk_driver/ntrip_proto.hpp build_request):
 *   GET /<mountpoint> HTTP/1.1\r\n
 *   Host: <host>:<port>\r\n
 *   Ntrip-Version: Ntrip/2.0\r\n
 *   User-Agent: NTRIP rover-web-gcs\r\n
 *   Authorization: Basic <base64(user:pass)>\r\n
 *   Accept: * / *\r\n
 *   Connection: close\r\n
 *   \r\n
 *
 * Response first line (== vehicle parse_response):
 *   ICY 200 OK | HTTP/1.x 200 OK  -> OK, stream RTCM
 *   SOURCETABLE ...               -> error (mountpoint is a source table)
 *   ... 401 ...                   -> auth error
 *   ... 404 ...                   -> mountpoint not found
 *
 * Events:
 *   'open',  {mountpoint}   handshake OK, streaming
 *   'rtcm',  Buffer         raw RTCM3 bytes
 *   'close'                 disconnected (auto-reconnect follows unless close()d)
 *   'error', Error          handshake/status error (err.code = the status)
 */
const net = require('net');
const { EventEmitter } = require('events');

const MAX_HEADER = 64 * 1024;   // cap header accumulation (anti-OOM); real headers are tiny

// Classify a caster response first line, mirroring vehicle ntrip::parse_response.
function classifyFirstLine(first) {
  if (first.indexOf('SOURCETABLE') !== -1) return 'SOURCETABLE';
  if (first.indexOf('401') !== -1) return 'UNAUTHORIZED';
  if (first.indexOf('404') !== -1) return 'NOT_FOUND';
  if (first.indexOf('200') !== -1 &&
      (first.indexOf('ICY') !== -1 || first.indexOf('HTTP') !== -1)) return 'OK';
  return 'UNKNOWN';
}
const STATUS_MSG = {
  UNAUTHORIZED: 'NTRIP 401 unauthorized (check vault credentials)',
  NOT_FOUND: 'NTRIP 404 mountpoint not found',
  SOURCETABLE: 'NTRIP returned a SOURCETABLE (mountpoint is a source table, not a stream)',
  UNKNOWN: 'NTRIP unexpected response',
};

class NtripClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.host = (opts.host || '').trim();
    this.port = parseInt(opts.port || 2101, 10);
    this.mountpoint = (opts.mountpoint || '').trim();
    this.username = opts.username || '';
    this.password = opts.password || '';
    this.userAgent = opts.userAgent || 'NTRIP rover-web-gcs';
    this.debug = !!opts.debug;
    this.minBackoff = opts.minBackoff || 1000;   // 1s
    this.maxBackoff = opts.maxBackoff || 15000;  // capped at 15s

    this.sock = null;
    this.connected = false;      // handshake OK + streaming
    this.closed = false;
    this.headerDone = false;
    this.headerBuf = Buffer.alloc(0);
    this.backoff = this.minBackoff;
    this.reconnectTimer = null;
  }

  connect() {
    // Safe default: unconfigured (no host/mountpoint) -> never connect. Mirrors the
    // vehicle ntrip_client, which returns early when host/mountpoint are empty.
    if (!this.host || !this.mountpoint) {
      this._dbg('not configured (host/mountpoint empty) -> not connecting');
      return this;
    }
    this.closed = false;
    this._open();
    return this;
  }

  // Feed the rover's GGA up to the caster (VRS needs an approximate position).
  // Strip any trailing CR/LF then terminate with CRLF, matching the vehicle.
  sendGGA(ggaLine) {
    if (!this.connected || !this.sock || !ggaLine) return false;
    const line = String(ggaLine).replace(/[\r\n]+$/, '') + '\r\n';
    try { this.sock.write(line); return true; } catch (_) { return false; }
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this._teardownSocket();
    if (this.connected) { this.connected = false; this.emit('close'); }
  }

  // ---- internals ----
  _buildRequest() {
    let mp = this.mountpoint;
    if (mp[0] === '/') mp = mp.slice(1);
    const auth = Buffer.from(this.username + ':' + this.password).toString('base64');
    return (
      'GET /' + mp + ' HTTP/1.1\r\n' +
      'Host: ' + this.host + ':' + this.port + '\r\n' +
      'Ntrip-Version: Ntrip/2.0\r\n' +
      'User-Agent: ' + this.userAgent + '\r\n' +
      'Authorization: Basic ' + auth + '\r\n' +
      'Accept: */*\r\n' +
      'Connection: close\r\n' +
      '\r\n'
    );
  }

  _open() {
    if (this.closed) return;
    this._teardownSocket();
    this.headerDone = false;
    this.headerBuf = Buffer.alloc(0);
    let sock;
    try { sock = net.createConnection({ host: this.host, port: this.port }); }
    catch (e) { this._dbg('connect throw: ' + e.message); this._scheduleReconnect(); return; }
    this.sock = sock;
    try { sock.setNoDelay(true); } catch (_) {}
    sock.on('connect', () => {
      try { sock.write(this._buildRequest()); } catch (e) { this._dbg('request write failed: ' + e.message); }
    });
    sock.on('data', (buf) => this._onData(buf));
    sock.on('error', (e) => this._dbg('socket error: ' + e.message)); // 'close' follows; must not throw
    sock.on('close', () => this._onClose());
  }

  _onData(buf) {
    if (this.headerDone) { this.emit('rtcm', buf); return; }   // streaming phase

    this.headerBuf = Buffer.concat([this.headerBuf, buf]);
    if (this.headerBuf.length > MAX_HEADER) { this._fail('UNKNOWN', 'header too large'); return; }

    // Classify as soon as the first line is complete (so 401/404/SOURCETABLE fail fast,
    // without waiting for — or being defeated by — an oversized source table).
    const firstEol = this.headerBuf.indexOf('\r\n');
    if (firstEol < 0) return;                    // wait for the full first line
    const first = this.headerBuf.slice(0, firstEol).toString('latin1');
    const status = classifyFirstLine(first);
    if (status !== 'OK') { this._fail(status, first); return; }

    // OK: the RTCM stream begins after the blank line (\r\n\r\n). We request
    // Ntrip-Version 2.0, so casters answer with a full HTTP/ICY header block.
    const sep = this.headerBuf.indexOf('\r\n\r\n');
    if (sep < 0) return;                         // wait for end of headers
    const rest = Buffer.from(this.headerBuf.slice(sep + 4));   // copy: bytes after header = first RTCM
    this.headerBuf = Buffer.alloc(0);
    this.headerDone = true;
    this.connected = true;
    this.backoff = this.minBackoff;
    this.emit('open', { mountpoint: this.mountpoint });
    if (rest.length) this.emit('rtcm', rest);
  }

  _fail(code, detail) {
    const base = STATUS_MSG[code] || ('NTRIP error ' + code);
    const msg = code === 'NOT_FOUND' ? base + ': ' + this.mountpoint
      : (detail && (code === 'UNKNOWN')) ? base + ': ' + String(detail).slice(0, 120)
      : base;
    // Guard emit('error'): EventEmitter throws on an unheard 'error'. We never crash.
    const err = Object.assign(new Error(msg), { code });
    if (this.listenerCount('error')) this.emit('error', err); else this._dbg(msg);
    // Drop the socket; reconnect with backoff (config errors keep the caps at 15s).
    this._teardownSocket();
    this._onClose();
  }

  _onClose() {
    const wasConnected = this.connected;
    this.connected = false;
    this.headerDone = false;
    this.sock = null;
    if (wasConnected) this.emit('close');
    if (!this.closed) this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.maxBackoff);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._open();
    }, delay);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }

  _teardownSocket() {
    const s = this.sock;
    this.sock = null;
    if (s) {
      try { s.removeAllListeners(); } catch (_) {}
      try { s.destroy(); } catch (_) {}
    }
  }

  _dbg(msg) { if (this.debug) console.log('[ntrip] ' + msg); }
}

module.exports = { NtripClient, classifyFirstLine };
