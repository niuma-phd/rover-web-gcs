'use strict';
/*
 * End-to-end integration test (no real hardware).
 * Spawns the bridge, connects a WebSocket browser-client AND a fake ArduPilot
 * Rover over UDP, then verifies: telemetry decode -> WS, command encode, and the
 * full mission-upload handshake.
 */
const { spawn } = require('child_process');
const dgram = require('dgram');
const path = require('path');
const { Writable } = require('stream');
const WebSocket = require('ws');
const {
  minimal, common, MavLinkProtocolV2, MavLinkPacketSplitter, MavLinkPacketParser, send,
} = require('node-mavlink');

const WEB_PORT = 8092;
const UDP_PORT = 14557;
const results = [];
const pass = (n) => { results.push([true, n]); console.log('  ✓ ' + n); };
const fail = (n) => { results.push([false, n]); console.log('  ✗ ' + n); };

const server = spawn(process.execPath, [path.join(__dirname, 'server.js')],
  { env: { ...process.env, PORT: String(WEB_PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', (d) => process.stdout.write('  [bridge] ' + d));
server.stderr.on('data', (d) => process.stderr.write('  [bridge:err] ' + d));

function done(code) { try { server.kill('SIGINT'); } catch (_) {} setTimeout(() => process.exit(code), 150); }

// ---- fake vehicle (sysid 1) over UDP ----
const veh = dgram.createSocket('udp4');
const VP = new MavLinkProtocolV2(); VP.sysid = 1; VP.compid = 1;
const vehOut = new Writable({ write(c, _e, cb) { veh.send(c, WEB_PORT_BRIDGE_UDP(), '127.0.0.1', () => cb()); } });
function WEB_PORT_BRIDGE_UDP() { return UDP_PORT; }
function vsend(msg) { send(vehOut, msg, VP); }

const vsplit = new MavLinkPacketSplitter(); const vparse = new MavLinkPacketParser(); vsplit.pipe(vparse);
veh.on('message', (b) => vsplit.write(b));
const got = { armCmd: false, setModeAuto: false, missionCount: 0, items: {} };
vparse.on('data', (pk) => {
  const id = pk.header.msgid;
  if (id === common.CommandLong.MSG_ID) {
    const m = pk.protocol.data(pk.payload, common.CommandLong);
    if (m.command === common.MavCmd.COMPONENT_ARM_DISARM && m._param1 === 1) { got.armCmd = true; pass('vehicle received ARM (COMMAND_LONG 400, _param1=1)'); }
  } else if (id === common.SetMode.MSG_ID) {
    const m = pk.protocol.data(pk.payload, common.SetMode);
    if (m.customMode === 10) { got.setModeAuto = true; pass('vehicle received SET_MODE customMode=10 (AUTO)'); }
  } else if (id === common.MissionCount.MSG_ID) {
    const m = pk.protocol.data(pk.payload, common.MissionCount);
    got.missionCount = m.count;
    pass('vehicle received MISSION_COUNT count=' + m.count);
    reqItem(0); // ask for first item
  } else if (id === common.MissionItemInt.MSG_ID) {
    const m = pk.protocol.data(pk.payload, common.MissionItemInt);
    got.items[m.seq] = m;
    if (m.seq + 1 < got.missionCount) reqItem(m.seq + 1);
    else { // all received -> ACK accepted
      const ack = new common.MissionAck(); ack.targetSystem = 255; ack.targetComponent = 190; ack.type = 0; ack.missionType = 0;
      vsend(ack);
      pass('vehicle received all ' + Object.keys(got.items).length + ' MISSION_ITEM_INT, sent ACK');
    }
  }
});
function reqItem(seq) { const r = new common.MissionRequestInt(); r.targetSystem = 255; r.targetComponent = 190; r.seq = seq; r.missionType = 0; vsend(r); }

function vehHeartbeat() {
  const hb = new minimal.Heartbeat();
  hb.type = minimal.MavType.GROUND_ROVER; hb.autopilot = minimal.MavAutopilot.ARDUPILOTMEGA;
  hb.baseMode = minimal.MavModeFlag.CUSTOM_MODE_ENABLED; hb.customMode = 4; // HOLD
  hb.systemStatus = minimal.MavState.STANDBY; hb.mavlinkVersion = 3;
  vsend(hb);
}
function vehPos() {
  const p = new common.GlobalPositionInt();
  p.timeBootMs = 1000; p.lat = Math.round(22.5 * 1e7); p.lon = Math.round(113.9 * 1e7);
  p.alt = 50000; p.relativeAlt = 0; p.vx = 100; p.vy = 0; p.vz = 0; p.hdg = 9000; // 90 deg, 1 m/s
  vsend(p);
}

// ---- browser-side WS client ----
const wsMsgs = [];
let ws;
function startClient() {
  ws = new WebSocket('ws://localhost:' + WEB_PORT);
  ws.on('open', () => {
    ws.send(JSON.stringify({ t: 'connect', transport: 'udp', listen: UDP_PORT }));
    setTimeout(() => { vehHeartbeat(); vehPos(); }, 400);     // vehicle starts talking
    setTimeout(() => { ws.send(JSON.stringify({ t: 'arm', arm: true })); }, 900);
    setTimeout(() => { ws.send(JSON.stringify({ t: 'mode', mode: 'AUTO' })); }, 1100);
    setTimeout(() => { ws.send(JSON.stringify({ t: 'uploadMission', items: [{ lat: 22.61, lon: 113.91, alt: 0 }] })); }, 1400);
    setTimeout(evaluate, 3200);
  });
  ws.on('message', (d) => { try { wsMsgs.push(JSON.parse(d.toString())); } catch (_) {} });
  ws.on('error', (e) => { fail('ws error: ' + e.message); done(1); });
}

function evaluate() {
  const hb = wsMsgs.find((m) => m.t === 'hb');
  if (hb && hb.modeName === 'HOLD' && hb.armed === false) pass('WS got hb: mode=HOLD armed=false (rover decoded)');
  else fail('WS hb missing/wrong: ' + JSON.stringify(hb));

  const pos = wsMsgs.find((m) => m.t === 'pos');
  if (pos && Math.abs(pos.lat - 22.5) < 1e-4 && Math.abs(pos.lon - 113.9) < 1e-4) pass('WS got pos: lat/lon correct (' + pos.lat.toFixed(4) + ',' + pos.lon.toFixed(4) + ')');
  else fail('WS pos missing/wrong: ' + JSON.stringify(pos));

  if (!got.armCmd) fail('vehicle did NOT receive ARM command');
  if (!got.setModeAuto) fail('vehicle did NOT receive SET_MODE AUTO');

  const up = wsMsgs.find((m) => m.t === 'mission_uploaded');
  if (up && up.ok) pass('WS got mission_uploaded ok=true (full upload handshake)');
  else fail('mission upload did not complete: ' + JSON.stringify(up));

  // mission item geometry check
  const it1 = got.items[1];
  if (it1 && Math.abs(it1.x / 1e7 - 22.61) < 1e-4 && it1.command === common.MavCmd.NAV_WAYPOINT) pass('uploaded waypoint #1 geometry + NAV_WAYPOINT correct');
  else fail('uploaded waypoint geometry wrong: ' + JSON.stringify(it1 && { x: it1.x, y: it1.y, cmd: it1.command }));

  const failed = results.filter((r) => !r[0]).length;
  console.log('\n  ' + (results.length - failed) + '/' + results.length + ' checks passed.');
  done(failed ? 1 : 0);
}

veh.bind(0, () => { setTimeout(startClient, 500); }); // give bridge time to listen
setTimeout(() => { fail('global timeout'); done(1); }, 8000);
