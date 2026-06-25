'use strict';
/*
 * Verify the mission (re)start fix against REAL ArduPilot Rover SITL.
 * Reproduces the user's exact failure: run a mission to completion, then upload a
 * DIFFERENT mission and start it — which previously left the rover stuck in AUTO with
 * throttle 0 ("Mission is stale"). With the fix (startMission = HOLD->reset->AUTO->START)
 * the rover must drive BOTH missions.
 * SITL must be running on UDP 14550. Spawns its own bridge (new code).
 */
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');
const WEB_PORT = process.env.PORT || 8099, UDP = process.env.UDP || 14550;
const bridge = spawn(process.execPath, [path.join(__dirname, '..', 'bridge', 'server.js')],
  { env: { ...process.env, PORT: String(WEB_PORT) }, stdio: ['ignore', 'ignore', 'inherit'] });
function done(code) { try { bridge.kill('SIGINT'); } catch (_) {} setTimeout(() => process.exit(code), 200); }
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function until(pred, ms) { return new Promise((res) => { const t0 = Date.now(); const iv = setInterval(() => { if (pred()) { clearInterval(iv); res(true); } else if (Date.now() - t0 > ms) { clearInterval(iv); res(false); } }, 100); }); }
const NEm = (o, dN, dE) => ({ lat: o.lat + dN / 111320, lon: o.lon + dE / (111320 * Math.cos(o.lat * Math.PI / 180)) });
const results = []; const pass = (n) => { results.push([1, n]); console.log('  ✓ ' + n); }; const fail = (n) => { results.push([0, n]); console.log('  ✗ ' + n); };

let ws; const S = { hb: null, pos: null, reached: [], up: null, list: null, texts: [] };
const send = (o) => ws.send(JSON.stringify(o));

async function uploadAndRun(label, wps, expectReach) {
  S.up = null; send({ t: 'uploadMission', items: wps });
  await until(() => S.up === true, 8000);
  const before = { ...S.pos };
  S.reached = [];
  send({ t: 'startMission' });                          // <-- the function under test
  // give the mode-cycle time, then watch for movement + reaches
  const drove = await until(() => {
    const d = Math.hypot((S.pos.lat - before.lat) * 111320, (S.pos.lon - before.lon) * 111320 * Math.cos(before.lat * Math.PI / 180));
    return d > 6 || new Set(S.reached.filter((s) => s >= 1)).size >= expectReach;
  }, 40000);
  const moved = Math.round(Math.hypot((S.pos.lat - before.lat) * 111320, (S.pos.lon - before.lon) * 111320 * Math.cos(before.lat * Math.PI / 180)));
  const reached = new Set(S.reached.filter((s) => s >= 1)).size;
  if (drove && moved > 6) pass(`${label}: rover RESTARTED & drove (moved ${moved} m, reached ${reached}, mode ${S.hb.modeName})`);
  else fail(`${label}: rover did NOT move (moved ${moved} m, reached ${reached}, mode ${S.hb.modeName}, thr stuck)`);
  return until(() => /complete/i.test(S.texts.join(' ')), 30000); // let it finish this mission
}

async function run() {
  await until(() => S.hb && S.hb.modeName && S.pos, 12000);
  const home = { lat: S.pos.lat, lon: S.pos.lon };
  console.log('connected @', home.lat.toFixed(6), home.lon.toFixed(6), 'mode', S.hb.modeName);
  send({ t: 'mode', mode: 'HOLD' }); await delay(700);
  if (S.hb.armed) { send({ t: 'arm', arm: false }); await until(() => !S.hb.armed, 4000); }
  send({ t: 'setParam', id: 'ARMING_CHECK', value: 0 }); await delay(1200);
  send({ t: 'changeSpeed', speed: 5 });
  send({ t: 'arm', arm: true }); await until(() => S.hb.armed, 6000);

  // MISSION A: short staircase to the north-east
  const a1 = NEm(home, 20, 0), a2 = NEm(a1, 0, 20), a3 = NEm(a2, 20, 0);
  console.log('\n[Mission A] 3 waypoints — run to completion:');
  await uploadAndRun('Mission A', [a1, a2, a3].map((w) => ({ lat: w.lat, lon: w.lon, alt: 0 })), 2);
  await delay(1500);
  console.log('  (Mission A complete:', /complete/i.test(S.texts.slice(-8).join(' ')), ')');

  // MISSION B: a DIFFERENT mission, uploaded AFTER A completed, then started — the user's case
  const here = { ...S.pos };
  const b1 = NEm(here, 25, 0), b2 = NEm(b1, 0, -25), b3 = NEm(b2, 25, 0);
  console.log('\n[Mission B] upload a NEW mission after A completed, then start (the reported bug):');
  await uploadAndRun('Mission B', [b1, b2, b3].map((w) => ({ lat: w.lat, lon: w.lon, alt: 0 })), 1);

  console.log('\n--- ' + results.filter((r) => r[0]).length + '/' + results.length + ' passed ---');
  send({ t: 'mode', mode: 'HOLD' }); await delay(400); send({ t: 'arm', arm: false }); await delay(400);
  done(results.some((r) => !r[0]) ? 1 : 0);
}

setTimeout(() => {
  ws = new WebSocket('ws://localhost:' + WEB_PORT);
  ws.on('open', () => { send({ t: 'connect', transport: 'udp', listen: Number(UDP) }); setTimeout(run, 700); });
  ws.on('message', (d) => { let m; try { m = JSON.parse(d.toString()); } catch (_) { return; }
    if (m.t === 'hb') S.hb = m; else if (m.t === 'pos') S.pos = { lat: m.lat, lon: m.lon };
    else if (m.t === 'mission_reached') S.reached.push(m.seq);
    else if (m.t === 'mission_uploaded') { if (!m.fence) S.up = m.ok; }
    else if (m.t === 'mission_list') S.list = m.items || [];
    else if (m.t === 'text') S.texts.push(m.text || ''); });
  ws.on('error', (e) => { console.log('ws error', e.message); done(1); });
}, 1800);
setTimeout(() => { console.log('TIMEOUT'); done(1); }, 150000);
