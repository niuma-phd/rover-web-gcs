'use strict';
/*
 * north-backend.js — 北向路线A 协议后端（「协议切换」的 north 分支）。
 *
 *   浏览器 WS-JSON（现有 MAVLink 方言，前端零改动）
 *        ⇅ 本文件做字段级翻译（= 契约 §8 要求的「契约↔WS-JSON 映射表」GCS 侧落地）
 *   北向 JSON-lines TCP（权威 = docs/接口契约_v1.md + 车端 rover_gcs_bridge/protocol.hpp）
 *
 * server.js 在 connect{transport:'north'} 时创建本类；northBackend 为 null 时
 * MAVLink 路径 100% 不变（本文件不 require 任何 MAVLink 代码）。
 *
 * 上行翻译（车端 → 浏览器 WS）：
 *   POSE  -> {t:'pos',lat,lon,hdg:yaw,gs:spd}   lat/lon 缺省（车端无 datum）则不发，防前端 toFixed 崩
 *   GNSS  -> {t:'gps',fixType,sats,hdop}        fix 0/1/2/3(§4.2) -> 前端 fixName 下标 0/3/5/6
 *   SYS   -> {t:'hb',armed:safety==='RUN',modeName:mode} + {t:'sys',battV:volt/1000}
 *            fault 变化时另发 {t:'text'} 告警行（2Hz 原样转会刷屏，故去抖）
 *   MSTAT -> {t:'mstat',...} 常发 + 变化时 {t:'text'} 进度行
 *   EVENT -> {t:'text'}，level INFO/WARN/ERROR -> severity 6/4/3（前端 sevClass 分色）
 *   PARAM -> {t:'param',id:name,value,index:i,count:n}
 *   ACK   -> {t:'ack',command,result}（ok -> 数字 result；WP/FIELD 的 ACK 另发 mission_uploaded
 *            驱动前端任务状态 pill）
 *   PLAN  -> {t:'mission_list',items:[{lat,lon,alt:0}]}（复用前端「已下载任务」预览通道，§3.8
 *            「GCS 预览 + 车端算」）
 *   RTCM_GGA -> 内部帧不转发浏览器（VRS GGA 回传归 rtcm-relay 自己的北向连接管，§3.9）
 *
 * 下行翻译（浏览器 WS → 车端）：见 handleCommand()。带 id 命令入 pending 表供 ACK 关联；
 * 另起 2Hz HB 定时器喂车端 COMMS_LOST 看门狗（契约 §2.8；注意 RTCM 不喂 §2.9，
 * 所以 rtcm-relay 的改正流救不了断链判定——必须由本后端的 HB/命令流证明操作员在场）。
 *   goto     -> WP 单点 + MODE AUTO + MISSION start（北向无 GUIDED，用单点航点表等价「前往此点」）
 *   arm      -> 北向无 arm 闸（§2.1 注，VCU 可能无 arm 概念）：arm:false=上锁=MODE IDLE 软停；
 *               arm:true=解锁=本地 text 告知（运动由 模式+任务 使能，无独立解锁步）
 *   rtl      -> 已知 Home 则合成 WP[Home]+AUTO+start；未知则明确拒绝（Home 由 setHome 权威/首 POSE 推断）
 *   setHome  -> GCS 侧记返航参考点（北向无 Home 帧）
 *   uploadFence -> 北向 v1 无地理围栏（契约 §8 预留 FENCE_*）→ 结构化拒绝（text+ack+任务栏失败态）。
 *               **绝不**映射到 FIELD——FIELD 是「待覆盖农田」，语义与「禁入区」相反，误映射会让车去
 *               覆盖禁区（安全反模式）。
 * 其余真不支持命令 = no-op + 明确日志，绝不 crash（handleCommand 由 server.js 直调，抛出会断 WS 会话）。
 *
 * 依赖：仅 ./north-client（其内仅 node 内置 net）——零新增 npm 依赖。
 */
const { NorthClient } = require('./north-client');

