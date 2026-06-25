#!/usr/bin/env node
'use strict';
/*
 * Rover Web GCS — MAVLink bridge + static web server (MVP)
 *
 * Browser  <--WebSocket(JSON)-->  this bridge  <--MAVLink(serial/udp/tcp)-->  ArduPilot Rover
 *
 * The browser cannot open serial/UDP directly, so this Node process owns the
 * autopilot link, parses/encodes MAVLink (via node-mavlink), and exchanges
 * simple JSON messages with the browser over WebSocket.
 *
 * Run:  node bridge/server.js            (then open http://localhost:8080)
 * Env:  PORT=8080  (web/ws port)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const net = require('net');
const { Writable } = require('stream');
const { WebSocketServer } = require('ws');

const {
  MavLinkPacketSplitter, MavLinkPacketParser, MavLinkProtocolV2,
  minimal, common, ardupilotmega, send,
} = require('node-mavlink');

const REGISTRY = { ...minimal.REGISTRY, ...common.REGISTRY, ...ardupilotmega.REGISTRY };

const WEB_PORT = parseInt(process.env.PORT || '8080', 10);
const GCS_SYSID = 255;
const GCS_COMPID = 190; // MAV_COMP_ID_MISSIONPLANNER

// ---- ArduPilot Rover flight modes (custom_mode) -------------------------------
const ROVER_MODES = {
  MANUAL: 0, ACRO: 1, STEERING: 3, HOLD: 4, LOITER: 5, FOLLOW: 6,
  SIMPLE: 7, DOCK: 8, CIRCLE: 9, AUTO: 10, RTL: 11, SMART_RTL: 12,
  GUIDED: 15, INITIALISING: 16,
};
const ROVER_MODE_NAME = Object.fromEntries(Object.entries(ROVER_MODES).map(([k, v]) => [v, k]));

// =============================================================================
//  Transport abstraction: serial | udp | tcp  -> raw byte streams
// =============================================================================
class Transport {
  constructor() { this.onData = () => {}; this.onClose = () => {}; this.out = null; }
  writeRaw(_buf) {}
  close() {}
}

function makeSerial(opts) {
  let SerialPort;
  try { ({ SerialPort } = require('serialport')); }
  catch (e) { throw new Error('serialport module not installed. Run `npm install serialport`, or use UDP/TCP. (' + e.message + ')'); }
  const t = new Transport();
  const port = new SerialPort({ path: opts.path, baudRate: parseInt(opts.baud || 57600, 10) });
  port.on('data', (b) => t.onData(b));
  port.on('close', () => t.onClose());
  port.on('error', (e) => { log('serial error: ' + e.message); t.onClose(); });
  t.out = port;                       // SerialPort is a Duplex stream (writable)
  t.writeRaw = (buf) => port.write(buf);
  t.close = () => { try { port.close(); } catch (_) {} };
  t.describe = () => `serial ${opts.path}@${opts.baud || 57600}`;
  return t;
}

function makeTcp(opts) {
  const t = new Transport();
  const sock = net.createConnection({ host: opts.host || '127.0.0.1', port: parseInt(opts.port || 5760, 10) });
  sock.on('data', (b) => t.onData(b));
  sock.on('close', () => t.onClose());
  sock.on('error', (e) => { log('tcp error: ' + e.message); t.onClose(); });
  t.out = sock;
  t.writeRaw = (buf) => sock.write(buf);
  t.close = () => { try { sock.destroy(); } catch (_) {} };
  t.describe = () => `tcp ${opts.host || '127.0.0.1'}:${opts.port || 5760}`;
  return t;
}

function makeUdp(opts) {
  // Listen on a local port; learn the autopilot's address from the first packet.
  // Works with ArduPilot/SITL `--out udpout:<thisHost>:<port>` and with telemetry bridges.
  const t = new Transport();
  const sock = dgram.createSocket('udp4');
  let remote = (opts.host && opts.port) ? { address: opts.host, port: parseInt(opts.port, 10) } : null;
  sock.on('message', (msg, rinfo) => { remote = { address: rinfo.address, port: rinfo.port }; t.onData(msg); });
  sock.on('error', (e) => { log('udp error: ' + e.message); t.onClose(); });
  const listenPort = parseInt(opts.listen || opts.localPort || 14550, 10);
  sock.bind(listenPort);
  t.out = new Writable({ write(chunk, _enc, cb) { if (remote) sock.send(chunk, remote.port, remote.address, () => cb()); else cb(); } });
  t.writeRaw = (buf) => { if (remote) sock.send(buf, remote.port, remote.address); };
  t.close = () => { try { sock.close(); } catch (_) {} };
  t.describe = () => `udp :${listenPort}` + (remote ? ` <-> ${remote.address}:${remote.port}` : ' (waiting for vehicle)');
  return t;
}

// =============================================================================
//  MAVLink link state
// =============================================================================
let transport = null;
let splitter = null;
let parser = null;
const PROTOCOL = new MavLinkProtocolV2();
PROTOCOL.sysid = GCS_SYSID;
PROTOCOL.compid = GCS_COMPID;

let target = { system: 1, component: 1 };
let haveTarget = false;
let hbInterval = null;
let lastHeartbeatRx = 0;

const vehicle = {
  connected: false, type: null, autopilot: null, armed: false,
  mode: null, modeName: '--', lat: null, lon: null, hdg: 0, gs: 0,
  fixType: 0, sats: 0, battV: 0, battA: 0, battPct: -1,
  home: null,
};

// Mission protocol state
let upload = null;     // { items: [...], inflight: false }
let download = null;   // { count: 0, seq: 0, items: [] }

// Telemetry log (.tlog) state
let tlogStream = null;
let tlogPath = null;
function writeTlog(frame) {
  try {
    const ts = Buffer.alloc(8);
    ts.writeBigUInt64BE(BigInt(Date.now()) * 1000n); // microseconds, big-endian (QGC/MP .tlog format)
    tlogStream.write(ts); tlogStream.write(frame);
  } catch (_) {}
}
function tlogStart() {
  if (tlogStream) return;
  const dir = path.join(__dirname, '..', 'logs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const name = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.tlog';
  tlogPath = path.join(dir, name);
  tlogStream = fs.createWriteStream(tlogPath);
  log('tlog recording -> ' + tlogPath);
  broadcast({ t: 'tlog', recording: true, file: name });
}
function tlogStop() {
  if (!tlogStream) return;
  tlogStream.end(); tlogStream = null;
  log('tlog stopped -> ' + tlogPath);
  broadcast({ t: 'tlog', recording: false, file: path.basename(tlogPath || '') });
}

function mavSend(msg) {
  if (!transport || !transport.out) return;
  Promise.resolve(send(transport.out, msg, PROTOCOL)).catch((e) => log('send error: ' + e.message));
}

function connectLink(cfg) {
  disconnectLink();
  try {
    if (cfg.transport === 'serial') transport = makeSerial(cfg);
    else if (cfg.transport === 'tcp') transport = makeTcp(cfg);
    else transport = makeUdp(cfg);
  } catch (e) {
    broadcast({ t: 'link', connected: false, error: e.message });
    log('connect failed: ' + e.message);
    return;
  }

  splitter = new MavLinkPacketSplitter();
  parser = new MavLinkPacketParser();
  splitter.pipe(parser);
  parser.on('data', onPacket);
  parser.on('error', (e) => log('parse error: ' + e.message));

  transport.onData = (buf) => { try { splitter.write(buf); } catch (_) {} };
  transport.onClose = () => { log('link closed'); disconnectLink(); };

  vehicle.connected = true;
  haveTarget = false;
  log('link up: ' + transport.describe());
  broadcast({ t: 'link', connected: true, transport: transport.describe() });

  // GCS heartbeat @1Hz so the vehicle accepts our commands / keeps GCS-failsafe happy.
  hbInterval = setInterval(sendGcsHeartbeat, 1000);
  sendGcsHeartbeat();
}

function disconnectLink() {
  tlogStop();
  if (hbInterval) { clearInterval(hbInterval); hbInterval = null; }
  if (transport) { try { transport.close(); } catch (_) {} transport = null; }
  if (parser) { try { parser.removeAllListeners(); } catch (_) {} }
  splitter = null; parser = null;
  upload = null; download = null;
  if (vehicle.connected) { vehicle.connected = false; broadcast({ t: 'link', connected: false }); }
}

function sendGcsHeartbeat() {
  const hb = new minimal.Heartbeat();
  hb.type = minimal.MavType.GCS;               // 6
  hb.autopilot = minimal.MavAutopilot.INVALID; // 8
  hb.baseMode = 0; hb.customMode = 0;
  hb.systemStatus = minimal.MavState.ACTIVE;
  hb.mavlinkVersion = 3;
  mavSend(hb);
}

function requestDataStreams() {
  // Legacy but reliable on ArduPilot: ask for ALL streams at 4 Hz.
  const rds = new common.RequestDataStream();
  rds.targetSystem = target.system; rds.targetComponent = target.component;
  rds.reqStreamId = 0;      // MAV_DATA_STREAM_ALL
  rds.reqMessageRate = 4;
  rds.startStop = 1;
  mavSend(rds);
}

// =============================================================================
//  Incoming MAVLink -> browser telemetry
// =============================================================================
function onPacket(packet) {
  if (tlogStream && packet.buffer) writeTlog(packet.buffer);
  const clazz = REGISTRY[packet.header.msgid];
  if (!clazz) return;
  let m;
  try { m = packet.protocol.data(packet.payload, clazz); } catch (_) { return; }
  const id = packet.header.msgid;

  switch (id) {
    case minimal.Heartbeat.MSG_ID: {
      // ignore our own / other GCS heartbeats
      if (m.type === minimal.MavType.GCS) break;
      if (!haveTarget) {
        target = { system: packet.header.sysid, component: packet.header.compid };
        haveTarget = true;
        log(`vehicle detected sysid=${target.system} comp=${target.component} type=${m.type} ap=${m.autopilot}`);
        requestDataStreams();
      }
      lastHeartbeatRx = Date.now();
      vehicle.type = m.type; vehicle.autopilot = m.autopilot;
      vehicle.armed = (m.baseMode & minimal.MavModeFlag.SAFETY_ARMED) !== 0;
      vehicle.mode = m.customMode;
      vehicle.modeName = ROVER_MODE_NAME[m.customMode] || ('MODE_' + m.customMode);
      broadcast({ t: 'hb', type: m.type, autopilot: m.autopilot, armed: vehicle.armed,
        mode: vehicle.mode, modeName: vehicle.modeName });
      break;
    }
    case common.GlobalPositionInt.MSG_ID: {
      vehicle.lat = m.lat / 1e7; vehicle.lon = m.lon / 1e7;
      vehicle.hdg = (m.hdg === 65535 ? vehicle.hdg : m.hdg / 100);
      const vx = m.vx / 100, vy = m.vy / 100;
      vehicle.gs = Math.hypot(vx, vy);
      broadcast({ t: 'pos', lat: vehicle.lat, lon: vehicle.lon, relAlt: m.relativeAlt / 1000,
        hdg: vehicle.hdg, gs: vehicle.gs });
      break;
    }
    case common.GpsRawInt.MSG_ID: {
      vehicle.fixType = m.fixType; vehicle.sats = m.satellitesVisible;
      broadcast({ t: 'gps', fixType: m.fixType, sats: m.satellitesVisible, hdop: m.eph / 100 });
      break;
    }
    case common.SysStatus.MSG_ID: {
      vehicle.battV = m.voltageBattery / 1000;
      vehicle.battA = m.currentBattery / 100;
      vehicle.battPct = m.batteryRemaining;
      broadcast({ t: 'sys', battV: vehicle.battV, battA: vehicle.battA, battPct: m.batteryRemaining });
      break;
    }
    case common.VfrHud.MSG_ID: {
      broadcast({ t: 'vfr', gs: m.groundspeed, hdg: m.heading, throttle: m.throttle });
      break;
    }
    case common.RadioStatus.MSG_ID: {
      broadcast({ t: 'radio', rssi: m.rssi, remrssi: m.remrssi, noise: m.noise, remnoise: m.remnoise, txbuf: m.txbuf });
      break;
    }
    case common.ParamValue.MSG_ID: {
      broadcast({ t: 'param', id: String(m.paramId).replace(/\0+$/, ''), value: m.paramValue, ptype: m.paramType, index: m.paramIndex, count: m.paramCount });
      break;
    }
    case common.FenceStatus.MSG_ID: {
      broadcast({ t: 'fence_status', breach: m.breachStatus, btype: m.breachType, count: m.breachCount });
      break;
    }
    case common.StatusText.MSG_ID: {
      broadcast({ t: 'text', severity: m.severity, text: String(m.text || '').replace(/\x00+$/,'') });
      break;
    }
    case common.CommandAck.MSG_ID: {
      broadcast({ t: 'ack', command: m.command, result: m.result });
      break;
    }
    case common.HomePosition.MSG_ID: {
      vehicle.home = { lat: m.latitude / 1e7, lon: m.longitude / 1e7 };
      broadcast({ t: 'home', lat: vehicle.home.lat, lon: vehicle.home.lon });
      break;
    }
    case common.MissionCurrent.MSG_ID: {
      broadcast({ t: 'mission_current', seq: m.seq });
      break;
    }
    case common.MissionItemReached.MSG_ID: {
      broadcast({ t: 'mission_reached', seq: m.seq });
      break;
    }
    // ---- mission upload: vehicle asks for items ----
    case common.MissionRequestInt.MSG_ID:
    case common.MissionRequest.MSG_ID: {
      if (upload) sendMissionItem(m.seq);
      break;
    }
    // ---- mission download: vehicle answers ----
    case common.MissionCount.MSG_ID: {
      if (download) {
        download.count = m.count; download.seq = 0; download.items = [];
        if (m.count > 0) requestMissionItem(0);
        else finishDownload();
      }
      break;
    }
    case common.MissionItemInt.MSG_ID:
    case common.MissionItem.MSG_ID: {
      if (download) {
        const lat = (id === common.MissionItemInt.MSG_ID) ? m.x / 1e7 : m.x;
        const lon = (id === common.MissionItemInt.MSG_ID) ? m.y / 1e7 : m.y;
        download.items.push({ seq: m.seq, frame: m.frame, command: m.command, lat, lon, alt: m.z,
          param1: m.param1, param2: m.param2, param3: m.param3, param4: m.param4 });
        download.seq = m.seq + 1;
        if (download.seq < download.count) requestMissionItem(download.seq);
        else finishDownload();
      }
      break;
    }
    case common.MissionAck.MSG_ID: {
      if (upload) {
        const accepted = (m.type === 0); // MAV_MISSION_ACCEPTED = 0
        const isFence = upload.missionType === common.MavMissionType.FENCE;
        log((isFence ? 'fence' : 'mission') + ' upload ' + (accepted ? 'ACCEPTED' : 'REJECTED type=' + m.type));
        broadcast({ t: 'mission_uploaded', ok: accepted, result: m.type, fence: isFence });
        upload = null;
      }
      break;
    }
    default: break;
  }
}

// =============================================================================
//  Commands  (browser -> vehicle)
// =============================================================================
function cmdLong(command, p = {}) {
  const c = new common.CommandLong();
  c.targetSystem = target.system; c.targetComponent = target.component;
  c.command = command; c.confirmation = 0;
  // NOTE: node-mavlink serializes CommandLong params from _param1.._param7 (the .param1 setter does NOT map there)
  c._param1 = p.p1 || 0; c._param2 = p.p2 || 0; c._param3 = p.p3 || 0; c._param4 = p.p4 || 0;
  c._param5 = p.p5 || 0; c._param6 = p.p6 || 0; c._param7 = p.p7 || 0;
  mavSend(c);
}

function doArm(arm, force) {
  cmdLong(common.MavCmd.COMPONENT_ARM_DISARM, { p1: arm ? 1 : 0, p2: force ? 21196 : 0 });
}

function doSetMode(modeNum) {
  const sm = new common.SetMode();
  sm.targetSystem = target.system;
  sm.baseMode = minimal.MavModeFlag.CUSTOM_MODE_ENABLED; // 1
  sm.customMode = modeNum;
  mavSend(sm);
}

function doChangeSpeed(speed) {
  // MAV_CMD_DO_CHANGE_SPEED: p1=0 (ground speed), p2=target m/s, p3=-1 (throttle unchanged)
  cmdLong(common.MavCmd.DO_CHANGE_SPEED, { p1: 0, p2: speed, p3: -1 });
}

function startMission() {
  // Robustly (re)start the mission from the first waypoint. Just sending MISSION_START
  // or switching to AUTO does NOT restart a mission that is already in the completed /
  // "stale" state — the firmware logs "Mission is stale" / "Auto mission changed but
  // failed to restart command" and the rover sits with throttle 0 in AUTO. The reliable
  // recipe (verified against real ArduPilot Rover SITL) is to cycle the mode and reset
  // the current item: HOLD -> DO_SET_MISSION_CURRENT(0) -> AUTO -> MISSION_START.
  log('start mission: HOLD -> reset current -> AUTO -> MISSION_START');
  doSetMode(ROVER_MODES.HOLD);
  setTimeout(() => cmdLong(common.MavCmd.DO_SET_MISSION_CURRENT, { p1: 0 }), 400);
  setTimeout(() => doSetMode(ROVER_MODES.AUTO), 800);
  setTimeout(() => cmdLong(common.MavCmd.MISSION_START), 1200);
}

function getParams(names) {
  for (const id of names) {
    const r = new common.ParamRequestRead();
    r.targetSystem = target.system; r.targetComponent = target.component;
    r.paramId = id; r.paramIndex = -1; // -1 => look up by name
    mavSend(r);
  }
}

function setParam(id, value) {
  const ps = new common.ParamSet();
  ps.targetSystem = target.system; ps.targetComponent = target.component;
  ps.paramId = id; ps.paramValue = value; ps.paramType = common.MavParamType.REAL32;
  mavSend(ps);
}

function doGuidedGoto(lat, lon) {
  doSetMode(ROVER_MODES.GUIDED);
  const sp = new common.SetPositionTargetGlobalInt();
  sp.timeBootMs = 0;
  sp.targetSystem = target.system; sp.targetComponent = target.component;
  sp.coordinateFrame = common.MavFrame.GLOBAL_RELATIVE_ALT_INT; // 6
  // type_mask: ignore everything except position (bits for vel/accel/yaw set to 1 = ignore)
  sp.typeMask = 0b0000111111111000;
  sp.latInt = Math.round(lat * 1e7); sp.lonInt = Math.round(lon * 1e7); sp.alt = 0;
  mavSend(sp);
}

// ---- generic mission / fence upload (MISSION protocol with mission_type) ----
function beginUpload(missionType, specs, label) {
  upload = { missionType, items: specs };
  const count = new common.MissionCount();
  count.targetSystem = target.system; count.targetComponent = target.component;
  count.count = specs.length; count.missionType = missionType;
  log(label + ': sending count=' + specs.length);
  mavSend(count);
}

function startUpload(items) {
  // items: [{lat, lon, alt}]  -> seq 0 = home placeholder, seq 1..N = NAV_WAYPOINT
  const home = vehicle.home || (items[0] ? { lat: items[0].lat, lon: items[0].lon } : { lat: 0, lon: 0 });
  const specs = [];
  specs.push({ frame: common.MavFrame.GLOBAL, command: common.MavCmd.NAV_WAYPOINT, lat: home.lat, lon: home.lon, alt: 0 });
  for (const w of items) specs.push({ frame: common.MavFrame.GLOBAL_RELATIVE_ALT, command: common.MavCmd.NAV_WAYPOINT, lat: w.lat, lon: w.lon, alt: w.alt || 0 });
  beginUpload(common.MavMissionType.MISSION, specs, 'mission upload');
}

function startFenceUpload(items) {
  // items: [{kind:'inc'|'exc', polygon:[[lat,lon],...]} | {kind:'circInc'|'circExc', lat, lon, radius}]
  const specs = [];
  for (const f of items) {
    if (f.kind === 'circInc' || f.kind === 'circExc') {
      specs.push({ frame: common.MavFrame.GLOBAL, lat: f.lat, lon: f.lon, alt: 0, p1: f.radius || 10,
        command: f.kind === 'circInc' ? common.MavCmd.NAV_FENCE_CIRCLE_INCLUSION : common.MavCmd.NAV_FENCE_CIRCLE_EXCLUSION });
    } else if (f.polygon && f.polygon.length >= 3) {
      const cmd = f.kind === 'exc' ? common.MavCmd.NAV_FENCE_POLYGON_VERTEX_EXCLUSION : common.MavCmd.NAV_FENCE_POLYGON_VERTEX_INCLUSION;
      for (const v of f.polygon) specs.push({ frame: common.MavFrame.GLOBAL, command: cmd, lat: v[0], lon: v[1], alt: 0, p1: f.polygon.length });
    }
  }
  if (!specs.length) { log('fence upload: no valid items'); broadcast({ t: 'mission_uploaded', ok: false, fence: true, result: -1 }); return; }
  beginUpload(common.MavMissionType.FENCE, specs, 'fence upload');
}

function sendMissionItem(seq) {
  if (!upload || !upload.items[seq]) return;
  const w = upload.items[seq];
  const it = new common.MissionItemInt();
  it.targetSystem = target.system; it.targetComponent = target.component;
  it.seq = seq; it.frame = w.frame; it.command = w.command;
  it.current = seq === 0 ? 1 : 0; it.autocontinue = 1;
  it.param1 = w.p1 || 0; it.param2 = w.p2 || 0; it.param3 = w.p3 || 0; it.param4 = w.p4 || 0;
  it.x = Math.round(w.lat * 1e7); it.y = Math.round(w.lon * 1e7); it.z = w.alt || 0;
  it.missionType = upload.missionType;
  mavSend(it);
}

function fenceEnable(on) { cmdLong(common.MavCmd.DO_FENCE_ENABLE, { p1: on ? 1 : 0 }); }

function rcOverride(steer, throttle) {
  // steer/throttle in -1..1 -> RC channels (ArduRover ch1=steering, ch3=throttle). 0 = release a channel.
  const o = new common.RcChannelsOverride();
  o.targetSystem = target.system; o.targetComponent = target.component;
  const us = (v) => Math.max(1100, Math.min(1900, Math.round(1500 + v * 400)));
  o.chan1Raw = us(steer); o.chan2Raw = 0; o.chan3Raw = us(throttle);
  o.chan4Raw = 0; o.chan5Raw = 0; o.chan6Raw = 0; o.chan7Raw = 0; o.chan8Raw = 0;
  mavSend(o);
}
function rcRelease() {
  const o = new common.RcChannelsOverride();
  o.targetSystem = target.system; o.targetComponent = target.component;
  for (let i = 1; i <= 8; i++) o['chan' + i + 'Raw'] = 0; // 0 = give channels back to RC/vehicle
  mavSend(o);
}

// ---- mission download ----
function startDownload() {
  download = { count: 0, seq: 0, items: [] };
  const req = new common.MissionRequestList();
  req.targetSystem = target.system; req.targetComponent = target.component;
  req.missionType = common.MavMissionType.MISSION;
  mavSend(req);
}
function requestMissionItem(seq) {
  const r = new common.MissionRequestInt();
  r.targetSystem = target.system; r.targetComponent = target.component;
  r.seq = seq; r.missionType = common.MavMissionType.MISSION;
  mavSend(r);
}
function finishDownload() {
  const ack = new common.MissionAck();
  ack.targetSystem = target.system; ack.targetComponent = target.component;
  ack.type = 0; // MAV_MISSION_ACCEPTED
  ack.missionType = common.MavMissionType.MISSION;
  mavSend(ack);
  // strip seq 0 (home) for display
  const wps = download.items.filter((x) => x.seq > 0).map((x) => ({ lat: x.lat, lon: x.lon, alt: x.alt }));
  broadcast({ t: 'mission_list', items: wps, raw: download.items });
  log('mission download complete: ' + download.items.length + ' items');
  download = null;
}

// =============================================================================
//  WebSocket <-> browser
// =============================================================================
const clients = new Set();
function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const ws of clients) { if (ws.readyState === 1) ws.send(s); }
}
function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  console.log(line);
  broadcast({ t: 'log', msg: line });
}

function handleClientMessage(raw) {
  let m; try { m = JSON.parse(raw); } catch (_) { return; }
  switch (m.t) {
    case 'connect': connectLink(m); break;
    case 'disconnect': disconnectLink(); break;
    case 'arm': doArm(!!m.arm, !!m.force); break;
    case 'mode': if (ROVER_MODES[m.mode] != null) doSetMode(ROVER_MODES[m.mode]); else if (typeof m.mode === 'number') doSetMode(m.mode); break;
    case 'rtl': doSetMode(ROVER_MODES.RTL); break;
    case 'auto': doSetMode(ROVER_MODES.AUTO); break;
    case 'pause': doSetMode(ROVER_MODES.HOLD); break;
    case 'startMission': startMission(); break;
    case 'estop': doArm(false, true); break;            // emergency: force disarm
    case 'goto': doGuidedGoto(m.lat, m.lon); break;
    case 'changeSpeed': doChangeSpeed(m.speed); break;
    case 'setHome': cmdLong(common.MavCmd.DO_SET_HOME, { p1: 0, p5: m.lat, p6: m.lon, p7: 0 }); break;
    case 'setCurrent': cmdLong(common.MavCmd.DO_SET_MISSION_CURRENT, { p1: m.seq }); break;
    case 'uploadMission': startUpload(m.items || []); break;
    case 'downloadMission': startDownload(); break;
    case 'getParams': getParams(m.names || []); break;
    case 'setParam': setParam(m.id, m.value); break;
    case 'uploadFence': startFenceUpload(m.items || []); break;
    case 'fenceEnable': fenceEnable(!!m.on); break;
    case 'rc': rcOverride(m.steer || 0, m.throttle || 0); break;
    case 'rcRelease': rcRelease(); break;
    case 'tlogStart': tlogStart(); break;
    case 'tlogStop': tlogStop(); break;
    case 'status': sendSnapshot(); break;
    default: break;
  }
}

function sendSnapshot(ws) {
  const snap = { t: 'snapshot', vehicle, connected: vehicle.connected,
    link: transport ? transport.describe() : null };
  const s = JSON.stringify(snap);
  if (ws && ws.readyState === 1) ws.send(s); else broadcast(snap);
}

// =============================================================================
//  Static web server + WS upgrade
// =============================================================================
const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon' };

// ---- whole-site password (opt-in: enforced only if .site-auth / GCS_SITE_AUTH is set;
//      empty => disabled, so local dev / current usage is unaffected) ----
function readSiteAuth() {
  try { return fs.readFileSync(path.join(__dirname, '..', '.site-auth'), 'utf8').trim(); } catch (_) {}
  return (process.env.GCS_SITE_AUTH || '').trim();
}
const SITE_AUTH = readSiteAuth(); // "user:pass"
if (SITE_AUTH) log('whole-site password ENABLED');
function authOk(req) {
  if (!SITE_AUTH) return true;
  const m = (req.headers['authorization'] || '').match(/^Basic\s+(.+)$/i);
  if (!m) return false;
  let dec = ''; try { dec = Buffer.from(m[1], 'base64').toString('utf8'); } catch (_) { return false; }
  const a = Buffer.from(dec), b = Buffer.from(SITE_AUTH);
  return a.length === b.length && require('crypto').timingSafeEqual(a, b);
}
function need401(res) {
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Rover GCS"', 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('需要登录 / authentication required');
}

// ---- feedback store (local, gitignored) ----
const DATA_DIR = path.join(__dirname, '..', 'data');
const FEEDBACK_FILE = path.join(DATA_DIR, 'feedback.jsonl');
function appendFeedback(item) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
  fs.appendFileSync(FEEDBACK_FILE, JSON.stringify(item) + '\n');
}
function readFeedback() {
  try {
    return fs.readFileSync(FEEDBACK_FILE, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}
// ---- optional feedback screenshot (one image per feedback, gitignored) ----
const IMG_DIR = path.join(DATA_DIR, 'feedback-images');
const IMG_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const IMG_CTYPE = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
function saveFeedbackImage(id, b64, type) {
  const ext = IMG_TYPES[type]; if (!ext || !b64) return null;
  let buf; try { buf = Buffer.from(String(b64), 'base64'); } catch (_) { return null; }
  if (!buf.length || buf.length > 6 * 1024 * 1024) return null; // 6 MB decoded cap
  try { fs.mkdirSync(IMG_DIR, { recursive: true }); fs.writeFileSync(path.join(IMG_DIR, id + '.' + ext), buf); }
  catch (_) { return null; }
  return id + '.' + ext;
}

const server = http.createServer((req, res) => {
  if (!authOk(req)) return need401(res);
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

  // ---- feedback API ----
  if (urlPath === '/api/feedback' && req.method === 'POST') {
    let body = '', tooBig = false;
    req.on('data', (c) => { body += c; if (body.length > 8 * 1024 * 1024) { tooBig = true; req.destroy(); } });
    req.on('end', () => {
      if (tooBig) { res.writeHead(413); res.end('too large'); return; }
      let d; try { d = JSON.parse(body || '{}'); } catch (_) { res.writeHead(400); res.end('{"ok":false}'); return; }
      const text = (d.text || '').toString().slice(0, 4000).trim();
      if (!text) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"empty"}'); return; }
      const item = {
        id: 'fb_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        ts: new Date().toISOString(), text,
        contact: (d.contact || '').toString().slice(0, 200),
        category: (d.category || '').toString().slice(0, 40),
        image: null, status: 'new', reply: null, ua: (req.headers['user-agent'] || '').slice(0, 200),
      };
      if (d.image) { const fn = saveFeedbackImage(item.id, d.image, String(d.imageType || '')); if (fn) item.image = fn; }
      appendFeedback(item); log('feedback received: ' + item.id + (item.image ? ' (+screenshot)' : ''));
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, id: item.id }));
    });
    return;
  }
  if (urlPath === '/api/feedback' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(readFeedback())); return;
  }
  if (urlPath === '/api/feedback/image' && req.method === 'GET') {
    const id = ((req.url.split('?')[1] || '').match(/(?:^|&)id=([^&]+)/) || [])[1] || '';
    const safe = decodeURIComponent(id).replace(/[^a-z0-9_]/gi, '');
    const hit = safe && Object.values(IMG_TYPES).map((e) => path.join(IMG_DIR, safe + '.' + e)).find((p) => fs.existsSync(p));
    if (!hit) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': IMG_CTYPE[path.extname(hit).slice(1)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(hit).pipe(res); return;
  }

  // ---- static files ----
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath === '/feedback') urlPath = '/feedback.html';
  const file = path.join(PUBLIC, path.normalize(urlPath));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, verifyClient: (info, cb) => {
  if (authOk(info.req)) return cb(true);
  cb(false, 401, 'auth required');
} });
wss.on('connection', (ws) => {
  clients.add(ws);
  log('browser connected (' + clients.size + ')');
  sendSnapshot(ws);
  ws.on('message', (data) => handleClientMessage(data.toString()));
  ws.on('close', () => { clients.delete(ws); });
  ws.on('error', () => { clients.delete(ws); });
});

// link watchdog: report stale heartbeat
setInterval(() => {
  if (vehicle.connected && haveTarget && Date.now() - lastHeartbeatRx > 5000) {
    broadcast({ t: 'stale', ms: Date.now() - lastHeartbeatRx });
  }
}, 2000);

server.listen(WEB_PORT, () => {
  console.log(`\n  Rover Web GCS bridge running:`);
  console.log(`    open  ->  http://localhost:${WEB_PORT}\n`);
});

process.on('SIGINT', () => { disconnectLink(); process.exit(0); });
