'use strict';
/*
 * rtcm-test.js — end-to-end test for the NTRIP -> north RTCM relay (no hardware).
 *
 * Stands up two fake TCP peers on ephemeral ports:
 *   (a) fake NORTH bridge  — accepts JSON-lines, collects {t:'RTCM'} frames, and
 *       after the first one sends a {t:'RTCM_GGA', gga:'$GNGGA,fake*00'} line back.
 *   (b) fake NTRIP caster  — on the GET, replies "ICY 200 OK\r\n\r\n" then writes
 *       known RTCM bytes; records any GGA lines the client feeds back.
 *
 * Then wires NtripClient + NorthClient + RtcmRelay to the fakes and asserts:
 *   - the caster bytes arrive at the bridge as base64 RTCM frames that
 *     base64-decode back to EXACTLY the original bytes (chunking + round-trip),
 *   - every relayed frame's decoded size respects the <=16384 chunk margin,
 *   - the bridge's RTCM_GGA reaches the caster as a GGA line (VRS feedback),
 *   - the relay's request is a well-formed NTRIP/2.0 handshake.
 */
const net = require('net');
const { NorthClient } = require('./north-client');
const { NtripClient } = require('./ntrip-client');
const { RtcmRelay } = require('./rtcm-relay');

const results = [];
const pass = (n) => { results.push([true, n]); console.log('  ✓ ' + n); };
const fail = (n) => { results.push([false, n]); console.log('  ✗ ' + n); };

// Deterministic "known" RTCM3 payload, larger than one chunk (16384) so the relay
// MUST split it into multiple frames and the bridge MUST reassemble them in order.
const KNOWN = Buffer.alloc(40000);
for (let i = 0; i < KNOWN.length; i++) KNOWN[i] = (i * 37 + 11) & 0xFF;
const GGA = '$GNGGA,fake*00';
const CRED_USER = 'testuser';
const CRED_PASS = 'testpass';

let relay = null;
let northSrv = null;
let casterSrv = null;
let doneCalled = false;
function done(code) {
  if (doneCalled) return; doneCalled = true;
  try { relay && relay.stop(); } catch (_) {}
  try { northSrv && northSrv.close(); } catch (_) {}
  try { casterSrv && casterSrv.close(); } catch (_) {}
  setTimeout(() => process.exit(code), 150);
}

// ---- (a) fake NORTH bridge: JSON-lines in, collect RTCM, answer RTCM_GGA once ----
const rxFrames = [];        // decoded RTCM Buffers, in arrival order
let ggaSentDown = false;
northSrv = net.createServer((sock) => {
  sock.on('error', () => {});
  let buf = '';
  sock.on('data', (d) => {
    buf += d.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let obj; try { obj = JSON.parse(line); } catch (_) { continue; }
      if (obj && obj.t === 'RTCM' && typeof obj.data === 'string') {
        rxFrames.push(Buffer.from(obj.data, 'base64'));
        if (!ggaSentDown) {                 // answer with one RTCM_GGA after the first RTCM frame
          ggaSentDown = true;
          try { sock.write(JSON.stringify({ v: 1, t: 'RTCM_GGA', seq: 0, ts: Date.now(), gga: GGA }) + '\n'); } catch (_) {}
        }
      }
    }
  });
});

// ---- (b) fake NTRIP caster: reply to GET, stream KNOWN, record fed-back GGA ----
let casterReq = '';
let casterGga = '';
casterSrv = net.createServer((sock) => {
  sock.on('error', () => {});
  let responded = false;
  sock.on('data', (d) => {
    if (!responded) {
      casterReq += d.toString('latin1');
      if (casterReq.indexOf('\r\n\r\n') !== -1) {   // full GET received
        responded = true;
        try { sock.write('ICY 200 OK\r\n\r\n'); sock.write(KNOWN); } catch (_) {}
      }
    } else {
      casterGga += d.toString('latin1');            // subsequent bytes = fed-back GGA
    }
  });
});

// ---- wire everything once both fakes are listening on their ephemeral ports ----
let northPort = 0, casterPort = 0;
function maybeStart() {
  if (!northPort || !casterPort) return;
  relay = new RtcmRelay({
    northHost: '127.0.0.1', northPort,
    ntripHost: '127.0.0.1', ntripPort: casterPort,
    mountpoint: 'TEST', username: CRED_USER, password: CRED_PASS,
  });
  relay.on('ntrip-error', (e) => fail('unexpected ntrip error: ' + (e && e.message)));
  relay.start();
  setTimeout(evaluate, 1500);
}
northSrv.on('error', (e) => { fail('north server error: ' + e.message); done(1); });
casterSrv.on('error', (e) => { fail('caster server error: ' + e.message); done(1); });
northSrv.listen(0, '127.0.0.1', () => { northPort = northSrv.address().port; maybeStart(); });
casterSrv.listen(0, '127.0.0.1', () => { casterPort = casterSrv.address().port; maybeStart(); });

function evaluate() {
  const st = relay.getStatus();

  // connections established
  if (st.northUp) pass('north client connected to fake bridge'); else fail('north client not connected');
  if (st.ntripUp) pass('ntrip client handshaked with fake caster'); else fail('ntrip client not connected');

  // request well-formed (NTRIP/2.0 handshake)
  const expAuth = 'Authorization: Basic ' + Buffer.from(CRED_USER + ':' + CRED_PASS).toString('base64');
  if (casterReq.indexOf('GET /TEST HTTP/1.1') !== -1 &&
      casterReq.indexOf('Ntrip-Version: Ntrip/2.0') !== -1 &&
      casterReq.indexOf(expAuth) !== -1) pass('NTRIP GET request well-formed (mountpoint + Ntrip/2.0 + Basic auth)');
  else fail('NTRIP request malformed:\n' + casterReq);

  // RTCM round-trip: reassembled base64-decoded frames == original bytes
  const got = Buffer.concat(rxFrames);
  if (rxFrames.length >= 1 && got.length === KNOWN.length && got.equals(KNOWN))
    pass('RTCM round-trip: ' + rxFrames.length + ' frame(s), ' + got.length + ' bytes decode back to original');
  else fail('RTCM round-trip mismatch: got ' + got.length + '/' + KNOWN.length + ' bytes in ' + rxFrames.length + ' frames');

  // chunk margin: every decoded frame <= 16384 bytes
  const tooBig = rxFrames.filter((f) => f.length > 16384);
  if (rxFrames.length && !tooBig.length) pass('every RTCM frame decoded <=16384 bytes (safe chunk margin)');
  else fail('a frame exceeded the 16384 chunk margin (' + tooBig.length + ' oversized)');

  // status byte accounting
  if (st.bytesRelayed === KNOWN.length) pass('relay bytesRelayed=' + st.bytesRelayed + ' matches source');
  else fail('relay bytesRelayed=' + st.bytesRelayed + ' != ' + KNOWN.length);

  // GGA / VRS feedback reached the caster
  if (casterGga.indexOf(GGA) !== -1) pass('RTCM_GGA relayed up to caster as GGA line (VRS feedback)');
  else fail('caster did not receive fed-back GGA (got: ' + JSON.stringify(casterGga) + ')');

  const failed = results.filter((r) => !r[0]).length;
  console.log('\n  ' + (results.length - failed) + '/' + results.length + ' checks passed.');
  done(failed ? 1 : 0);
}

setTimeout(() => { fail('global timeout'); done(1); }, 6000);
