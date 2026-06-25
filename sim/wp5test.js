'use strict';
/*
 * Reproduce the user's report against REAL ArduPilot Rover SITL:
 *   place 5 waypoints, upload, DOWNLOAD them back (verify count+coords), then run AUTO
 *   and watch how many waypoints are actually reached / when "mission complete" fires.
 * SITL must be running on UDP 14550 (./scripts/run-sitl.sh). Spawns its own bridge.
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
const NEm = (lat, dN, dE) => ({ lat: lat.lat + dN / 111320, lon: lat.lon + dE / (111320 * Math.cos(lat.lat * Math.PI / 180)) });

let ws;
const S = { hb: null, pos: null, reached: [], current: [], texts: [], up: null, list: null };
const send = (o) => ws.send(JSON.stringify(o));

async function run() {
  await until(() => S.hb && S.hb.modeName && S.pos, 12000);
  console.log('connected:', S.hb && S.hb.modeName, 'armed', S.hb && S.hb.armed, '@', S.pos.lat.toFixed(6), S.pos.lon.toFixed(6));
  const home = { lat: S.pos.lat, lon: S.pos.lon };

  // take control: HOLD + disarm so we start clean
  send({ t: 'mode', mode: 'HOLD' }); await delay(800);
  if (S.hb.armed) { send({ t: 'arm', arm: false }); await until(() => !S.hb.armed, 4000); }

  // 5 waypoints in an obvious staircase (each leg ~25 m) so the path is easy to judge
  const w1 = NEm(home, 25, 0);
  const w2 = NEm(w1, 0, 25);
  const w3 = NEm(w2, 25, 0);
  const w4 = NEm(w3, 0, -25);
  const w5 = NEm(w4, 25, 0);
  const wps = [w1, w2, w3, w4, w5].map((w) => ({ lat: w.lat, lon: w.lon, alt: 0 }));
  console.log('\nUPLOADING 5 waypoints:');
  wps.forEach((w, i) => console.log(`  wp${i + 1}: ${w.lat.toFixed(6)}, ${w.lon.toFixed(6)}`));

  S.up = null;
  send({ t: 'uploadMission', items: wps });
  const upOk = await until(() => S.up === true, 8000);
  console.log('upload ACCEPTED:', upOk);

  // DOWNLOAD back — the key diagnostic
  S.list = null;
  send({ t: 'downloadMission' });
  await until(() => S.list !== null, 8000);
  console.log('\nDOWNLOADED mission has', S.list ? S.list.length : 'NULL', 'waypoint(s) (excl. home):');
  if (S.list) S.list.forEach((w, i) => console.log(`  #${i + 1}: ${(+w.lat).toFixed(6)}, ${(+w.lon).toFixed(6)}  alt=${w.alt}`));

  // run AUTO and watch progress
  send({ t: 'setParam', id: 'ARMING_CHECK', value: 0 }); await delay(1200);
  send({ t: 'changeSpeed', speed: 6 });
  send({ t: 'arm', arm: true });
  await until(() => S.hb.armed, 6000);
  // ensure GUIDED-capable EKF then AUTO
  send({ t: 'startMission' });
  await until(() => S.hb.modeName === 'AUTO', 5000);
  console.log('\nAUTO started — watching for ~70 s ...');
  const t0 = Date.now();
  await until(() => /complete/i.test(S.texts.join(' ')) || S.hb.modeName === 'HOLD' && Date.now() - t0 > 3000, 70000);
  await delay(500);

  console.log('\n--- RESULT ---');
  console.log('waypoints placed         : 5');
  console.log('downloaded back          :', S.list ? S.list.length : 'NULL');
  console.log('MISSION_CURRENT seqs seen :', JSON.stringify(S.current));
  console.log('MISSION_ITEM_REACHED seqs :', JSON.stringify(S.reached));
  console.log('distinct waypoints reached:', new Set(S.reached.filter((s) => s >= 1)).size);
  console.log('final mode               :', S.hb.modeName, '@', S.pos.lat.toFixed(6), S.pos.lon.toFixed(6));
  console.log('statustext (tail)        :', S.texts.slice(-6).join(' | '));
  done(0);
}

setTimeout(() => {
  ws = new WebSocket('ws://localhost:' + WEB_PORT);
  ws.on('open', () => { send({ t: 'connect', transport: 'udp', listen: Number(UDP) }); setTimeout(run, 600); });
  ws.on('message', (d) => { let m; try { m = JSON.parse(d.toString()); } catch (_) { return; }
    if (m.t === 'hb') S.hb = m;
    else if (m.t === 'pos') S.pos = { lat: m.lat, lon: m.lon };
    else if (m.t === 'mission_reached') S.reached.push(m.seq);
    else if (m.t === 'mission_current') { if (S.current[S.current.length - 1] !== m.seq) S.current.push(m.seq); }
    else if (m.t === 'mission_uploaded') { if (!m.fence) S.up = m.ok; }
    else if (m.t === 'mission_list') S.list = m.items || m.wps || [];
    else if (m.t === 'text') S.texts.push(m.text || '');
  });
  ws.on('error', (e) => { console.log('ws error', e.message); done(1); });
}, 1800);
setTimeout(() => { console.log('TIMEOUT'); done(1); }, 110000);