// 北向 fix（契约 §4.2：0 FIX_NONE / 1 FIX_SINGLE / 2 FIX_FLOAT / 3 FIX_FIXED）
// -> 前端 fixName 下标（app.js: ['无定位','无定位','2D','3D','DGPS','RTK浮动','RTK固定']）
// 即显示 无定位 / 3D / RTK浮动 / RTK固定。
const FIX_MAP = { 0: 0, 1: 3, 2: 5, 3: 6 };

// EVENT.level（契约 §4.4）-> MAVLink STATUSTEXT severity（前端 sevClass：<=3 err / 4 warn / >=5 info）
const LEVEL_SEV = { ERROR: 3, WARN: 4, INFO: 6 };

// ACK.result 枚举串（契约 §3.1）-> 前端 ackName 数字（MAV_RESULT 习惯）。
// ok/clamped 都算成功=0（clamped 的实际采纳值在 msg 里透出），其余映射到语义最近者。
const ACK_RESULT = { ok: 0, clamped: 0, busy: 1, rejected: 2, unknown_param: 3, bad_arg: 4 };

// 浏览器 mode（ArduPilot Rover 名/号）-> 北向 mode 枚举（契约 §4.1：IDLE|AUTO|MANUAL）。
// HOLD/暂停语义在北向 = IDLE（零速待命）；不在表内的（RTL/GUIDED/...）北向无对应 -> 不支持。
const MODE_MAP = { HOLD: 'IDLE', IDLE: 'IDLE', AUTO: 'AUTO', MANUAL: 'MANUAL', 0: 'MANUAL', 4: 'IDLE', 10: 'AUTO' };

const HB_PERIOD_MS = 500;   // 2Hz 下行心跳（契约 §2.8：≥2Hz；车端无下行 >1s 即 COMMS_LOST 零速）
const MAX_PENDING = 256;    // id->类型 关联表上限（车端丢 ACK 时防泄漏，淘汰最旧）
const STALE_MS = 3000;      // 北向失联判据：socket 未关但上行帧流停 >3s -> 前端 stale 提示（stub POSE 10Hz/SYS 2Hz，3s 静默=真停）

// ---- 类型守卫小工具（对齐车端 parse_down 的「错类型 -> 缺省，绝不抛」约定）----
function num(v, dflt = null) { return (typeof v === 'number' && isFinite(v)) ? v : dflt; }
function str(v, dflt = '') { return (typeof v === 'string') ? v : dflt; }
function clamp1(v) { return Math.max(-1, Math.min(1, v || 0)); }

class NorthBackend {
  constructor(opts = {}) {
    this.host = String(opts.host || '127.0.0.1').trim();
    this.port = parseInt(opts.port || 6001, 10);
    this.broadcast = (typeof opts.broadcast === 'function') ? opts.broadcast : () => {};
    this.log = (typeof opts.log === 'function') ? opts.log : () => {};
    // 操作员在场判据（= 有活着的浏览器 WS）。HB 是喂车端 COMMS_LOST 看门狗的唯一下行信号，
    // **必须**只在操作员在场时才发——否则浏览器崩了/断网了 HB 仍长流，掩盖失联失效保护
    // （与 RTCM 机器流掩盖看门狗同类，契约 §2.8/§2.9）。server.js 传 () => clients.size>0，
    // 并配 WS ping/pong 剔除半开死连接使该判据可靠。缺省 () => true 仅供直连单测（生产必传）。
    this.hasClients = (typeof opts.hasClients === 'function') ? opts.hasClients : () => true;
    // MANUAL 软摇杆满舵标定（阿克曼 twist，契约 §2.6）：vx=throttle*vmax, wz=steer*wmax。
    // 车端 rover_safety 仍会过阿克曼守卫（|wz|<=vx/R_min、vx≈0=>wz=0），此处只是满舵量程。
    // ▲ 上车核：wmax 与 R_min 匹配；wz 正负号（REP-103 +z=左转 vs 摇杆右打正）若反了在此翻号。
    this.vmax = (typeof opts.vmax === 'number' && isFinite(opts.vmax)) ? opts.vmax : 1.5;   // m/s
    this.wmax = (typeof opts.wmax === 'number' && isFinite(opts.wmax)) ? opts.wmax : 0.8;   // rad/s

    this.client = null;
    this.hbTimer = null;
    this.nextId = 1;            // 下行命令 id 计数器（ACK.id 回填关联，契约 §1）
    this.pending = new Map();   // id -> 下行类型串（供 ACK 翻译回浏览器 ack.command）
    this.lastFault = '';        // SYS.fault 去抖（变化才发 text 行）
    this.lastMstat = '';        // MSTAT 去抖（变化才发 text 行）
    // rtl 返航参考点：setHome 显式设置=权威（homeExplicit=true）；否则首个有效 POSE 推断为起点
    // （best-effort 兜底——北向无 Home 上行帧；GCS 中途接入时推断点可能非真起点，rtl 会注明）。
    this.homeLat = null; this.homeLon = null; this.homeExplicit = false;
    this.lastRxMs = 0; this.staleSent = false;   // 北向失联看门狗（上行帧流断则一次性 stale，恢复则复位 link）
    this.staleMs = (typeof opts.staleMs === 'number' && opts.staleMs > 0) ? opts.staleMs : STALE_MS;   // 可配（测试用小值）
    // 浏览器快照镜像（形状对齐 server.js 的 vehicle，前端 applyVehicle 直接可用）
    this.vehicle = {
      connected: false, type: null, autopilot: null, armed: false,
      mode: null, modeName: '--', lat: null, lon: null, hdg: 0, gs: 0,
      fixType: 0, sats: 0, battV: 0, battA: 0, battPct: -1, home: null,
    };
  }

