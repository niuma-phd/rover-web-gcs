#!/usr/bin/env node
'use strict';
/*
 * Minimal ArduPilot-Rover MAVLink simulator (for testing the web GCS without hardware).
 * Speaks MAVLink v2 over UDP to the bridge: telemetry out, and reacts to commands,
 * mode changes, mission/fence uploads, RC override (manual driving) and guided goto.
 * It is a lightweight behavioural sim (NOT the real firmware) — good enough to drive
 * the rover on the map, run missions, test geofence breach and joystick control.
 *
 * Run:  node sim/rover-sim.js         (sends to the bridge at 127.0.0.1:14550)
 * Env:  BRIDGE_HOST, BRIDGE_PORT, SIM_LAT, SIM_LON
 * Then in the GCS connect via UDP / listen port 14550.
 */
const dgram = require('dgram');
const { Writable } = require('stream');
const {
  minimal, common, MavLinkProtocolV2, MavLinkPacketSplitter, MavLinkPacketParser, send,
} = require('node-mavlink');

const REGISTRY = { ...minimal.REGISTRY, ...common.REGISTRY };
const BRIDGE_HOST = process.env.BRIDGE_HOST || '127.0.0.1';
const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || '14550', 10);
const MODES = { MANUAL: 0, ACRO: 1, STEERING: 3, HOLD: 4, LOITER: 5, AUTO: 10, RTL: 11, SMART_RTL: 12, GUIDED: 15 };
const NAME = Object.fromEntries(Object.entries(MODES).map(([k, v]) => [v, k]));

const MAX_SPEED = 8;     // m/s at full throttle
const TURN_RATE = 90;    // deg/s at full steering
const CRUISE = 5;      // default auto speed

const S = {
  lat: parseFloat(process.env.SIM_LAT || '22.5900'), lon: parseFloat(process.env.SIM_LON || '113.9500'),
  hdg: 90, speed: 0, targetSpeed: CRUISE, armed: false, mode: MODES.HOLD,
  battV: 12.6, battPct: 100,
  home: null, mission: [], curSeq: 0,
  fence: { inc: [], exc: [], enabled: false, breach: 0, breachCount: 0 },
  rc: null, rcAt: 0, guided: null,
  params: { CRUISE_SPEED: CRUISE, WP_SPEED: 0, WP_RADIUS: 2, TURN_MAX_G: 0.6, FS_GCS_ENABLE: 1, FS_TIMEOUT: 5, FS_ACTION: 2, BATT_LOW_VOLT: 10.5 },
};
S.home = { lat: S.lat, lon: S.lon };

// ---- UDP link to bridge ----
const sock = dgram.createSocket('udp4');
const PROTO = new MavLinkProtocolV2(); PROTO.sysid = 1; PROTO.compid = 1;
const out = new Writable({ write(c, _e, cb) { sock.send(c, BRIDGE_PORT, BRIDGE_HOST, () => cb()); } });
function tx(msg) { send(out, msg, PROTO).catch(() => {}); }
const split = new MavLinkPacketSplitter(), parse = new MavLinkPacketParser(); split.pipe(parse);
sock.on('message', (b) => split.write(b));
parse.on('data', onPacket);

