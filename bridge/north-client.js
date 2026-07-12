'use strict';
/*
 * north-client.js — reusable JSON-lines TCP client for the vehicle's north bridge
 * (rover_gcs_bridge, "Route A"). This is the GCS-side foundation of the north
 * wire protocol; a future protocol-switch extends it for telemetry/commands.
 *
 * Wire protocol (authoritative = vehicle rover_gcs_bridge/proto):
 *   - Transport: plain TCP to the bridge (default 127.0.0.1:6001).
 *   - Framing:   newline-delimited JSON — one compact object per line.
 *   - Envelope (frames we SEND): {"v":1,"t":"<TYPE>","seq":<uint32>,"ts":<ms>, ...}
 *       v   MUST be integer 1  (the vehicle rejects non-integer / mismatched v)
 *       seq incrementing uint32 counter
 *       ts  Date.now() ms epoch
 *   - Incoming: the vehicle streams POSE/GNSS/SYS/MSTAT/EVENT/PARAM/ACK/PLAN/
 *       RTCM_GGA ... on the same socket. We parse EVERY line defensively — a bad
 *       line is ignored, never thrown.
 *
 * Events:
 *   'up'            socket connected
 *   'down'          socket disconnected (auto-reconnect follows unless close()d)
 *   'frame', obj    every well-formed JSON object line
 *   '<obj.t>', obj  same object re-emitted under its type (e.g. 'RTCM_GGA')
 */
const net = require('net');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');

const PROTO_VER = 1;                 // envelope v (MUST be integer per contract §1)
const MAX_RX_BUF = 1 << 20;          // 1 MiB cap on an un-terminated line (anti-OOM)

class NorthClient extends EventEmitter {
  constructor(host, port, opts = {}) {
    super();
    this.host = host || '127.0.0.1';
    this.port = parseInt(port || 6001, 10);
    this.debug = !!opts.debug;
    this.minBackoff = opts.minBackoff || 1000;   // 1s
    this.maxBackoff = opts.maxBackoff || 15000;  // capped at 15s

    this.sock = null;
    this.connected = false;
    this.closed = false;             // explicit close() -> stop reconnecting
    this.seq = 0;                    // uint32, wraps
    this.rxbuf = '';
    this._decoder = new StringDecoder('utf8');
    this.backoff = this.minBackoff;
    this.reconnectTimer = null;
  }

  connect() {
    this.closed = false;
    this._open();
    return this;
  }

  // Stamp v/seq/ts (ours always win over any caller-supplied envelope fields),
  // write compact JSON + '\n'. Drops silently if not connected. Never throws.
  send(obj) {
    if (!this.connected || !this.sock || !obj) return false;
    const seq = this.seq >>> 0;
    this.seq = (this.seq + 1) >>> 0;
    const frame = { v: PROTO_VER, t: obj.t, seq, ts: Date.now() };
    for (const k in obj) {
      if (k === 'v' || k === 't' || k === 'seq' || k === 'ts') continue;
      frame[k] = obj[k];
    }
    let line;
    try { line = JSON.stringify(frame) + '\n'; } catch (_) { return false; }
    try { this.sock.write(line); } catch (_) { return false; }
    return true;
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this._teardownSocket();
    if (this.connected) { this.connected = false; this.emit('down'); }
  }

  // ---- internals ----
  _open() {
    if (this.closed) return;
    this._teardownSocket();
    let sock;
    try { sock = net.createConnection({ host: this.host, port: this.port }); }
    catch (e) { this._dbg('connect throw: ' + e.message); this._scheduleReconnect(); return; }
    this.sock = sock;
    try { sock.setNoDelay(true); } catch (_) {}
    sock.on('connect', () => {
      this.connected = true;
      this.backoff = this.minBackoff;      // reset backoff on a good connect
      this.rxbuf = '';
      this._decoder = new StringDecoder('utf8');
      this.emit('up');
    });
    sock.on('data', (buf) => this._onData(buf));
    sock.on('error', (e) => this._dbg('socket error: ' + e.message)); // 'close' follows; must not throw
    sock.on('close', () => this._onClose());
  }

  _onData(buf) {
    this.rxbuf += this._decoder.write(buf);
    let idx;
    while ((idx = this.rxbuf.indexOf('\n')) >= 0) {
      const line = this.rxbuf.slice(0, idx).trim();
      this.rxbuf = this.rxbuf.slice(idx + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); }
      catch (_) { this._dbg('bad line: ' + line.slice(0, 80)); continue; }  // NEVER throw on a bad line
      if (!obj || typeof obj !== 'object') continue;
      this.emit('frame', obj);
      // 按类型再分发一次（消费方可 on('POSE')/on('RTCM_GGA') 等）。但 'error' 是 Node
      // EventEmitter 的保留事件：无监听者时 emit('error') 会**同步抛出**并击穿整个 bridge 进程
      // （连带 live demo）。北向协议无 'error' 上行帧；恶意/异常 {t:'error'} 行按契约 §8 前向兼容
      // 一律忽略（'frame' 已发过，路由层会当未知类型丢弃），此处显式跳过以守 no-throw 承诺。
      if (typeof obj.t === 'string' && obj.t && obj.t !== 'error') this.emit(obj.t, obj);
    }
    if (this.rxbuf.length > MAX_RX_BUF) {         // un-terminated garbage: drop, don't grow
      this._dbg('rx overflow, dropping ' + this.rxbuf.length + ' bytes');
      this.rxbuf = '';
    }
  }

  _onClose() {
    const wasConnected = this.connected;
    this.connected = false;
    this.sock = null;
    if (wasConnected) this.emit('down');
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

  _dbg(msg) { if (this.debug) console.log('[north] ' + msg); }
}

module.exports = { NorthClient, PROTO_VER };