  describe() { return `north ${this.host}:${this.port}`; }

  connect() {
    if (this.client) return this;
    this.log('north link: connecting ' + this.describe());
    const c = new NorthClient(this.host, this.port);
    this.client = c;
    c.on('up', () => {
      this.vehicle.connected = true;
      this.log('north link up: ' + this.describe());
      this.broadcast({ t: 'link', connected: true, transport: this.describe() });
      if (this.hasClients()) c.send({ t: 'HB' });   // 建链即喂一次看门狗——仅操作员在场时
    });
    c.on('down', () => {
      this.vehicle.connected = false;
      this.log('north link down (auto-reconnect)');
      this.broadcast({ t: 'link', connected: false });
    });
    c.on('frame', (f) => this._onFrame(f));
    c.connect();
    // 2Hz HB：仅在链路已连 **且操作员在场**（有活浏览器）时下发。操作员不在 ⇒ 停发 ⇒
    // 车端 >1s 无下行触发 COMMS_LOST 零速（正确失效保护，不被机器 HB 流掩盖，契约 §2.8）。
    this.hbTimer = setInterval(() => {
      try {   // 定时器路径也守无异常契约：逃逸异常从 setInterval 冒出无外层 catch，会 terminate 整桥（连带 demo）
        if (this.client && this.hasClients()) this.client.send({ t: 'HB' });
        // 北向失联检测：链路已连但上行帧流停 >staleMs -> 一次性 {t:'stale'}（前端 setLinkStale）；
        // 帧流恢复 -> 一次性 {t:'link',connected:true} 复位链路点（不刷屏）。socket 真关走 'down' 事件。
        const stale = !!(this.client && this.vehicle.connected && this.lastRxMs && (Date.now() - this.lastRxMs > this.staleMs));
        if (stale && !this.staleSent) { this.staleSent = true; this.broadcast({ t: 'stale' }); }
        else if (!stale && this.staleSent) { this.staleSent = false; this.broadcast({ t: 'link', connected: true, transport: this.describe() }); }
      } catch (e) { this.log('north: hb-tick error (ignored): ' + (e && e.message)); }
    }, HB_PERIOD_MS);
    return this;
  }

