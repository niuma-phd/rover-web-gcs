'use strict';
/*
 * north-stub.js — 假北向车端（JSON-lines TCP 服务器，测试专用，无硬件/无 ROS）。
 *
 * ⚠ 漂移风险声明：本文件用 JS **重述**了 C++ 契约实现
 *   （vehicle/ros2_ws/src/rover_gcs_bridge/include/rover_gcs_bridge/protocol.hpp 的
 *   parse_down 语义 + gcs_bridge dispatch 行为）。两处实现必然有漂移风险——权威永远是
 *   protocol.hpp + docs/接口契约_v1.md；若两端行为不一致，以车端为准并修本 stub。
 *
 * 行为（引契约章节）：
 *   - 建链即流式上行：POSE 10Hz(§3.2) / GNSS 5Hz(§3.3) / SYS 2Hz(§3.5) / MSTAT 1Hz(§3.4)，
 *     并即刻发一条 EVENT INFO STUB_READY(§3.6) + 一条 SYS。
 *   - 下行逐行解析（§1 信封）：坏 JSON -> EVENT ERROR bad_json；v 缺失/非整数/≠1 ->
 *     EVENT ERROR proto_ver；未知 t -> EVENT WARN unknown_type。字段全类型守卫，绝不抛
 *     （对齐 parse_down 无异常契约）。
 *   - 带 id 的 ESTOP/MODE/WP/FIELD/MISSION/PARAM_SET/PARAM_SAVE -> 回 ACK(§3.1)。
 *   - PARAM_REQ -> PARAM 流应答（**无 ACK**，§2.7/§3.7）；"*" 拉全表（i/n 进度）。
 *   - WP/FIELD -> ACK 后回 PLAN 预览（§3.8，回显点位；真车是 F2C 算覆盖航线）。
 *   - MANUAL/HB/RTCM 流式无 id 无 ACK（§2.6/§2.8/§2.9）。
 *
 * 用法：
 *   库：  const { NorthStub } = require('./north-stub');
 *         new NorthStub().listen(0, (port)=>...)；'frame' 事件/this.frames 供测试断言；
 *         push(frame) 向所有连接注入任意上行帧（EVENT/故障场景驱动）。
 *   CLI： node bridge/north-stub.js [port]（缺省 0=系统分配，stdout 打 "listening <port>"）。
 */
const net = require('net');
const { EventEmitter } = require('events');

// 参数表子集（docs/参数表.json 的字段形状；stub 只需几条供 PARAM_REQ/SET 测试）
const PARAM_DEFS = {
  CRUISE_SPEED: { def: 1.5, min: 0.0, max: 2.5, group: 'guidance', unit: 'm/s', value: 1.0 },
  WP_RADIUS:    { def: 0.5, min: 0.1, max: 5.0, group: 'guidance', unit: 'm',   value: 0.5 },
  RTK_POLICY:   { def: 0,   min: 0,   max: 1,   group: 'safety',   unit: '',    value: 0 },
};

const MAX_LINE = 1 << 20;   // 未终结行缓冲上限（防 OOM；真车是 4MB 断连，§3.6 frame_too_big）

class NorthStub extends EventEmitter {
  constructor() {
    super();
    this.server = null;
    this.conns = new Set();
    this.seq = 0;               // 上行 seq（全局计数，§1）
    this.frames = [];           // 收到的全部通过信封校验的下行帧（测试断言用）
    // 车端状态镜像（SYS/MSTAT 上行内容）
    this.mode = 'IDLE';
    this.safety = 'IDLE';       // IDLE|RUN|STOP（§3.5）
    this.fault = '';            // ""|ESTOP|...（§4.3）
    this.mstat = { state: 'IDLE', cur: 0, total: 0 };
    this.params = {};           // name -> 运行时值
    for (const [k, d] of Object.entries(PARAM_DEFS)) this.params[k] = d.value;
    this.rtcmBytes = 0;         // RTCM 解码后累计字节（§2.9）
  }