// ---- geo helpers ----
const R2D = 180 / Math.PI, D2R = Math.PI / 180;
function localNE(lat1, lon1, lat2, lon2) {
  const n = (lat2 - lat1) * 111320;
  const e = (lon2 - lon1) * 111320 * Math.cos(lat1 * D2R);
  return [n, e];
}
function bearingTo(lat, lon, lat2, lon2) { const [n, e] = localNE(lat, lon, lat2, lon2); return (Math.atan2(e, n) * R2D + 360) % 360; }
function distTo(lat, lon, lat2, lon2) { const [n, e] = localNE(lat, lon, lat2, lon2); return Math.hypot(n, e); }
function pointInPoly(lat, lon, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const yi = poly[i][0], xi = poly[i][1], yj = poly[j][0], xj = poly[j][1];
    if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

// ---- command handling ----
function ack(cmd, result = 0) { const a = new common.CommandAck(); a.command = cmd; a.result = result; a.targetSystem = 255; a.targetComponent = 190; tx(a); }
function statustext(sev, text) { const s = new common.StatusText(); s.severity = sev; s.text = text; tx(s); }

let upRx = null; // receiving an upload from the GCS
function onPacket(pk) {
  const C = REGISTRY[pk.header.msgid]; if (!C) return;
  let m; try { m = pk.protocol.data(pk.payload, C); } catch (_) { return; }
  switch (pk.header.msgid) {
    case common.CommandLong.MSG_ID: {
      const c = m.command;
      if (c === common.MavCmd.COMPONENT_ARM_DISARM) { S.armed = m._param1 === 1; ack(c); statustext(6, S.armed ? 'Armed' : 'Disarmed'); }
      else if (c === common.MavCmd.DO_SET_MODE) { S.mode = m._param2 | 0; ack(c); statustext(6, 'Mode ' + (NAME[S.mode] || S.mode)); }
      else if (c === common.MavCmd.MISSION_START) { S.mode = MODES.AUTO; S.curSeq = 1; ack(c); }
      else if (c === common.MavCmd.DO_CHANGE_SPEED) { S.targetSpeed = m._param2 || CRUISE; ack(c); }
      else if (c === common.MavCmd.DO_FENCE_ENABLE) { S.fence.enabled = m._param1 === 1; ack(c); statustext(5, 'Fence ' + (S.fence.enabled ? 'enabled' : 'disabled')); }
      else if (c === common.MavCmd.DO_SET_HOME) { if (m._param5 || m._param6) S.home = { lat: m._param5, lon: m._param6 }; else S.home = { lat: S.lat, lon: S.lon }; ack(c); }
      else if (c === common.MavCmd.DO_SET_MISSION_CURRENT) { S.curSeq = m._param1 | 0; ack(c); }
      else ack(c);
      break;
    }
    case common.SetMode.MSG_ID: { S.mode = m.customMode | 0; statustext(6, 'Mode ' + (NAME[S.mode] || S.mode)); break; }
    case common.SetPositionTargetGlobalInt.MSG_ID: { S.guided = { lat: m.latInt / 1e7, lon: m.lonInt / 1e7 }; if (S.mode !== MODES.GUIDED) S.mode = MODES.GUIDED; break; }
    case common.RcChannelsOverride.MSG_ID: {
      if (!m.chan1Raw && !m.chan3Raw) { S.rc = null; }
      else { S.rc = { steer: (m.chan1Raw - 1500) / 400, throttle: (m.chan3Raw - 1500) / 400 }; S.rcAt = tick; }
      break;
    }
    case common.MissionCount.MSG_ID: { upRx = { type: m.missionType, count: m.count, seq: 0, items: [] }; reqItem(0); break; }
    case common.MissionItemInt.MSG_ID: {
      if (upRx) {
        upRx.items.push({ seq: m.seq, command: m.command, lat: m.x / 1e7, lon: m.y / 1e7, p1: m.param1 });
        if (m.seq + 1 < upRx.count) reqItem(m.seq + 1); else commitUpload();
      }
      break;
    }
    case common.MissionRequestList.MSG_ID: { sendMissionCount(m.missionType); break; }
    case common.MissionRequestInt.MSG_ID: case common.MissionRequest.MSG_ID: { sendDownItem(m.seq, m.missionType); break; }
    case common.ParamRequestList.MSG_ID: { Object.keys(S.params).forEach((k, i) => sendParam(k, i)); break; }
    case common.ParamRequestRead.MSG_ID: { const id = String(m.paramId).replace(/\0+$/, ''); if (id in S.params) sendParam(id, m.paramIndex); break; }
    case common.ParamSet.MSG_ID: { const id = String(m.paramId).replace(/\0+$/, ''); S.params[id] = m.paramValue; statustext(6, 'Param ' + id + '=' + m.paramValue); sendParam(id, 0); break; }
    default: break;
  }
}
function reqItem(seq) { const r = new common.MissionRequestInt(); r.targetSystem = 255; r.targetComponent = 190; r.seq = seq; r.missionType = upRx.type; tx(r); }
function commitUpload() {
  const ack0 = new common.MissionAck(); ack0.targetSystem = 255; ack0.targetComponent = 190; ack0.type = 0; ack0.missionType = upRx.type; tx(ack0);
  if (upRx.type === common.MavMissionType.FENCE) {
    S.fence.inc = []; S.fence.exc = []; let cur = null, curCmd = null;
    for (const it of upRx.items) {
      if (it.command === common.MavCmd.NAV_FENCE_POLYGON_VERTEX_INCLUSION || it.command === common.MavCmd.NAV_FENCE_POLYGON_VERTEX_EXCLUSION) {
        if (it.command !== curCmd) { cur = []; curCmd = it.command; (it.command === common.MavCmd.NAV_FENCE_POLYGON_VERTEX_INCLUSION ? S.fence.inc : S.fence.exc).push(cur); }
        cur.push([it.lat, it.lon]);
      }
    }
    statustext(6, 'Fence loaded: inc=' + S.fence.inc.length + ' exc=' + S.fence.exc.length);
  } else {
    S.mission = upRx.items.filter((x) => x.seq > 0).map((x) => ({ lat: x.lat, lon: x.lon }));
    statustext(6, 'Mission loaded: ' + S.mission.length + ' wp');
  }
  upRx = null;
}
function sendMissionCount(type) {
  const list = type === common.MavMissionType.FENCE ? fenceItems() : missionItems();
  downCache = { type, list };
  const c = new common.MissionCount(); c.targetSystem = 255; c.targetComponent = 190; c.count = list.length; c.missionType = type; tx(c);
}
let downCache = null;
function sendDownItem(seq, type) {
  if (!downCache || !downCache.list[seq]) return;
  const w = downCache.list[seq];
  const it = new common.MissionItemInt(); it.targetSystem = 255; it.targetComponent = 190;
  it.seq = seq; it.frame = 0; it.command = w.command; it.current = 0; it.autocontinue = 1;
  it.param1 = w.p1 || 0; it.param2 = 0; it.param3 = 0; it.param4 = 0;
  it.x = Math.round(w.lat * 1e7); it.y = Math.round(w.lon * 1e7); it.z = 0; it.missionType = type; tx(it);
}
function missionItems() {
  const list = [{ command: common.MavCmd.NAV_WAYPOINT, lat: S.home.lat, lon: S.home.lon }];
  for (const w of S.mission) list.push({ command: common.MavCmd.NAV_WAYPOINT, lat: w.lat, lon: w.lon });
  return list;
}
function fenceItems() {
  const list = [];
  for (const poly of S.fence.inc) for (const v of poly) list.push({ command: common.MavCmd.NAV_FENCE_POLYGON_VERTEX_INCLUSION, lat: v[0], lon: v[1], p1: poly.length });
  for (const poly of S.fence.exc) for (const v of poly) list.push({ command: common.MavCmd.NAV_FENCE_POLYGON_VERTEX_EXCLUSION, lat: v[0], lon: v[1], p1: poly.length });
  return list;
}
function sendParam(id, index) {
  const v = new common.ParamValue(); v.paramId = id; v.paramValue = S.params[id]; v.paramType = common.MavParamType.REAL32;
  v.paramCount = Object.keys(S.params).length; v.paramIndex = index < 0 ? 0 : index; tx(v);
}

// ---- physics @ 10 Hz ----
let tick = 0;
function step() {
  tick++;
  const dt = 0.1;
  if (S.rc && tick - S.rcAt > 15) S.rc = null; // override timeout ~1.5s
  let desiredSpeed = 0, targetBrg = null;

  if (S.armed) {
    if (S.mode === MODES.MANUAL || S.mode === MODES.STEERING || S.mode === MODES.ACRO) {
      if (S.rc) { desiredSpeed = S.rc.throttle * MAX_SPEED; S.hdg = (S.hdg + S.rc.steer * TURN_RATE * dt + 360) % 360; }
    } else if (S.mode === MODES.AUTO && S.mission.length) {
      if (S.curSeq < 1) S.curSeq = 1;
      const wp = S.mission[S.curSeq - 1];
      if (wp) {
        const d = distTo(S.lat, S.lon, wp.lat, wp.lon);
        targetBrg = bearingTo(S.lat, S.lon, wp.lat, wp.lon);
        desiredSpeed = S.params.WP_SPEED > 0 ? S.params.WP_SPEED : (S.targetSpeed || CRUISE);
        if (d < Math.max(1.5, S.params.WP_RADIUS)) {
          const reached = new common.MissionItemReached(); reached.seq = S.curSeq; tx(reached);
          S.curSeq++;
          const mc = new common.MissionCurrent(); mc.seq = S.curSeq; tx(mc);
          if (S.curSeq > S.mission.length) { S.mode = MODES.HOLD; statustext(6, 'Mission complete'); }
        }
      }
    } else if (S.mode === MODES.GUIDED && S.guided) {
      const d = distTo(S.lat, S.lon, S.guided.lat, S.guided.lon);
      if (d > 1.5) { targetBrg = bearingTo(S.lat, S.lon, S.guided.lat, S.guided.lon); desiredSpeed = S.targetSpeed || CRUISE; }
    } else if (S.mode === MODES.RTL || S.mode === MODES.SMART_RTL) {
      const d = distTo(S.lat, S.lon, S.home.lat, S.home.lon);
      if (d > 1.5) { targetBrg = bearingTo(S.lat, S.lon, S.home.lat, S.home.lon); desiredSpeed = CRUISE; }
      else { S.mode = MODES.HOLD; }
    }
  }
  // turn toward target bearing for autonomous modes
  if (targetBrg != null) {
    let diff = ((targetBrg - S.hdg + 540) % 360) - 180;
    const maxT = TURN_RATE * dt;
    S.hdg = (S.hdg + Math.max(-maxT, Math.min(maxT, diff)) + 360) % 360;
  }
  // speed approach
  S.speed += Math.max(-4 * dt, Math.min(4 * dt, desiredSpeed - S.speed));
  if (Math.abs(S.speed) < 0.02) S.speed = 0;
  // integrate position
  const dN = S.speed * Math.cos(S.hdg * D2R) * dt, dE = S.speed * Math.sin(S.hdg * D2R) * dt;
  S.lat += dN / 111320; S.lon += dE / (111320 * Math.cos(S.lat * D2R));
  // battery drain
  if (S.armed && S.speed > 0) { S.battV = Math.max(9.5, S.battV - 0.0008); S.battPct = Math.max(0, Math.round((S.battV - 9.5) / (12.6 - 9.5) * 100)); }
  // fence breach
  if (S.fence.enabled && S.armed) {
    let breach = 0;
    for (const poly of S.fence.inc) if (!pointInPoly(S.lat, S.lon, poly)) breach = 1;
    for (const poly of S.fence.exc) if (pointInPoly(S.lat, S.lon, poly)) breach = 1;
    if (breach && !S.fence.breach) { S.fence.breachCount++; statustext(4, 'Fence breach!'); }
    S.fence.breach = breach;
  } else S.fence.breach = 0;
}

// ---- telemetry senders ----
function heartbeat() {
  const h = new minimal.Heartbeat(); h.type = minimal.MavType.GROUND_ROVER; h.autopilot = minimal.MavAutopilot.ARDUPILOTMEGA;
  h.baseMode = minimal.MavModeFlag.CUSTOM_MODE_ENABLED | (S.armed ? minimal.MavModeFlag.SAFETY_ARMED : 0);
  h.customMode = S.mode; h.systemStatus = S.armed ? minimal.MavState.ACTIVE : minimal.MavState.STANDBY; h.mavlinkVersion = 3; tx(h);
}
function posInt() {
  const p = new common.GlobalPositionInt(); p.timeBootMs = tick * 100;
  p.lat = Math.round(S.lat * 1e7); p.lon = Math.round(S.lon * 1e7); p.alt = 50000; p.relativeAlt = 0;
  p.vx = Math.round(S.speed * Math.cos(S.hdg * D2R) * 100); p.vy = Math.round(S.speed * Math.sin(S.hdg * D2R) * 100); p.vz = 0;
  p.hdg = Math.round(S.hdg * 100); tx(p);
}
function gps() { const g = new common.GpsRawInt(); g.timeUsec = BigInt(tick) * 100000n; g.fixType = 6; g.lat = Math.round(S.lat * 1e7); g.lon = Math.round(S.lon * 1e7); g.alt = 50000; g.eph = 80; g.satellitesVisible = 14; tx(g); }
function sys() { const s = new common.SysStatus(); s.voltageBattery = Math.round(S.battV * 1000); s.currentBattery = S.armed && S.speed ? 800 : 50; s.batteryRemaining = S.battPct; s.onboardControlSensorsHealth = 0xFFFFFFFF; tx(s); }
function vfr() { const v = new common.VfrHud(); v.groundspeed = S.speed; v.airspeed = S.speed; v.heading = Math.round(S.hdg); v.throttle = Math.round(Math.abs(S.speed / MAX_SPEED) * 100); v.alt = 0; v.climb = 0; tx(v); }
function fenceStatus() { const f = new common.FenceStatus(); f.breachStatus = S.fence.breach; f.breachCount = S.fence.breachCount; f.breachType = S.fence.breach ? 1 : 0; f.breachTime = 0; tx(f); }
function homePos() { const h = new common.HomePosition(); h.latitude = Math.round(S.home.lat * 1e7); h.longitude = Math.round(S.home.lon * 1e7); h.altitude = 0; tx(h); }

setInterval(step, 100);
setInterval(heartbeat, 1000);
setInterval(posInt, 200);
setInterval(gps, 500);
setInterval(sys, 500);
setInterval(vfr, 200);
setInterval(fenceStatus, 1000);
setInterval(homePos, 3000);
heartbeat(); setTimeout(homePos, 800);

console.log(`Rover SIM -> ${BRIDGE_HOST}:${BRIDGE_PORT}  start @ ${S.lat.toFixed(5)},${S.lon.toFixed(5)}`);
console.log('Connect the GCS via UDP (listen ' + BRIDGE_PORT + '). Arm + AUTO to run a mission, or use the joystick panel.');
process.on('SIGINT', () => { sock.close(); process.exit(0); });
