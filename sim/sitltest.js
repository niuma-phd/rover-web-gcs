'use strict';
/*
 * End-to-end drive test against REAL ArduPilot Rover SITL (must already be running and
 * forwarding MAVLink to UDP 14550 — e.g. via ../run-sitl.sh). Spawns the GCS bridge,
 * connects a browser-style WS client, then ARMs, drives a GUIDED goto, runs an AUTO
 * mission, and RTLs — verifying the real firmware actually moves and reacts.
 *
 *   Terminal A:  ./run-sitl.sh            (start SITL on 14550)
 *   Terminal B:  node sim/sitltest.js     (this test)
 */
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const WEB_PORT = process.env.PORT || 8098, UDP = process.env.UDP || 14550;
const results = [];
const pass = (n) => { results.push([1, n]); console.log('  ✓ ' + n); };
const fail = (n) => { results.push([0, n]); console.log('  ✗ ' + n); };
const log = (n) => console.log('    · ' + n);

const bridge = spawn(process.execPath, [path.join(__dirname, '..', 'bridge', 'server.js')],
  { env: { ...process.env, PORT: String(WEB_PORT) }, stdio: ['ignore', 'ignore', 'inherit'] });
function done(code) { try { bridge.kill('SIGINT'); } catch (_) {} setTimeout(() => process.exit(code), 200); }

function distM(a, b) { const n = (a.lat - b.lat) * 111320, e = (a.lon - b.lon) * 111320 * Math.cos(a.lat * Math.PI / 180); return Math.hypot(n, e); }
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let ws;
const state = { hb: null, pos: null, gps: null, texts: [], reached: 0, curSeq: null, missionUp: null };
function send(o) { ws.send(JSON.stringify(o)); }
// wait until predicate(state) truthy or timeout
function until(pred, ms, label) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (pred(state)) { clearInterval(iv); resolve(true); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); resolve(false); }
    }, 100);
  });
}

