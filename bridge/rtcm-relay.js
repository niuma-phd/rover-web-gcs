'use strict';
/*
 * rtcm-relay.js — wires an NtripClient (correction source) to a NorthClient
 * (vehicle bridge). This is the GCS side of the vehicle's "gcs_relay" corr_source
 * mode: the GCS pulls RTCM3 from a CORS/VRS caster and streams it down to the
 * vehicle, while relaying the vehicle's GGA back up to the caster for VRS.
 *
 *   caster --RTCM3--> NtripClient --'rtcm'--> [chunk] --> NorthClient --'RTCM'--> vehicle
 *   caster <--GGA---- NtripClient <--sendGGA-- [relay] <--'RTCM_GGA'-- NorthClient <-- vehicle
 *
 * Chunking: the vehicle enforces decoded <= 32768 bytes/frame (kMaxRtcmChunk) and
 * base64 input <= 43696 chars. We chunk the RTCM byte stream into frames whose
 * DECODED payload is <= 16384 bytes (a safe margin), base64-encode each, and send
 * one {t:'RTCM', data:'<base64>'} frame per chunk (streaming, no id, no ACK).
 */
const { EventEmitter } = require('events');
const { NorthClient } = require('./north-client');
const { NtripClient } = require('./ntrip-client');

const RTCM_CHUNK = 16384;        // decoded bytes per RTCM frame (vehicle hard cap 32768)
const STATUS_MIN_MS = 1000;      // throttle byte-count 'status' emits to <=1/s

class RtcmRelay extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.north = opts.north || new NorthClient(opts.northHost, opts.northPort, { debug: opts.debug });
    this.ntrip = opts.ntrip || new NtripClient({
      host: opts.ntripHost, port: opts.ntripPort, mountpoint: opts.mountpoint,
      username: opts.username, password: opts.password, userAgent: opts.userAgent,
      debug: opts.debug,
    });
    this.status = {
      ntripUp: false, northUp: false,
      bytesRelayed: 0, framesRelayed: 0,
      lastRtcmMs: 0, lastGgaMs: 0,
      mountpoint: this.ntrip.mountpoint || '',
      caster: (this.ntrip.host || '') + ':' + (this.ntrip.port || 0),
    };
    this.started = false;
    this._lastStatusEmit = 0;
    this._wire();
  }

  _wire() {
    this.north.on('up', () => { this.status.northUp = true; this._emitStatus(true); });
    this.north.on('down', () => { this.status.northUp = false; this._emitStatus(true); });
    // Vehicle -> GCS GGA (VRS feedback): forward to the caster.
    this.north.on('RTCM_GGA', (frame) => {
      if (frame && typeof frame.gga === 'string' && frame.gga) {
        this.ntrip.sendGGA(frame.gga);
        this.status.lastGgaMs = Date.now();
        this._emitStatus();
      }
    });

    this.ntrip.on('open', () => { this.status.ntripUp = true; this._emitStatus(true); });
    this.ntrip.on('close', () => { this.status.ntripUp = false; this._emitStatus(true); });
    this.ntrip.on('error', (e) => this.emit('ntrip-error', e)); // keep reconnecting; surface for logging
    this.ntrip.on('rtcm', (buf) => this._onRtcm(buf));
  }

  _onRtcm(buf) {
    if (!buf || !buf.length) return;
    for (let off = 0; off < buf.length; off += RTCM_CHUNK) {
      const piece = buf.subarray(off, Math.min(off + RTCM_CHUNK, buf.length));
      if (this.north.send({ t: 'RTCM', data: piece.toString('base64') })) {
        this.status.bytesRelayed += piece.length;
        this.status.framesRelayed += 1;
      }
    }
    this.status.lastRtcmMs = Date.now();
    this._emitStatus();
  }

  start() {
    if (this.started) return this;
    this.started = true;
    this.north.connect();
    this.ntrip.connect();
    return this;
  }

  stop() {
    if (!this.started) return this;
    this.started = false;
    try { this.ntrip.close(); } catch (_) {}
    try { this.north.close(); } catch (_) {}
    this.status.ntripUp = false;
    this.status.northUp = false;
    this._emitStatus(true);
    return this;
  }

  getStatus() { return Object.assign({}, this.status); }

  // force=true for state transitions (up/down/open/close); throttled for byte updates.
  _emitStatus(force) {
    const now = Date.now();
    if (!force && now - this._lastStatusEmit < STATUS_MIN_MS) return;
    this._lastStatusEmit = now;
    this.emit('status', this.getStatus());
  }
}

module.exports = { RtcmRelay, RTCM_CHUNK };
