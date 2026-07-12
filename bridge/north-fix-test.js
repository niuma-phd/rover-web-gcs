'use strict';
/*
 * north-fix-test.js — 针对性回归：对抗评审确认的两处北向缺陷修复验证（无硬件、无 server.js/WS）。
 *   1. north-client.js: 车端 {t:'error'} 上行帧**不得击穿进程**（Node EventEmitter 的 'error'
 *      是保留事件，无监听者时 emit('error') 同步抛出 → 连带 live demo 一起崩）。
 *   2. north-backend.js: 2Hz HB 须门控在"操作员在场"(hasClients)——不在场时**不喂**车端看门狗，
 *      否则机器 HB 流掩盖 COMMS_LOST 失联失效保护（与 RTCM 机器流同类，契约 §2.8/§2.9）。
 * 直接对 NorthClient/NorthBackend 打伪 TCP 车端，ephemeral 端口，进程退出码即测试结果。
 */
const net = require('net');
const { NorthClient } = require('./north-client');
const { NorthBackend } = require('./north-backend');

const results = [];
const pass = (n) => { results.push([true, n]); console.log('  ✓ ' + n); };
const fail = (n) => { results.push([false, n]); console.log('  ✗ ' + n); };

let doneCalled = false;
const servers = [];
function finish(code) {
  if (doneCalled) return; doneCalled = true;
  for (const s of servers) { try { s.close(); } catch (_) {} }
  setTimeout(() => process.exit(code), 100);
}

// ---- Test 1: {t:'error'} 帧被忽略、不 crash ----
function test1() {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      sock.on('error', () => {});
      sock.write('{"v":1,"t":"error","code":"boom","text":"hostile"}\n');           // 恶意保留事件名
      sock.write('{"v":1,"t":"POSE","seq":1,"ts":1,"lat":22.5,"lon":113.9,"yaw":0,"spd":0}\n');
    });
    servers.push(srv);
    srv.listen(0, '127.0.0.1', () => {
      const c = new NorthClient('127.0.0.1', srv.address().port);
      let gotPose = false;
      c.on('frame', (f) => { if (f && f.t === 'POSE') gotPose = true; });  // 只挂 frame（不挂 'error'）= 复现崩溃接线
      c.connect();
      // 若 emit('error') 未守住，进程在此窗口内同步抛出并 exit(1)——能走到回调即证明未崩。
      setTimeout(() => {
        try { c.close(); } catch (_) {}
        pass("north-client: {t:'error'} 帧被忽略、未击穿进程");
        if (gotPose) pass('north-client: 同批正常 POSE 帧仍照常分发'); else fail('同批 POSE 未分发');
        resolve();
      }, 400);
    });
  });
}

// 伪车端：数 {t:'HB'} 帧
function hbCounterServer() {
  let hb = 0;
  const srv = net.createServer((sock) => {
    sock.on('error', () => {});
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (!line) continue;
        let o; try { o = JSON.parse(line); } catch (_) { continue; }
        if (o && o.t === 'HB') hb++;
      }
    });
  });
  servers.push(srv);
  return { srv, hbCount: () => hb };
}

// ---- Test 2a: 无操作员 → 0 HB ----
function test2absent() {
  return new Promise((resolve) => {
    const { srv, hbCount } = hbCounterServer();
    srv.listen(0, '127.0.0.1', () => {
      const be = new NorthBackend({ host: '127.0.0.1', port: srv.address().port, hasClients: () => false });
      be.connect();
      setTimeout(() => {
        const n = hbCount();
        try { be.close(); } catch (_) {}
        if (n === 0) pass('HB 门控：无操作员(hasClients=false) → 0 HB（不喂看门狗 → COMMS_LOST 可正常触发）');
        else fail('无操作员却收到 ' + n + ' 个 HB（COMMS_LOST 被机器流掩盖）');
        resolve();
      }, 1500);
    });
  });
}

// ---- Test 2b: 有操作员 → ≥2Hz HB ----
function test2present() {
  return new Promise((resolve) => {
    const { srv, hbCount } = hbCounterServer();
    srv.listen(0, '127.0.0.1', () => {
      const be = new NorthBackend({ host: '127.0.0.1', port: srv.address().port, hasClients: () => true });
      be.connect();
      setTimeout(() => {
        const n = hbCount();
        try { be.close(); } catch (_) {}
        if (n >= 2) pass('HB 门控：有操作员(hasClients=true) → ' + n + ' 个 HB（≥2Hz 正常喂）');
        else fail('有操作员却仅 ' + n + ' 个 HB（应 ≥2）');
        resolve();
      }, 1500);
    });
  });
}

(async () => {
  console.log('--- north 修复回归（error 帧不崩 / HB 操作员在场门控）---');
  await test1();
  await test2absent();
  await test2present();
  const failed = results.filter((r) => !r[0]).length;
  console.log('\n  ' + (results.length - failed) + '/' + results.length + ' checks passed.');
  finish(failed ? 1 : 0);
})();

setTimeout(() => { fail('global timeout'); finish(1); }, 8000);