  listen(port, cb) {
    this.server = net.createServer((sock) => this._onConn(sock));
    this.server.on('error', (e) => this.emit('error', e));
    this.server.listen(port || 0, '127.0.0.1', () => { if (cb) cb(this.server.address().port); });
    return this;
  }

  close() {
    for (const c of this.conns) { this._stopTimers(c); try { c.sock.destroy(); } catch (_) {} }
    this.conns.clear();
    if (this.server) { try { this.server.close(); } catch (_) {} this.server = null; }
  }

  // 向所有连接注入任意上行帧（测试用：驱动 EVENT WARN/ERROR、故障注入等场景）
  push(frame) { for (const c of this.conns) this._send(c, frame); }

  // ---- 连接生命周期 ----
  _onConn(sock) {
    const c = { sock, buf: '', timers: [] };
    this.conns.add(c);
    sock.on('error', () => {});   // 'close' 跟随，不许抛
    sock.on('close', () => { this._stopTimers(c); this.conns.delete(c); });
    sock.on('data', (d) => this._onData(c, d));
    // 建链即流（§3 建议速率）：POSE 10Hz / GNSS 5Hz / SYS 2Hz / MSTAT 1Hz 保底
    this._send(c, { t: 'EVENT', level: 'INFO', code: 'STUB_READY', text: 'stub vehicle online' });
    this._sendSys(c);   // 立即一条 SYS，测试不必等 500ms 刻
    c.timers.push(setInterval(() => this._send(c, { t: 'POSE', lat: 22.59012, lon: 113.95102, yaw: 47.3, spd: 1.18, x: 12.4, y: 33.1 }), 100));
    c.timers.push(setInterval(() => this._send(c, { t: 'GNSS', fix: 3, sats: 28, hdop: 0.7, diff_age: 1.2, hdg_valid: true }), 200));
    c.timers.push(setInterval(() => this._sendSys(c), 500));
    c.timers.push(setInterval(() => this._send(c, Object.assign({ t: 'MSTAT' }, this.mstat)), 1000));
  }

  _stopTimers(c) { for (const t of c.timers) clearInterval(t); c.timers = []; }

  // ---- 上行编码：信封 v/t/seq/ts + 业务字段（对齐 protocol.hpp detail::envelope）----
  _send(c, extra) {
    const f = Object.assign({ v: 1, t: extra.t, seq: (this.seq++) >>> 0, ts: Date.now() }, extra);
    try { c.sock.write(JSON.stringify(f) + '\n'); } catch (_) {}
  }

  _sendSys(c) {
    this._send(c, { t: 'SYS', mode: this.mode, safety: this.safety, fault: this.fault,
      vcu_stop: false, volt: 24800, link_ms: 120 });
  }
  _sendSysAll() { for (const c of this.conns) this._sendSys(c); }
  _sendMstatAll() { for (const c of this.conns) this._send(c, Object.assign({ t: 'MSTAT' }, this.mstat)); }

  _sendParam(c, name, i, n) {
    const d = PARAM_DEFS[name];
    this._send(c, { t: 'PARAM', name, value: this.params[name], def: d.def, min: d.min, max: d.max,
      group: d.group, unit: d.unit, i, n });
  }

  // ---- 下行按行切分（同真车 client_loop 按 '\n' 缓冲）----
  _onData(c, d) {
    c.buf += d.toString('utf8');
    let idx;
    while ((idx = c.buf.indexOf('\n')) >= 0) {
      const line = c.buf.slice(0, idx).trim();
      c.buf = c.buf.slice(idx + 1);
      if (line) this._onLine(c, line);
    }
    if (c.buf.length > MAX_LINE) c.buf = '';   // 未终结垃圾：丢弃不增长
  }

