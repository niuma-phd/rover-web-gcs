'use strict';
/*
 * Full simulation scenario test: spawns the rover SIM + the bridge, connects a
 * browser-style WS client, then drives a mission, a geofence breach, and manual
 * RC control — verifying the rover actually moves and reacts end-to-end.
 */
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const WEB_PORT = 8096, UDP_PORT = 14559;
const results = [];
const pass = (n) => { results.push([1, n]); console.log('  ✓ ' + n); };
const fail = (n) => { results.push([0, n]); console.log('  ✗ ' + n); };

const bridge = spawn(process.execPath, [path.join(__dirname, '..', 'bridge', 'server.js')],
  { env: { ...process.env, PORT: String(WEB_PORT) }, stdio: ['ignore', 'ignore', 'inherit'] });
let sim = null;
function startSim() {
  sim = spawn(process.execPath, [path.join(__dirname, 'rover-sim.js')],
    { env: { ...process.env, BRIDGE_PORT: String(UDP_PORT), SIM_LAT: '22.5900', SIM_LON: '113.9500' }, stdio: ['ignore', 'ignore', 'inherit'] });
}
function done(code) { [bridge, sim].forEach((p) => { try { p && p.kill('SIGINT'); } catch (_) {} }); setTimeout(() => process.exit(code), 200); }

function dist(a, b) { const n = (a.lat - b.lat) * 111320, e = (a.lon - b.lon) * 111320 * Math.cos(a.lat * Math.PI / 180); return Math.hypot(n, e); }

let ws = null;
const msgs = []; let lastPos = null, startPos = null, rcStartPos = null;
let reached = 0, fenceUp = false, missionUp = false, breachSeen = false;

setTimeout(() => { ws = new WebSocket('ws://localhost:' + WEB_PORT); wireWs(); }, 800); // wait for bridge http
function wireWs() {
ws.on('message', (d) => {
  let m; try { m = JSON.parse(d.toString()); } catch (_) { return; }
  msgs.push(m);
  if (m.t === 'pos') { lastPos = { lat: m.lat, lon: m.lon }; if (!startPos) startPos = lastPos; }
  if (m.t === 'mission_reached') reached++;
  if (m.t === 'mission_uploaded') { if (m.fence) fenceUp = m.ok; else missionUp = m.ok; }
  if (m.t === 'fence_status' && m.breach) breachSeen = true;
});

ws.on('open', () => {
  ws.send(JSON.stringify({ t: 'connect', transport: 'udp', listen: UDP_PORT }));
  setTimeout(startSim, 300);                                   // sim starts talking to bridge
  setTimeout(() => ws.send(JSON.stringify({ t: 'arm', arm: true })), 1500);
  // geofence: small inclusion box around start (~11 m); rover will leave it -> breach
  setTimeout(() => {
    const c = { lat: 22.5900, lon: 113.9500 }, d = 0.0001;
    ws.send(JSON.stringify({ t: 'uploadFence', items: [{ kind: 'inc', polygon: [
      [c.lat - d, c.lon - d], [c.lat - d, c.lon + d], [c.lat + d, c.lon + d], [c.lat + d, c.lon - d]] }] }));
  }, 1800);
  setTimeout(() => ws.send(JSON.stringify({ t: 'fenceEnable', on: true })), 2300);
  // mission: two nearby waypoints due north (~22 m, ~44 m) so they are reached quickly
  setTimeout(() => ws.send(JSON.stringify({ t: 'uploadMission', items: [
    { lat: 22.5902, lon: 113.9500, alt: 0 }, { lat: 22.5904, lon: 113.9500, alt: 0 }] })), 2700);
  setTimeout(() => ws.send(JSON.stringify({ t: 'startMission' })), 3300);
  // evaluate mission/fence, then run RC manual phase
  setTimeout(() => { rcStartPos = lastPos; ws.send(JSON.stringify({ t: 'mode', mode: 'MANUAL' })); }, 12000);
  let rc = null;
  setTimeout(() => { rc = setInterval(() => ws.send(JSON.stringify({ t: 'rc', steer: 0, throttle: 1 })), 100); }, 12200);
  setTimeout(() => { clearInterval(rc); ws.send(JSON.stringify({ t: 'rcRelease' })); }, 14000);
  setTimeout(evaluate, 14600);
});
ws.on('error', (e) => { fail('ws error: ' + e.message); done(1); });
}

function evaluate() {
  const hb = msgs.find((m) => m.t === 'hb');
  if (hb && hb.modeName) pass('telemetry: heartbeat decoded (mode ' + hb.modeName + ')'); else fail('no heartbeat');
  if (startPos && lastPos) pass('telemetry: position stream (' + startPos.lat.toFixed(5) + ' -> ' + lastPos.lat.toFixed(5) + ')'); else fail('no position');
  if (missionUp) pass('mission upload ACCEPTED'); else fail('mission upload failed');
  if (fenceUp) pass('fence upload ACCEPTED'); else fail('fence upload failed');
  if (startPos && lastPos && (lastPos.lat - startPos.lat) > 0.0002) pass('rover DROVE the mission north (Δ' + Math.round((lastPos.lat - startPos.lat) * 111320) + ' m)');
  else fail('rover did not move north enough: ' + JSON.stringify({ start: startPos, last: lastPos }));
  if (reached >= 1) pass('mission progress: ' + reached + ' waypoint(s) reached'); else fail('no MISSION_ITEM_REACHED');
  if (breachSeen) pass('geofence breach detected (rover left inclusion zone)'); else fail('no fence breach seen');
  if (rcStartPos && lastPos && dist(rcStartPos, lastPos) > 2) pass('manual RC control moved the rover (Δ' + Math.round(dist(rcStartPos, lastPos)) + ' m)');
  else fail('RC manual control did not move rover: ' + JSON.stringify({ rcStart: rcStartPos, last: lastPos }));

  const failed = results.filter((r) => !r[0]).length;
  console.log('\n  ' + (results.length - failed) + '/' + results.length + ' checks passed.');
  done(failed ? 1 : 0);
}
setTimeout(() => { fail('global timeout'); done(1); }, 18000);