async function run() {
  // 1. heartbeat + position from the real firmware
  const gotHb = await until((s) => s.hb && s.hb.modeName && s.pos, 12000);
  if (gotHb) pass(`real heartbeat+position (mode=${state.hb.modeName}, ${state.pos.lat.toFixed(6)},${state.pos.lon.toFixed(6)}, sats=${state.gps ? state.gps.sats : '?'})`);
  else { fail('no heartbeat/position from SITL'); return finish(); }
  const home = { lat: state.pos.lat, lon: state.pos.lon };

  // 2. wait for a 3D GPS fix + give the EKF time to converge (a mode change to GUIDED
  //    is rejected until the position estimate is healthy)
  const fix = await until((s) => s.gps && s.gps.fixType >= 3, 30000);
  log('GPS fix=' + (state.gps && state.gps.fixType) + ' sats=' + (state.gps && state.gps.sats));
  await delay(3000);

  // relax arming checks for the demo, then ARM
  send({ t: 'setParam', id: 'ARMING_CHECK', value: 0 });
  await delay(1500);
  send({ t: 'arm', arm: true });
  const armed = await until((s) => s.hb && s.hb.armed, 8000);
  if (armed) pass('vehicle ARMED (COMPONENT_ARM_DISARM accepted by real firmware)');
  else { fail('arm failed: ' + state.texts.slice(-3).join(' | ')); }

  // 3. enter GUIDED — retry while the EKF finishes converging (early mode changes get
  //    "Flight mode change failed" until the position/yaw estimate is healthy)
  send({ t: 'changeSpeed', speed: 5 });
  let guided = false;
  for (let i = 0; i < 15 && !guided; i++) {
    send({ t: 'mode', mode: 'GUIDED' });
    guided = await until((s) => s.hb && s.hb.modeName === 'GUIDED', 2000);
  }
  if (guided) pass('mode GUIDED engaged (real firmware)'); else fail('could not enter GUIDED: ' + state.texts.slice(-3).join(' | '));

  // 4. GUIDED goto ~40 m north
  const target = { lat: home.lat + 0.00036, lon: home.lon }; // ~40 m north
  const beforeGoto = { ...state.pos };
  send({ t: 'goto', lat: target.lat, lon: target.lon });
  await until((s) => distM(s.pos, beforeGoto) > 8, 20000);
  const gotoMoved = distM(state.pos, beforeGoto);
  if (gotoMoved > 8) pass(`GUIDED goto DROVE the rover ${Math.round(gotoMoved)} m (toward target, now ${distM(state.pos, target).toFixed(1)} m away)`);
  else fail(`GUIDED goto barely moved (${gotoMoved.toFixed(1)} m). texts: ${state.texts.slice(-3).join(' | ')}`);

  // 4. AUTO mission: two waypoints, then start
  state.missionUp = null; state.reached = 0;
  const wpA = { lat: home.lat + 0.0006, lon: home.lon, alt: 0 };
  const wpB = { lat: home.lat + 0.0006, lon: home.lon + 0.0005, alt: 0 };
  send({ t: 'uploadMission', items: [wpA, wpB] });
  const upOk = await until((s) => s.missionUp === true, 8000);
  if (upOk) pass('mission upload ACCEPTED by real firmware (full MISSION handshake)');
  else fail('mission upload failed/timeout');
  send({ t: 'startMission' });               // MISSION_START + AUTO
  await until((s) => s.hb && s.hb.modeName === 'AUTO', 4000);
  const progressed = await until((s) => s.reached >= 1 || (s.curSeq != null && s.curSeq >= 1), 20000);
  if (progressed) pass(`AUTO mission running (mode=${state.hb.modeName}, reached=${state.reached}, curSeq=${state.curSeq})`);
  else fail(`no mission progress (mode=${state.hb && state.hb.modeName}, reached=${state.reached}, curSeq=${state.curSeq})`);

  // 5. RTL back toward home
  const beforeRtl = { ...state.pos };
  const awayBefore = distM(beforeRtl, home);
  send({ t: 'mode', mode: 'RTL' });
  await until((s) => s.hb && s.hb.modeName === 'RTL', 4000);
  await until((s) => distM(s.pos, home) < awayBefore - 5, 20000);
  const awayAfter = distM(state.pos, home);
  if (awayAfter < awayBefore - 5) pass(`RTL returning home (was ${Math.round(awayBefore)} m out, now ${Math.round(awayAfter)} m)`);
  else fail(`RTL did not close distance (was ${Math.round(awayBefore)} m, now ${Math.round(awayAfter)} m)`);

  // 6. disarm
  send({ t: 'mode', mode: 'HOLD' }); await delay(500);
  send({ t: 'arm', arm: false });
  const disarmed = await until((s) => s.hb && !s.hb.armed, 6000);
  if (disarmed) pass('vehicle DISARMED'); else fail('disarm failed');

  finish();
}

function finish() {
  const failed = results.filter((r) => !r[0]).length;
  console.log('\n  ' + (results.length - failed) + '/' + results.length + ' checks passed (against REAL ArduPilot Rover SITL).');
  done(failed ? 1 : 0);
}

setTimeout(() => {
  ws = new WebSocket('ws://localhost:' + WEB_PORT);
  ws.on('open', () => { send({ t: 'connect', transport: 'udp', listen: Number(UDP) }); setTimeout(run, 500); });
  ws.on('message', (d) => {
    let m; try { m = JSON.parse(d.toString()); } catch (_) { return; }
    if (m.t === 'hb') state.hb = m;
    else if (m.t === 'pos') state.pos = { lat: m.lat, lon: m.lon };
    else if (m.t === 'gps') state.gps = m;
    else if (m.t === 'mission_reached') state.reached++;
    else if (m.t === 'mission_current') state.curSeq = m.seq;
    else if (m.t === 'mission_uploaded') state.missionUp = !m.fence ? m.ok : state.missionUp;
    else if (m.t === 'text') { state.texts.push(m.text || ''); }
  });
  ws.on('error', (e) => { fail('ws error: ' + e.message); done(1); });
}, 900);

setTimeout(() => { fail('global timeout'); finish(); }, 120000);