  // ---- 下行解析 + 应答（镜像 parse_down + dispatch；绝不抛）----
  _onLine(c, line) {
    let j;
    try { j = JSON.parse(line); } catch (_) { j = null; }
    if (!j || typeof j !== 'object' || Array.isArray(j)) {
      this._send(c, { t: 'EVENT', level: 'ERROR', code: 'bad_json', text: line.slice(0, 60) });
      return;
    }
    // 版本先于类型：须为整数且 ==1（浮点 1.9 不得截断当 1；§1/§8，同 parse_down BAD_VER）
    if (!Number.isInteger(j.v) || j.v !== 1) {
      this._send(c, { t: 'EVENT', level: 'ERROR', code: 'proto_ver', text: 'v=' + String(j.v) });
      return;
    }
    // id：非负整数才算（负/浮点/串一律视为无 id，同 parse_down）
    const id = (typeof j.id === 'number' && Number.isInteger(j.id) && j.id >= 0) ? j.id : null;
    const ack = (ok, result, msg) => { if (id !== null) this._send(c, { t: 'ACK', id, ok, result, msg: msg || '' }); };

    this.frames.push(j);          // 通过信封校验的帧全部记录（含未知 t），供测试断言
    this.emit('frame', j, c);

    switch (j.t) {
      case 'HB':
        break;   // 喂看门狗（stub 不建模 COMMS_LOST 超时），无应答（§2.8）
      case 'ESTOP': {
        // on 缺省/错类型 -> true（宁停勿走，同 parse_down 的 fail-safe 缺省）
        const on = (typeof j.on === 'boolean') ? j.on : true;
        this.fault = on ? 'ESTOP' : '';
        this.safety = on ? 'STOP' : 'IDLE';
        ack(true, 'ok', on ? 'ESTOP engaged' : 'ESTOP cleared');
        this._sendSysAll();
        break;
      }
      case 'MODE': {
        const mode = (typeof j.mode === 'string') ? j.mode : '';   // 错类型 -> '' -> bad_arg（同 dispatch）
        if (mode !== 'IDLE' && mode !== 'AUTO' && mode !== 'MANUAL') { ack(false, 'bad_arg', 'mode=' + mode); break; }
        this.mode = mode;
        ack(true, 'ok', 'mode=' + mode);
        this._sendSysAll();
        break;
      }
      case 'WP': {   // §2.3：缺/错类型点跳过（同 parse_down）；0 有效点 -> bad_arg
        const pts = [];
        if (Array.isArray(j.pts)) {
          for (const p of j.pts) {
            if (!p || typeof p !== 'object') continue;
            if (typeof p.lat !== 'number' || typeof p.lon !== 'number') continue;
            pts.push({ lat: p.lat, lon: p.lon });
          }
        }
        if (!pts.length) { ack(false, 'bad_arg', 'no valid pts'); break; }
        this.mstat = { state: 'IDLE', cur: 0, total: pts.length };
        ack(true, 'ok', 'wp n=' + pts.length);
        // §3.8：WP 直给航点亦回显 PLAN 预览（src:wp）
        this._send(c, { t: 'PLAN', src: 'wp', n: pts.length, pts: pts.map((p) => ({ lat: p.lat, lon: p.lon, yaw: 88.7 })) });
        this._sendMstatAll();
        break;
      }
      case 'FIELD': {   // §2.4：≥3 顶点；假「覆盖规划」= 回显边界作预览（真车 F2C 算条带）
        const poly = [];
        if (Array.isArray(j.poly)) {
          for (const p of j.poly) {
            if (!p || typeof p !== 'object') continue;
            if (typeof p.lat !== 'number' || typeof p.lon !== 'number') continue;
            poly.push({ lat: p.lat, lon: p.lon });
          }
        }
        if (poly.length < 3) { ack(false, 'bad_arg', 'poly needs >=3'); break; }
        this.mstat = { state: 'IDLE', cur: 0, total: poly.length };
        ack(true, 'ok', 'coverage planned swaths=1 waypoints=' + poly.length);
        this._send(c, { t: 'PLAN', src: 'coverage', n: poly.length, pts: poly });
        this._sendMstatAll();
        break;
      }
      case 'MISSION': {   // §2.5 四动词；PAUSED 塌缩为 IDLE（§3.4 ⚠ 与真车一致）
        const cmd = (typeof j.cmd === 'string') ? j.cmd : '';
        if (cmd !== 'start' && cmd !== 'pause' && cmd !== 'resume' && cmd !== 'stop') { ack(false, 'bad_arg', 'cmd=' + cmd); break; }
        if (cmd === 'start' || cmd === 'resume') {
          this.mstat.state = 'RUNNING';
          this.mstat.cur = Math.max(1, this.mstat.cur);
          this.safety = 'RUN';
        } else if (cmd === 'pause') {
          this.mstat.state = 'IDLE';
          this.safety = 'IDLE';
        } else {   // stop
          this.mstat = { state: 'IDLE', cur: 0, total: this.mstat.total };
          this.safety = 'IDLE';
        }
        ack(true, 'ok', 'mission ' + cmd);
        this._sendMstatAll();
        this._sendSysAll();
        break;
      }
      case 'MANUAL':
        break;   // 流式无 ACK（§2.6）；vx/wz 已入 frames 供断言（错类型由消费端守卫）
      case 'PARAM_REQ': {   // §2.7：无 ACK，以 PARAM 流应答；"*" 全表带 i/n，单名 i=n=1
        const name = (typeof j.name === 'string') ? j.name : '';
        if (name === '*') {
          const keys = Object.keys(PARAM_DEFS);
          keys.forEach((k, i) => this._sendParam(c, k, i + 1, keys.length));
        } else if (PARAM_DEFS[name]) {
          this._sendParam(c, name, 1, 1);
        } else {
          this._send(c, { t: 'EVENT', level: 'WARN', code: 'unknown_param', text: 'PARAM_REQ ' + name });
        }
        break;
      }
      case 'PARAM_SET': {   // §2.7：范围钳位，ACK 回实际采纳值（clamped）；未知名 unknown_param
        const name = (typeof j.name === 'string') ? j.name : '';
        const d = PARAM_DEFS[name];
        if (!d) { ack(false, 'unknown_param', name); break; }
        if (typeof j.value !== 'number' || !isFinite(j.value)) { ack(false, 'bad_arg', name); break; }
        const v = Math.max(d.min, Math.min(d.max, j.value));
        this.params[name] = v;
        if (v !== j.value) ack(true, 'clamped', name + '=' + j.value + '->' + v);
        else ack(true, 'ok', name + '=' + v);
        break;
      }
      case 'PARAM_SAVE':
        ack(true, 'ok', 'saved');   // §2.7：落盘持久化（stub 无盘，直接 ok）
        break;
      case 'RTCM': {   // §2.9：流式无 id 无 ACK；stub 只计解码后字节（坏 base64 静默丢弃）
        if (typeof j.data === 'string' && j.data) {
          try { this.rtcmBytes += Buffer.from(j.data, 'base64').length; } catch (_) {}
        }
        break;
      }
      default:
        // §1 前向兼容：未知 t 忽略 + EVENT WARN unknown_type
        this._send(c, { t: 'EVENT', level: 'WARN', code: 'unknown_type', text: String(j.t) });
        break;
    }
  }
}

// CLI 入口：node bridge/north-stub.js [port]
if (require.main === module) {
  const port = parseInt(process.argv[2] || '0', 10);
  const stub = new NorthStub();
  stub.on('error', (e) => { console.error('stub error: ' + e.message); process.exit(1); });
  stub.listen(port, (p) => console.log('listening ' + p));
  process.on('SIGINT', () => { stub.close(); process.exit(0); });
}

module.exports = { NorthStub, PARAM_DEFS };
