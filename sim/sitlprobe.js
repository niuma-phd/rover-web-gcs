'use strict';
// Quick probe: connect the bridge to the already-running SITL on UDP 14550,
// print the first telemetry the REAL ArduRover firmware sends back.
const WebSocket = require('ws');
const PORT = process.env.PORT || 8097;
const UDP = process.env.UDP || 14550;
const ws = new WebSocket('ws://localhost:' + PORT);
let hb = null, pos = null, gps = null, sys = null;
const texts = [];
ws.on('open', () => { ws.send(JSON.stringify({ t: 'connect', transport: 'udp', listen: Number(UDP) })); });
ws.on('message', (d) => {
  let m; try { m = JSON.parse(d.toString()); } catch (_) { return; }
  if (m.t === 'hb') hb = m;
  else if (m.t === 'pos') pos = m;
  else if (m.t === 'gps') gps = m;
  else if (m.t === 'sys') sys = m;
  else if (m.t === 'text' && texts.length < 6) texts.push(m.text || JSON.stringify(m));
});
ws.on('error', (e) => { console.log('WS error', e.message); process.exit(1); });
setTimeout(() => {
  console.log('--- REAL ArduRover SITL via the GCS bridge ---');
  console.log('heartbeat :', hb ? `mode=${hb.modeName} armed=${hb.armed} type=${hb.type} ap=${hb.ap}` : 'NONE');
  console.log('position  :', pos ? `${pos.lat.toFixed(6)}, ${pos.lon.toFixed(6)}  hdg=${pos.hdg}` : 'NONE');
  console.log('gps       :', gps ? `fix=${gps.fix} sats=${gps.sats}` : 'NONE');
  console.log('battery   :', sys ? `${(sys.volt!=null?sys.volt:'?')}V ${(sys.pct!=null?sys.pct:'?')}%` : 'NONE');
  if (texts.length) console.log('statustext:', texts.join(' | '));
  const ok = hb && pos && hb.modeName;
  console.log(ok ? '\nPROBE OK: real firmware telemetry decoded through the bridge.' : '\nPROBE FAIL.');
  ws.close(); process.exit(ok ? 0 : 1);
}, 9000);