  close() {
    if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; }
    const c = this.client;
    this.client = null;
    if (c) { try { c.close(); } catch (_) {} }
    if (this.vehicle.connected) {
      this.vehicle.connected = false;
      this.broadcast({ t: 'link', connected: false });
    }
    this.pending.clear();
  }

  // 北向版快照（server.js sendSnapshot 在 northBackend 激活时改用本方法的返回值）
  snapshot() {
    return { t: 'snapshot', vehicle: this.vehicle, connected: this.vehicle.connected, link: this.describe() };
  }

  // ======================= 上行：北向帧 -> 浏览器 WS =======================
  // 硬性 fail-safe：任何上行处理异常只记日志、绝不外抛（外抛会沿 north-client 的
  // socket data 事件炸掉整个 server 进程——与车端 parse_down 无异常契约同理）。
  _onFrame(f) {
    this.lastRxMs = Date.now();   // 上行帧到达时刻（北向失联看门狗用；HB 是下行不计入）
    try { this._route(f); } catch (e) { this.log('north: up-frame error (ignored): ' + (e && e.message)); }
  }

  _route(f) {
    switch (f.t) {
      case 'POSE': {   // §3.2 -> 前端 pos（yaw->hdg 真北度，spd->gs m/s）
        const hdg = num(f.yaw, 0), gs = num(f.spd, 0);
        this.vehicle.hdg = hdg; this.vehicle.gs = gs;
        const lat = num(f.lat), lon = num(f.lon);
        if (lat === null || lon === null) break;   // 无 datum 时车端可不填 lat/lon -> 跳过不发
        this.vehicle.lat = lat; this.vehicle.lon = lon;
        if (this.homeLat === null && !(lat === 0 && lon === 0)) {   // 首个有效定位=推断起点（供 rtl 兜底；setHome 覆盖为权威）。(0,0)=未定位哨兵 -> 跳过，防 🏠 落 null island / rtl 乱指
          this.homeLat = lat; this.homeLon = lon;
          this.broadcast({ t: 'home', lat, lon });   // 北向无 Home 上行帧 -> 用首个定位点落 🏠 标记（rtl 兜底点可见）
        }
        this.broadcast({ t: 'pos', lat, lon, relAlt: 0, hdg, gs });
        break;
      }
      case 'GNSS': {   // §3.3 -> 前端 gps；未知 fix 一律当 0 无定位（fail-safe）
        const fixType = (FIX_MAP[f.fix] != null) ? FIX_MAP[f.fix] : 0;
        const sats = num(f.sats, 0);
        this.vehicle.fixType = fixType; this.vehicle.sats = sats;
        this.broadcast({ t: 'gps', fixType, sats, hdop: num(f.hdop, 0) });
        break;
      }
      case 'SYS': {    // §3.5 -> hb（模式/「武装」）+ sys（电压）；fault 变化 -> text 告警行
        const modeName = str(f.mode, '--') || '--';
        const armed = str(f.safety, '') === 'RUN';   // 北向无 arm 概念：safety==RUN 视作已武装
        this.vehicle.modeName = modeName; this.vehicle.mode = modeName; this.vehicle.armed = armed;
        this.vehicle.battV = num(f.volt, 0) / 1000;  // mV -> V
        this.broadcast({ t: 'hb', type: null, autopilot: null, armed, mode: modeName, modeName });
        this.broadcast({ t: 'sys', battV: this.vehicle.battV, battA: 0, battPct: -1 });
        const fault = str(f.fault, '');
        if (fault !== this.lastFault) {
          if (fault) this.broadcast({ t: 'text', severity: 3, text: '安全故障: ' + fault });
          else this.broadcast({ t: 'text', severity: 6, text: '安全故障解除 (' + this.lastFault + ')' });
          this.lastFault = fault;
        }
        break;
      }
      case 'MSTAT': {  // §3.4 -> 类型化 mstat 常发（前端未知类型自动忽略）+ 变化时 text 进度行
        const state = str(f.state, ''), cur = num(f.cur, 0), total = num(f.total, 0);
        this.broadcast({ t: 'mstat', state, cur, total, dist_next: num(f.dist_next, null) });
        const key = state + ' ' + cur + '/' + total;
        if (key !== this.lastMstat) {
          this.lastMstat = key;
          this.broadcast({ t: 'text', severity: 6, text: '任务状态 ' + key });
        }
        break;
      }
      case 'EVENT': {  // §3.6 -> text 行，级别映射 severity（INFO 6 / WARN 4 / ERROR 3）
        const level = str(f.level, '');
        const sev = (LEVEL_SEV[level] != null) ? LEVEL_SEV[level] : 6;
        const code = str(f.code, '');
        this.broadcast({ t: 'text', severity: sev, text: (code ? '[' + code + '] ' : '') + str(f.text, '') });
        break;
      }
      case 'PARAM': {  // §3.7 -> 前端 param（name->id，i/n->index/count）
        const name = str(f.name, '');
        if (!name) break;
        this.broadcast({ t: 'param', id: name, value: num(f.value, 0), index: num(f.i, 1), count: num(f.n, 1) });
        break;
      }
      case 'ACK': {    // §3.1 -> 前端 ack（ok/result 枚举串 -> 数字 result）
        const pendType = this.pending.get(f.id);
        this.pending.delete(f.id);
        const rs = str(f.result, '');
        const result = (f.ok === true) ? 0
          : ((ACK_RESULT[rs] != null && ACK_RESULT[rs] !== 0) ? ACK_RESULT[rs] : 4);   // 失败缺省 FAILED
        this.broadcast({ t: 'ack', command: pendType || ('id=' + f.id), result, msg: str(f.msg, '') });
        // WP/FIELD 的 ACK 兼作「任务上传」结果 -> 驱动前端任务状态 pill（mission_uploaded 通道）
        if (pendType === 'WP' || pendType === 'FIELD') {
          this.broadcast({ t: 'mission_uploaded', ok: f.ok === true, result, fence: false });
        }
        break;
      }
      case 'PLAN': {   // §3.8「GCS 预览+车端算」-> 复用前端「已下载任务」预览通道（mission_list）
        const pts = Array.isArray(f.pts) ? f.pts : [];
        const items = [];
        for (const p of pts) {
          if (!p || typeof p !== 'object') continue;
          const lat = num(p.lat), lon = num(p.lon);
          if (lat === null || lon === null) continue;   // 缺/错类型点跳过（同车端 parse_down 风格）
          items.push({ lat, lon, alt: 0 });
        }
        this.broadcast({ t: 'mission_list', items, plan: true, src: str(f.src, '') });
        this.log('north: PLAN 预览 ' + items.length + ' 点 (src=' + (str(f.src, '') || '?') + ')');
        break;
      }
      case 'RTCM_GGA':
        break;   // 内部帧：VRS GGA 回传由 rtcm-relay 自己的北向连接消费（§3.9），不上浏览器
      default:
        break;   // 未知上行类型：前向兼容，忽略（契约 §8）
    }
  }

  // ======================= 下行：浏览器 WS 命令 -> 北向帧 =======================
  // 不支持的命令一律 no-op + 明确日志，绝不抛（MVP 约定；handleCommand 由 server.js
  // 的浏览器消息处理器直调，抛出会断 WS 会话）。
  handleCommand(m) {
    if (!m || typeof m.t !== 'string') return;
    try { this._command(m); } catch (e) { this.log('north: command ' + m.t + ' error (ignored): ' + (e && e.message)); }
  }

  _command(m) {
    switch (m.t) {
      case 'status': this.broadcast(this.snapshot()); break;   // 快照北向化（与旧 sendSnapshot() 同为广播）
      case 'mode': {
        const north = MODE_MAP[(typeof m.mode === 'string') ? m.mode.toUpperCase() : m.mode];
        if (!north) {   // 北向无对应模式（RTL/GUIDED/...）：明确回执，不静默（操作员否则无反馈）
          this.log('north: unsupported command mode=' + m.mode + '（北向仅 IDLE|AUTO|MANUAL，§4.1）');
          this._localAck('mode', 2, 'unsupported-mode');
          this._localText(4, '北向不支持该模式：' + String(m.mode) + '（仅 手动/待命(IDLE)/自动(AUTO)）');
          break;
        }
        this._cmd('MODE', { mode: north });
        break;
      }
      case 'auto': this._cmd('MODE', { mode: 'AUTO' }); break;
      case 'pause': this._cmd('MISSION', { cmd: 'pause' }); break;   // 暂停 = 任务动词（§2.5），非模式
      case 'startMission':
        // 先 AUTO 后 start（§2.2/§2.5）：MODE 交 rover_safety 仲裁，MISSION 走 rover_pursuit 状态机
        this._cmd('MODE', { mode: 'AUTO' });
        this._cmd('MISSION', { cmd: 'start' });
        break;
      case 'estop': {
        // 北向 ESTOP 是独立带外报文（无 arm 概念，§2.1），非 MAVLink 的 force-disarm。
        // 浏览器现只发触发；on:false / clear:true 预留解除（解除后车不自动跑，须重发 MODE/MISSION）。
        this._cmd('ESTOP', { on: !(m.on === false || m.clear === true) });
        break;
      }
      case 'uploadMission': {   // -> WP 航点表（§2.3）；alt 丢弃（地面车），spd/r 走全局参数
        const pts = [];
        for (const it of (Array.isArray(m.items) ? m.items : [])) {
          if (!it || typeof it !== 'object') continue;
          const lat = num(it.lat), lon = num(it.lon);
          if (lat === null || lon === null) continue;
          pts.push({ lat, lon });
        }
        if (!pts.length) { this.log('north: uploadMission 无有效航点，忽略'); break; }
        this._cmd('WP', { pts });
        break;
      }
      case 'getParams': {       // -> 逐名 PARAM_REQ（§2.7）；带 id 但**无 ACK**（PARAM 流应答）-> 不入 pending
        for (const nRaw of (Array.isArray(m.names) ? m.names : [])) {
          const name = String(nRaw == null ? '' : nRaw).trim();
          if (name) this._cmd('PARAM_REQ', { name }, false);
        }
        break;
      }
      case 'setParam': {        // -> PARAM_SET（§2.7；车端钳位则 ACK result=clamped，msg 带实际采纳值）
        const name = String(m.id == null ? '' : m.id).trim();
        const value = num(m.value);
        if (!name || value === null) { this.log('north: setParam 参数无效，忽略'); break; }
        this._cmd('PARAM_SET', { name, value });
        break;
      }
      case 'changeSpeed': {     // 北向无 DO_CHANGE_SPEED -> 映射到巡航速度参数（docs/参数表.json guidance 组）
        const value = num(m.speed);
        if (value === null) { this.log('north: changeSpeed 速度无效，忽略'); break; }
        this._cmd('PARAM_SET', { name: 'CRUISE_SPEED', value });
        break;
      }
      case 'rc': {              // -> MANUAL 流式 twist（§2.6，无 id 无 ACK；仅 MANUAL 模式在车端生效）
        const steer = clamp1(num(m.steer, 0));
        const throttle = clamp1(num(m.throttle, 0));
        this._stream('MANUAL', { vx: throttle * this.vmax, wz: steer * this.wmax });
        break;
      }
      case 'rcRelease': this._stream('MANUAL', { vx: 0, wz: 0 }); break;   // 松手 = 零速（车端守卫兜底）
      case 'goto': {            // 制导前往单点：北向无 GUIDED -> WP 单点 + AUTO + start（等价「飞往此点」）。
        // 覆盖当前航点表（同 MAVLink guided divert）；ESTOP 闩锁下不会移动（失效保护仍在）。
        const lat = num(m.lat), lon = num(m.lon);
        if (lat === null || lon === null) { this._localText(4, 'goto 坐标无效，忽略'); break; }
        this._cmd('WP', { pts: [{ lat, lon }] });
        this._cmd('MODE', { mode: 'AUTO' });
        this._cmd('MISSION', { cmd: 'start' });
        break;
      }
      case 'arm': {             // 北向无独立 arm/disarm（§2.1 注，VCU 可能无 arm 概念）：
        if (m.arm === false) {  // 上锁/disarm = 软停到零速待命（MODE IDLE）——≠ 带外 ESTOP 的急停闩锁
          this._cmd('MODE', { mode: 'IDLE' });
          this._localText(6, '上锁 → 切 IDLE 零速待命（北向无 arm 概念；紧急停车请用急停 = ESTOP 带外闩锁）');
        } else {                // 解锁/arm：北向无使能闸，运动由 模式(AUTO/MANUAL)+任务 使能 -> 仅告知，不发帧
          this._localText(6, '北向无独立解锁：运动由 模式(AUTO/MANUAL)+任务 使能，无需先解锁');
        }
        break;
      }
      case 'rtl': {             // 返航：北向无 RTL 模式 -> 已知 Home 则合成 WP[Home]+AUTO+start，否则明确拒绝
        // （不静默）。Home 来源：显式 setHome（权威）或首个有效 POSE（推断起点）。避障=不做（同 WP/goto）。
        if (this.homeLat === null || this.homeLon === null) {
          this._localAck('rtl', 2, 'no-home');
          this._localText(4, '返航失败：未知返航点（请先「设置Home」或等定位固定后重试）');
          break;
        }
        this._cmd('WP', { pts: [{ lat: this.homeLat, lon: this.homeLon }] });
        this._cmd('MODE', { mode: 'AUTO' });
        this._cmd('MISSION', { cmd: 'start' });
        this._localText(6, '返航：前往 Home' + (this.homeExplicit ? '' : '（推断起点，未显式设置 Home）'));
        break;
      }
      case 'setHome': {         // 北向无 Home 下行帧 -> GCS 侧记录返航参考点（供 rtl 合成）。
        const lat = num(m.lat), lon = num(m.lon);
        if (lat === null || lon === null) { this._localText(4, '设置Home 坐标无效，忽略'); break; }
        this.homeLat = lat; this.homeLon = lon; this.homeExplicit = true;
        this.broadcast({ t: 'home', lat, lon });   // 落 🏠 标记（权威返航点）
        this._localAck('setHome', 0, 'home-set');
        this._localText(6, 'Home 已设置（GCS 侧返航参考点）：' + lat.toFixed(6) + ',' + lon.toFixed(6));
        break;
      }
      case 'uploadFence': {     // 地理围栏：北向 v1 无对应帧（契约 §8 预留 FENCE_*）。**绝不**映射到 FIELD
        // ——FIELD 是「待覆盖农田」，语义与「禁入/保持区」相反，误映射会让车去覆盖禁区（安全反模式）。
        // 明确结构化拒绝（text + ack rejected + 任务栏 fence 失败态），不静默、不伪造。
        this._localAck('uploadFence', 2, 'unsupported');
        this._localText(4, '北向 v1 暂无地理围栏（契约 §8 预留 FENCE_*）；围栏未上传');
        this.broadcast({ t: 'mission_uploaded', ok: false, result: 2, fence: true });
        break;
      }
      // ---- 其余真不支持（北向 v1 无对应语义/预留 LOG_* 见契约 §8）：no-op + 明确日志 ----
      default:
        this.log('north: unsupported command ' + m.t + '（MVP no-op）');
        break;
    }
  }

  // 带 id 命令帧：登记 pending 供 ACK 关联；expectAck=false（PARAM_REQ）不登记（§2 例外）。
  _cmd(type, fields, expectAck = true) {
    const id = this.nextId;
    this.nextId = ((this.nextId + 1) >>> 0) || 1;   // uint32 回绕，跳过 0
    if (expectAck) {
      this.pending.set(id, type);
      if (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.keys().next().value);
    }
    const frame = Object.assign({ t: type, id }, fields);
    if (!this.client || !this.client.send(frame)) this.log('north: 链路未连接，丢弃 ' + type);
    return id;
  }

  // 流式帧（MANUAL；HB 由定时器直发）：无 id / 无 ACK（§2.6/§2.8），掉线静默丢弃。
  _stream(type, fields) {
    if (this.client) this.client.send(Object.assign({ t: type }, fields));
  }

  // GCS 侧合成回浏览器（无车端往返）——用于北向 v1 无法映射 / GCS 本地处理的命令（rtl 拒绝、
  // setHome、arm 告知、uploadFence 拒绝）。result 沿用 MAV_RESULT 习惯（0 接受 / 2 拒绝）。
  _localText(severity, text) { this.broadcast({ t: 'text', severity, text }); }
  _localAck(command, result, msg) { this.broadcast({ t: 'ack', command, result, msg: msg || '' }); }
}

module.exports = { NorthBackend };
