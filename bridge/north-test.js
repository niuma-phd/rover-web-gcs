'use strict';
/*
 * north-test.js — 北向协议后端测试（无 ROS / 无硬件 / 无 MAVLink）。
 *
 *  (a) 单元：NorthBackend 直连进程内 north-stub（真 TCP，临时端口 listen(0)），
 *      双向断言重映射：fix(§4.2)->fixType、SYS.safety/mode->hb、EVENT level->severity、
 *      ACK ok/result 枚举串->数字、mode/HOLD->MODE IDLE、rc->MANUAL 阿克曼标定等。
 *  (b) 端到端：spawn server.js（浏览器 WS 入口）+ 进程内 north-stub，经 WS 发
 *      connect{transport:'north'} 走全链路 WS-JSON ⇄ NorthBackend ⇄ JSON-lines TCP。
 *      （若站点启用 .site-auth 整站口令，运行前需暂移——同 itest 约定。）
 *
 * 模式沿用 rtcm-test.js（进程内假对端）+ itest.js（WS 浏览器客户端）；
 * 任何失败以非零码退出，末行打 N/N 通过数。
 */
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');
const { NorthBackend } = require('./north-backend');
const { NorthStub } = require('./north-stub');

const results = [];
const pass = (n) => { results.push([true, n]); console.log('  ✓ ' + n); };
const fail = (n) => { results.push([false, n]); console.log('  ✗ ' + n); };
const check = (cond, n) => { if (cond) pass(n); else fail(n); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function finish(forceCode) {
  const failed = results.filter((r) => !r[0]).length;
  console.log('\n  ' + (results.length - failed) + '/' + results.length + ' checks passed.');
  process.exit(forceCode != null ? forceCode : (failed ? 1 : 0));
}

// =========================== (a) 单元：NorthBackend <-> stub ===========================
async function unitTest() {
  console.log('--- (a) unit: NorthBackend <-> north-stub (TCP, 临时端口) ---');
  const stub = new NorthStub();
  const port = await new Promise((res) => stub.listen(0, res));
  const msgs = [];   // backend -> 「浏览器」广播收集
  const logs = [];
  const backend = new NorthBackend({
    host: '127.0.0.1', port,
    broadcast: (o) => msgs.push(o),
    log: (s) => logs.push(String(s)),
  });
  backend.connect();
  await delay(1300);   // 等 up + 各频率上行至少一轮 + ≥2 个 2Hz HB

  const find = (t, pred) => msgs.find((m) => m.t === t && (!pred || pred(m)));

  // ---- 上行方向 ----
  check(!!find('link', (m) => m.connected === true && /north/.test(m.transport || '')),
    'unit: link up (transport 含 north)');
  const pos = find('pos');
  check(!!(pos && Math.abs(pos.lat - 22.59012) < 1e-9 && Math.abs(pos.lon - 113.95102) < 1e-9
    && pos.hdg === 47.3 && pos.gs === 1.18),
    'unit: POSE -> pos（lat/lon + yaw->hdg + spd->gs）');
  check(!!find('home', (m) => Math.abs(m.lat - 22.59012) < 1e-9 && Math.abs(m.lon - 113.95102) < 1e-9),
    'unit: 首个 POSE -> 推断 home 广播（前端 🏠 标记）');
  check(!!find('gps', (m) => m.fixType === 6 && m.sats === 28 && Math.abs(m.hdop - 0.7) < 1e-9),
    'unit: GNSS fix=3(FIXED) -> gps fixType=6（前端 fixName=RTK固定）');
  check(!!find('hb', (m) => m.armed === false && m.modeName === 'IDLE'),
    'unit: SYS -> hb（safety!=RUN -> armed=false，mode->modeName）');
  check(!!find('sys', (m) => Math.abs(m.battV - 24.8) < 1e-9),
    'unit: SYS.volt(24800mV) -> sys.battV=24.8V');
  check(!!find('text', (m) => m.severity === 6 && String(m.text).indexOf('STUB_READY') !== -1),
    'unit: EVENT INFO -> text severity=6');
  const hbCount = stub.frames.filter((f) => f.t === 'HB').length;
  check(hbCount >= 2, 'unit: 2Hz HB 喂看门狗（1.3s 收到 ' + hbCount + ' 帧）');

  // EVENT WARN/ERROR 级别映射（stub.push 注入）
  stub.push({ t: 'EVENT', level: 'WARN', code: 'RTK_FLOAT', text: 'w' });
  stub.push({ t: 'EVENT', level: 'ERROR', code: 'NAV_STALE', text: 'e' });
  await delay(150);
  check(!!find('text', (m) => m.severity === 4 && String(m.text).indexOf('RTK_FLOAT') !== -1),
    'unit: EVENT WARN -> text severity=4');
  check(!!find('text', (m) => m.severity === 3 && String(m.text).indexOf('NAV_STALE') !== -1),
    'unit: EVENT ERROR -> text severity=3');

  // ---- 下行方向 ----
  backend.handleCommand({ t: 'mode', mode: 'HOLD' });                       // HOLD -> IDLE
  backend.handleCommand({ t: 'uploadMission', items: [
    { lat: 22.6, lon: 113.9, alt: 0 }, { lat: 22.61, lon: 113.91, alt: 0 }] });
  backend.handleCommand({ t: 'getParams', names: ['CRUISE_SPEED'] });
  backend.handleCommand({ t: 'setParam', id: 'CRUISE_SPEED', value: 99 });  // 超上限 2.5 -> clamped
  backend.handleCommand({ t: 'setParam', id: 'NOPE_PARAM', value: 1 });     // unknown_param -> 3
  backend.handleCommand({ t: 'changeSpeed', speed: 2 });                    // -> PARAM_SET CRUISE_SPEED
  backend.handleCommand({ t: 'rc', steer: 0.5, throttle: 1 });              // -> MANUAL 流式
  backend.handleCommand({ t: 'reboot' });                                   // 真不支持 -> no-op + 日志
  await delay(300);

  const sf = (t, pred) => stub.frames.find((f) => f.t === t && (!pred || pred(f)));
  check(!!sf('MODE', (f) => f.mode === 'IDLE' && typeof f.id === 'number'),
    'unit: mode HOLD -> MODE{mode:IDLE, 带 id}');
  check(!!find('ack', (m) => m.command === 'MODE' && m.result === 0),
    'unit: ACK(MODE ok) -> ack{command:MODE, result:0 ACCEPTED}');
  const wp = sf('WP');
  check(!!(wp && Array.isArray(wp.pts) && wp.pts.length === 2 && wp.pts[1].lat === 22.61 && wp.pts[1].lon === 113.91),
    'unit: uploadMission -> WP{pts×2 经纬度正确}');
  check(!!find('mission_uploaded', (m) => m.ok === true),
    'unit: WP 的 ACK -> mission_uploaded ok=true（任务状态 pill 通道）');
  check(!!find('mission_list', (m) => Array.isArray(m.items) && m.items.length === 2 && m.items[0].lat === 22.6),
    'unit: PLAN -> mission_list 预览（复用已下载任务通道）');
  check(!!sf('PARAM_REQ', (f) => f.name === 'CRUISE_SPEED' && typeof f.id === 'number'),
    'unit: getParams -> 逐名 PARAM_REQ');
  check(!!find('param', (m) => m.id === 'CRUISE_SPEED' && Math.abs(m.value - 1.0) < 1e-9),
    'unit: PARAM -> param{id:name, value}');
  check(!!find('ack', (m) => m.result === 0 && /->2\.5/.test(String(m.msg || ''))),
    'unit: PARAM_SET 钳位 -> ack result=0（clamped 算成功，msg 带实际采纳值）');
  check(!!find('ack', (m) => m.result === 3),
    'unit: unknown_param -> ack result=3（UNSUPPORTED）');
  check(!!sf('PARAM_SET', (f) => f.name === 'CRUISE_SPEED' && f.value === 2),
    'unit: changeSpeed -> PARAM_SET CRUISE_SPEED=2（映射）');
  const man = sf('MANUAL');
  check(!!(man && Math.abs(man.vx - 1.5) < 1e-9 && Math.abs(man.wz - 0.4) < 1e-9 && man.id === undefined),
    'unit: rc -> MANUAL{vx=throttle*Vmax=1.5, wz=steer*Wmax=0.4, 无 id}');
  check(logs.some((l) => l.indexOf('unsupported command reboot') !== -1),
    'unit: 未知命令(reboot) -> no-op + 明确日志（north: unsupported command）');
  check(!stub.frames.some((f) => f.t === 'reboot' || f.t === 'REBOOT'),
    'unit: 不支持命令未泄漏到北向链路');

  // estop -> ESTOP{on:true}；SYS.fault 变化 -> text 告警行
  backend.handleCommand({ t: 'estop' });
  await delay(400);
  check(!!sf('ESTOP', (f) => f.on === true && typeof f.id === 'number'),
    'unit: estop -> ESTOP{on:true}');
  check(!!find('text', (m) => m.severity === 3 && String(m.text).indexOf('ESTOP') !== -1),
    'unit: SYS.fault=ESTOP -> text 告警行（变化去抖）');

  // startMission -> MODE AUTO + MISSION start -> MSTAT RUNNING
  backend.handleCommand({ t: 'startMission' });
  await delay(300);
  check(!!sf('MODE', (f) => f.mode === 'AUTO'), 'unit: startMission -> MODE AUTO');
  check(!!sf('MISSION', (f) => f.cmd === 'start'), 'unit: startMission -> MISSION{cmd:start}');
  check(!!find('mstat', (m) => m.state === 'RUNNING'), 'unit: MSTAT -> mstat{state:RUNNING}');
  check(!!find('hb', (m) => m.armed === true), 'unit: safety=RUN -> hb.armed=true');

  // ---- 北向命令 GAP 补齐：goto / arm / rtl / setHome / uploadFence ----
  // goto：北向无 GUIDED -> WP 单点 + AUTO + start（前往此点）。单点坐标与 uploadMission 的 2 点区分。
  backend.handleCommand({ t: 'goto', lat: 22.588, lon: 113.949 });
  await delay(250);
  check(!!sf('WP', (f) => Array.isArray(f.pts) && f.pts.length === 1
      && Math.abs(f.pts[0].lat - 22.588) < 1e-9 && Math.abs(f.pts[0].lon - 113.949) < 1e-9),
    'unit: goto -> WP 单点[点击点] + AUTO + start');

  // arm(false)=上锁 -> 新 MODE IDLE 软停（≠ 带外 ESTOP 闩锁，用 IDLE 帧计数增量证明发了新帧）
  const idleBefore = stub.frames.filter((f) => f.t === 'MODE' && f.mode === 'IDLE').length;
  backend.handleCommand({ t: 'arm', arm: false });
  await delay(150);
  check(stub.frames.filter((f) => f.t === 'MODE' && f.mode === 'IDLE').length > idleBefore,
    'unit: arm(false)=上锁 -> 新 MODE IDLE 软停');
  // arm(true)=解锁 -> 仅本地 text 告知（北向无独立 arm 闸），不发任何北向帧
  backend.handleCommand({ t: 'arm', arm: true });
  await delay(100);
  check(!!find('text', (m) => /无独立解锁|运动由/.test(String(m.text || ''))),
    'unit: arm(true) -> 本地 text 告知（北向无独立 arm 闸）');
  check(!stub.frames.some((f) => f.t === 'ARM' || f.t === 'arm'),
    'unit: arm 未泄漏 ARM 帧到北向链路');

  // rtl 无 Home（白盒置空复现「定位固定前」）-> 明确拒绝，不静默、不发 WP
  backend.homeLat = null; backend.homeLon = null; backend.homeExplicit = false;
  const wpBeforeRtl = stub.frames.filter((f) => f.t === 'WP').length;
  backend.handleCommand({ t: 'rtl' });
  await delay(80);
  check(!!find('ack', (m) => m.command === 'rtl' && m.result === 2),
    'unit: rtl 无 Home -> ack rejected（result=2，不静默）');
  check(stub.frames.filter((f) => f.t === 'WP').length === wpBeforeRtl,
    'unit: rtl 无 Home -> 未发任何 WP（不乱跑）');

  // setHome 设权威返航点 -> rtl 合成 WP[Home]+AUTO+start
  backend.handleCommand({ t: 'setHome', lat: 22.595, lon: 113.955 });
  await delay(60);
  check(!!find('ack', (m) => m.command === 'setHome' && m.result === 0),
    'unit: setHome -> 本地 ack ok（GCS 侧返航点）');
  check(!!find('home', (m) => Math.abs(m.lat - 22.595) < 1e-9 && Math.abs(m.lon - 113.955) < 1e-9),
    'unit: setHome -> home 广播（权威返航点，前端 🏠）');
  backend.handleCommand({ t: 'rtl' });
  await delay(250);
  check(!!sf('WP', (f) => Array.isArray(f.pts) && f.pts.length === 1
      && Math.abs(f.pts[0].lat - 22.595) < 1e-9 && Math.abs(f.pts[0].lon - 113.955) < 1e-9),
    'unit: rtl(有 Home) -> WP[Home] 单点返航');

  // uploadFence：北向 v1 无围栏 -> 结构化拒绝；**绝不**误映射 FIELD（安全反模式）
  const fieldBefore = stub.frames.filter((f) => f.t === 'FIELD').length;
  backend.handleCommand({ t: 'uploadFence', items: [{ kind: 'exc', polygon: [{ lat: 22.5, lon: 113.9 }] }] });
  await delay(120);
  check(!!find('ack', (m) => m.command === 'uploadFence' && m.result === 2),
    'unit: uploadFence -> ack rejected（北向 v1 无地理围栏）');
  check(!!find('mission_uploaded', (m) => m.ok === false && m.fence === true),
    'unit: uploadFence -> mission_uploaded ok=false fence（前端围栏失败态）');
  check(stub.frames.filter((f) => f.t === 'FIELD').length === fieldBefore,
    'unit: uploadFence 绝不映射 FIELD（FIELD=待覆盖农田，误映射=覆盖禁区）');

  // 不支持模式（GUIDED/RTL/...）-> 明确回执（ack rejected + text），不静默（防操作员无反馈）
  backend.handleCommand({ t: 'mode', mode: 'GUIDED' });
  await delay(120);
  check(!!find('ack', (m) => m.command === 'mode' && m.result === 2),
    'unit: mode GUIDED（北向无）-> ack rejected（result=2，不静默）');
  check(!!find('text', (m) => /不支持该模式/.test(String(m.text || ''))),
    'unit: mode GUIDED -> text 明确告知不支持');

  // 北向失联看门狗：上行帧流停 >staleMs -> 恰一次 {t:'stale'}；持续喂帧恢复 -> link connected:true 复位。
  // 独立 stub/backend + 小 staleMs，避免与上文流交叉。
  {
    const stub2 = new NorthStub();
    const port2 = await new Promise((res) => stub2.listen(0, res));
    const m2 = [];
    const b2 = new NorthBackend({ host: '127.0.0.1', port: port2, broadcast: (o) => m2.push(o), log: () => {}, staleMs: 300 });
    b2.connect();
    await delay(400);                                   // link up + 帧流（lastRxMs 置位）
    for (const c of stub2.conns) stub2._stopTimers(c);  // 停车端上行流（socket 不关）
    await delay(1000);                                  // > staleMs + 若干 hb tick
    check(m2.filter((m) => m.t === 'stale').length === 1, 'unit: 上行帧流停 >staleMs -> 恰一次 {t:stale}');
    const afterStale = m2.length;
    for (let i = 0; i < 8; i++) { stub2.push({ t: 'EVENT', level: 'INFO', code: 'R', text: 'r' }); await delay(120); }  // 持续喂帧恢复
    check(m2.slice(afterStale).some((m) => m.t === 'link' && m.connected === true),
      'unit: 帧流恢复 -> link connected:true 复位（stale 之后）');
    b2.close(); stub2.close();
    await delay(80);
  }

  backend.close();
  stub.close();
  await delay(100);
}

// ============== (b) 端到端：server.js + WS 浏览器 + north-stub 全链路 ==============
async function e2eTest() {
  console.log('--- (b) e2e: server.js (WS) + north-stub 全链路 ---');
  const stub = new NorthStub();
  const stubPort = await new Promise((res) => stub.listen(0, res));

  const WEB_PORT = 8093;   // itest=8092 / simtest=8096，串行跑不冲突
  const server = spawn(process.execPath, [path.join(__dirname, 'server.js')],
    { env: { ...process.env, PORT: String(WEB_PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => process.stdout.write('  [bridge] ' + d));
  server.stderr.on('data', (d) => process.stderr.write('  [bridge:err] ' + d));

  let ws = null;
  try {
    await delay(600);   // 等 http/ws 起监听
    const wsMsgs = [];
    ws = new WebSocket('ws://127.0.0.1:' + WEB_PORT);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    ws.on('message', (d) => { try { wsMsgs.push(JSON.parse(d.toString())); } catch (_) {} });
    const wsend = (o) => ws.send(JSON.stringify(o));

    wsend({ t: 'connect', transport: 'north', host: '127.0.0.1', port: stubPort });
    await delay(900);   // link up + 遥测流跑起来
    wsend({ t: 'mode', mode: 'HOLD' });
    wsend({ t: 'uploadMission', items: [{ lat: 22.6, lon: 113.9, alt: 0 }, { lat: 22.61, lon: 113.91, alt: 0 }] });
    wsend({ t: 'setParam', id: 'WP_RADIUS', value: 1.0 });
    wsend({ t: 'getParams', names: ['CRUISE_SPEED'] });
    wsend({ t: 'rc', steer: -1, throttle: 0.5 });
    wsend({ t: 'estop' });
    wsend({ t: 'goto', lat: 22.585, lon: 113.945 });
    wsend({ t: 'uploadFence', items: [{ kind: 'exc', polygon: [{ lat: 22.5, lon: 113.9 }] }] });
    wsend({ t: 'status' });
    await delay(900);

    const find = (t, pred) => wsMsgs.find((m) => m.t === t && (!pred || pred(m)));
    check(!!find('link', (m) => m.connected === true && /north/.test(m.transport || '')),
      'e2e: WS 收 link up（north）');
    check(!!find('pos', (m) => Math.abs(m.lat - 22.59012) < 1e-9 && m.hdg === 47.3 && m.gs === 1.18),
      'e2e: POSE -> pos');
    check(!!find('hb', (m) => m.armed === false && (m.modeName === 'IDLE' || m.modeName === 'AUTO')),
      'e2e: SYS -> hb（modeName/armed）');
    check(!!find('sys', (m) => Math.abs(m.battV - 24.8) < 1e-9), 'e2e: SYS -> sys.battV');
    check(!!find('text', (m) => String(m.text || '').indexOf('STUB_READY') !== -1), 'e2e: EVENT -> text');
    check(!!find('param', (m) => m.id === 'CRUISE_SPEED'), 'e2e: PARAM -> param');
    check(!!find('ack', (m) => m.command === 'MODE' && m.result === 0), 'e2e: ACK -> ack（MODE ACCEPTED）');
    check(!!find('mission_list', (m) => Array.isArray(m.items) && m.items.length === 2),
      'e2e: PLAN -> mission_list 预览');
    check(!!find('mission_uploaded', (m) => m.ok === true), 'e2e: WP ACK -> mission_uploaded ok');
    check(!!find('snapshot', (m) => /north/.test(String(m.link || ''))),
      'e2e: status -> 北向快照（link=north …）');

    const sf = (t, pred) => stub.frames.find((f) => f.t === t && (!pred || pred(f)));
    check(!!sf('MODE', (f) => f.mode === 'IDLE'), 'e2e: mode HOLD -> 车端收 MODE IDLE');
    check(!!sf('WP', (f) => Array.isArray(f.pts) && f.pts.length === 2), 'e2e: uploadMission -> 车端收 WP');
    check(!!sf('PARAM_SET', (f) => f.name === 'WP_RADIUS' && f.value === 1), 'e2e: setParam -> 车端收 PARAM_SET');
    check(!!sf('ESTOP', (f) => f.on === true), 'e2e: estop -> 车端收 ESTOP{on:true}');
    check(!!sf('MANUAL', (f) => Math.abs(f.vx - 0.75) < 1e-9 && Math.abs(f.wz + 0.8) < 1e-9),
      'e2e: rc -> 车端收 MANUAL（vx=0.5*1.5, wz=-1*0.8）');
    check(!!sf('HB'), 'e2e: HB 到达车端（COMMS_LOST 看门狗有喂）');
    check(!!sf('WP', (f) => Array.isArray(f.pts) && f.pts.length === 1 && Math.abs(f.pts[0].lat - 22.585) < 1e-9),
      'e2e: goto -> 车端收 WP 单点');
    check(!!find('mission_uploaded', (m) => m.fence === true && m.ok === false),
      'e2e: uploadFence -> 结构化拒绝回浏览器（不映射 FIELD）');
    check(!stub.frames.some((f) => f.t === 'FIELD'),
      'e2e: uploadFence 未泄漏 FIELD 帧（安全）');

    // 断开：northBackend 拆除路径（server.js disconnect 顶部）
    wsend({ t: 'disconnect' });
    await delay(300);
    check(wsMsgs.some((m) => m.t === 'link' && m.connected === false),
      'e2e: disconnect -> 北向后端拆除（link connected=false）');
  } finally {
    try { if (ws) ws.close(); } catch (_) {}
    try { server.kill('SIGINT'); } catch (_) {}
    stub.close();
    await delay(200);
  }
}

(async () => {
  const guard = setTimeout(() => { fail('global timeout'); finish(1); }, 25000);
  try { await unitTest(); } catch (e) { fail('unit test threw: ' + (e && e.message)); }
  try { await e2eTest(); } catch (e) { fail('e2e test threw: ' + (e && e.message)); }
  clearTimeout(guard);
  finish();
})();
