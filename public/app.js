'use strict';
/* Rover Web GCS — browser frontend (MVP). Talks JSON over WebSocket to the bridge. */

// ----------------------------------------------------------------------------
// WebSocket
// ----------------------------------------------------------------------------
let ws = null, linkConnected = false;
function wsUrl() { return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host; }
function connectWS() {
  ws = new WebSocket(wsUrl());
  ws.onopen = () => { logLine('已连接到桥接服务', 'sys'); send({ t: 'status' }); };
  ws.onclose = () => { logLine('与桥接服务断开，2s后重连…', 'warn'); setLink(false); setTimeout(connectWS, 2000); };
  ws.onerror = () => {};
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (_) { return; } onMsg(m); };
}
function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

// ----------------------------------------------------------------------------
// Map
// ----------------------------------------------------------------------------
const map = L.map('map', { zoomControl: true, attributionControl: false }).setView([34, 108], 4);

// Bing tiles use a quadkey scheme (z/x/y -> quadkey). Chinese labels via mkt=zh-CN.
function toQuadKey(x, y, z) {
  let q = '';
  for (let i = z; i > 0; i--) { let d = 0; const m = 1 << (i - 1); if (x & m) d++; if (y & m) d += 2; q += d; }
  return q;
}
function bingLayer(type) { // 'a' aerial(卫星) | 'r' road(道路) | 'h' hybrid(卫星+标注)
  const ext = type === 'r' ? 'png' : 'jpeg';
  const subs = ['0', '1', '2', '3'];
  const layer = L.tileLayer('', { maxZoom: 19, subdomains: subs, attribution: 'Bing' });
  layer.getTileUrl = function (c) {
    const s = subs[(c.x + c.y) % subs.length];
    return 'https://ecn.t' + s + '.tiles.virtualearth.net/tiles/' + type + toQuadKey(c.x, c.y, c.z) + '.' + ext + '?g=1&mkt=zh-CN';
  };
  return layer;
}
function googleLayer(lyrs) { // m=道路 s=卫星 y=卫星+标注
  return L.tileLayer('https://mt{s}.google.com/vt/lyrs=' + lyrs + '&hl=zh-CN&gl=cn&x={x}&y={y}&z={z}',
    { subdomains: ['0', '1', '2', '3'], maxZoom: 20, attribution: 'Google' });
}

const baseLayers = {
  'Bing 道路(中文)': bingLayer('r'),
  'Bing 卫星': bingLayer('a'),
  'Bing 卫星+标注(中文)': bingLayer('h'),
  'Google 道路(中文)': googleLayer('m'),
  'Google 卫星': googleLayer('s'),
  'Google 卫星+标注(中文)': googleLayer('y'),
  'OSM 街道': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: 'OSM' }),
  'Esri 卫星': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Esri' }),
};
// Default: Bing road with Chinese labels (reachable on mainland China networks).
baseLayers['Bing 道路(中文)'].addTo(map);
L.control.layers(baseLayers, null, { position: 'topleft', collapsed: true }).addTo(map);

let vehMarker = null, vehTrail = L.polyline([], { color: '#36b35a', weight: 2, opacity: .8 }).addTo(map);
let homeMarker = null, firstFix = true;

function vehIcon() {
  return L.divIcon({ className: 'veh-icon', iconSize: [30, 30], iconAnchor: [15, 15],
    html: '<div class="veh-arrow" style="transform:rotate(0deg)">' +
      '<svg width="30" height="30" viewBox="0 0 30 30"><polygon points="15,2 25,27 15,21 5,27" ' +
      'fill="#36b35a" stroke="#fff" stroke-width="1.5"/></svg></div>' });
}
function updateVehicle(lat, lon, hdg) {
  const ll = [lat, lon];
  if (!vehMarker) vehMarker = L.marker(ll, { icon: vehIcon(), zIndexOffset: 1000 }).addTo(map);
  else vehMarker.setLatLng(ll);
  const el = vehMarker.getElement(); if (el) { const a = el.querySelector('.veh-arrow'); if (a) a.style.transform = 'rotate(' + (hdg || 0) + 'deg)'; }
  vehTrail.addLatLng(ll);
  if (firstFix) { firstFix = false; map.setView(ll, 17); }
}
function updateHome(lat, lon) {
  if (!homeMarker) homeMarker = L.marker([lat, lon], { icon: L.divIcon({ className: '', html: '<div class="home-marker">🏠</div>', iconSize: [20, 20], iconAnchor: [10, 10] }) }).addTo(map);
  else homeMarker.setLatLng([lat, lon]);
}

// ----------------------------------------------------------------------------
// Mission (waypoints)
// ----------------------------------------------------------------------------
let addMode = false;
const wps = [];                 // {lat, lon, marker}
const missionLine = L.polyline([], { color: '#2e9e4f', weight: 2, dashArray: '6,6' }).addTo(map);

function wpIcon(n) { return L.divIcon({ className: '', html: '<div class="wp-marker">' + n + '</div>', iconSize: [24, 24], iconAnchor: [12, 12] }); }
function redrawMission() {
  missionLine.setLatLngs(wps.map((w) => [w.lat, w.lon]));
  wps.forEach((w, i) => { if (w.marker) w.marker.setIcon(wpIcon(i + 1)); });
  const list = document.getElementById('wpList'); list.innerHTML = '';
  wps.forEach((w, i) => {
    const row = document.createElement('div'); row.className = 'wp';
    row.innerHTML = '<span class="n">' + (i + 1) + '</span><span class="c">' + w.lat.toFixed(6) + ', ' + w.lon.toFixed(6) + '</span><span class="x" data-i="' + i + '">✕</span>';
    list.appendChild(row);
  });
}
function addWaypoint(lat, lon) {
  const w = { lat, lon };
  w.marker = L.marker([lat, lon], { icon: wpIcon(wps.length + 1), draggable: true }).addTo(map);
  w.marker.on('drag', (e) => { const p = e.target.getLatLng(); w.lat = p.lat; w.lon = p.lng; redrawMission(); });
  wps.push(w); redrawMission();
}
function clearMission() { wps.forEach((w) => w.marker && map.removeLayer(w.marker)); wps.length = 0; redrawMission(); }
document.getElementById('wpList').addEventListener('click', (e) => {
  const i = e.target.getAttribute && e.target.getAttribute('data-i');
  if (i !== null && i !== undefined) { const idx = +i; if (wps[idx]) { map.removeLayer(wps[idx].marker); wps.splice(idx, 1); redrawMission(); } }
});

map.on('click', (e) => {
  if (fenceDrawMode) { addFenceVertex(e.latlng.lat, e.latlng.lng); return; }
  if (e.originalEvent && e.originalEvent.shiftKey) {
    if (!linkConnected) return logLine('未连接，无法 Goto', 'warn');
    send({ t: 'goto', lat: e.latlng.lat, lon: e.latlng.lng });
    logLine('引导前往 ' + e.latlng.lat.toFixed(6) + ', ' + e.latlng.lng.toFixed(6), 'info');
    return;
  }
  if (addMode) addWaypoint(e.latlng.lat, e.latlng.lng);
});

// ----------------------------------------------------------------------------
// Incoming messages
// ----------------------------------------------------------------------------
function onMsg(m) {
  switch (m.t) {
    case 'snapshot': setLink(m.connected); if (m.vehicle) applyVehicle(m.vehicle); break;
    case 'link': setLink(m.connected); if (m.error) logLine('连接失败: ' + m.error, 'err'); if (m.transport) logLine('链路: ' + m.transport, 'sys'); break;
    case 'hb': setMode(m.modeName); setArmed(m.armed); break;
    case 'pos':
      setText('tGs', (m.gs != null ? m.gs.toFixed(1) : '--') + ' m/s');
      setText('tHdg', Math.round(m.hdg) + '°'); setText('tLat', m.lat.toFixed(6)); setText('tLon', m.lon.toFixed(6));
      updateVehicle(m.lat, m.lon, m.hdg); break;
    case 'gps':
      setText('tFix', fixName(m.fixType)); setText('tSats', m.sats);
      setText('vGps', fixName(m.fixType) + '/' + m.sats); break;
    case 'sys':
      setText('tVolt', m.battV.toFixed(2) + ' V'); setText('tPct', (m.battPct < 0 ? '--' : m.battPct + '%'));
      setText('vBatt', m.battV.toFixed(1) + 'V ' + (m.battPct < 0 ? '' : m.battPct + '%'));
      lowBattCheck(m.battPct); break;
    case 'vfr': if (m.gs != null) setText('tGs', m.gs.toFixed(1) + ' m/s'); break;
    case 'radio': setText('tRssi', m.rssi + '/' + m.remrssi); break;
    case 'param': onParam(m); break;
    case 'tlog':
      tlogRecording = m.recording;
      setText('tlogHint', m.recording ? '记录中: ' + m.file : '已保存: ' + (m.file || '--'));
      const tb = document.getElementById('btnTlog'); tb.textContent = m.recording ? '⏹ 停止记录' : '⏺ 开始记录(.tlog)';
      tb.classList.toggle('danger', m.recording); break;
    case 'home': updateHome(m.lat, m.lon); logLine('收到 Home 位置', 'sys'); break;
    case 'text': logLine('FC: ' + m.text, sevClass(m.severity)); break;
    case 'ack': logLine('命令ACK: cmd=' + m.command + ' result=' + ackName(m.result), m.result === 0 ? 'info' : 'warn'); break;
    case 'mission_uploaded': { const w = m.fence ? '围栏' : '任务'; logLine(m.ok ? '✓ ' + w + '上传成功' : '✗ ' + w + '上传被拒(type=' + m.result + ')', m.ok ? 'info' : 'err'); break; }
    case 'fence_status': {
      const el = document.getElementById('fenceBreach');
      if (m.breach) { el.textContent = '⚠ 越界!'; el.className = 'v armed'; }
      else { el.textContent = '正常'; el.className = 'v disarmed'; } break;
    }
    case 'mission_list': loadDownloadedMission(m.items); break;
    case 'mission_current': setText('tMode', getText('tMode')); break;
    case 'mission_reached': logLine('已到达航点 #' + m.seq, 'info'); break;
    case 'stale': setLinkStale(); break;
    case 'log': logLine(m.msg, 'sys'); break;
    default: break;
  }
}
function applyVehicle(v) { if (v.modeName) setMode(v.modeName); setArmed(v.armed); }
function loadDownloadedMission(items) {
  clearMission();
  items.forEach((it) => addWaypoint(it.lat, it.lon));
  logLine('已下载任务: ' + items.length + ' 个航点', 'info');
  if (items.length) map.fitBounds(missionLine.getBounds().pad(0.3));
}

// ----------------------------------------------------------------------------
// UI helpers
// ----------------------------------------------------------------------------
function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
function getText(id) { const el = document.getElementById(id); return el ? el.textContent : ''; }
function setMode(name) { setText('tMode', name || '--'); setText('vMode', name || '--'); }
function setArmed(armed) {
  const t = armed ? '已武装' : '已上锁', cls = armed ? 'armed' : 'disarmed';
  const a = document.getElementById('tArmed'); a.textContent = t; a.className = 'v ' + cls;
  const b = document.getElementById('vArmed'); b.textContent = armed ? 'ARMED' : 'SAFE'; b.className = cls;
}
function setLink(on) {
  linkConnected = on;
  const dot = document.getElementById('linkDot'), txt = document.getElementById('linkText'), btn = document.getElementById('btnConn');
  dot.className = 'dot' + (on ? ' on' : ''); txt.textContent = on ? '已连接' : '未连接';
  btn.textContent = on ? '断开' : '连接'; btn.className = on ? '' : 'primary';
  if (!on) { firstFix = true; }
}
function setLinkStale() { const dot = document.getElementById('linkDot'); dot.className = 'dot stale'; document.getElementById('linkText').textContent = '信号中断?'; }
function fixName(f) { return ['无定位', '无定位', '2D', '3D', 'DGPS', 'RTK浮动', 'RTK固定'][f] || ('fix' + f); }
function sevClass(s) { return s <= 3 ? 'err' : (s === 4 ? 'warn' : 'info'); }
function ackName(r) { return ({ 0: 'ACCEPTED', 1: 'TEMP_REJECT', 2: 'DENIED', 3: 'UNSUPPORTED', 4: 'FAILED', 5: 'IN_PROGRESS' })[r] || r; }
function logLine(msg, cls) {
  const log = document.getElementById('log'); const d = document.createElement('div');
  d.className = 's-' + (cls || 'info'); d.textContent = msg; log.appendChild(d);
  while (log.childNodes.length > 200) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

// ----------------------------------------------------------------------------
// Controls wiring
// ----------------------------------------------------------------------------
function guard() { if (!linkConnected) { logLine('请先连接飞控', 'warn'); return false; } return true; }

document.getElementById('transport').addEventListener('change', (e) => {
  for (const k of ['udp', 'tcp', 'serial']) document.getElementById('f-' + k).style.display = (e.target.value === k ? '' : 'none');
});
document.getElementById('btnConn').addEventListener('click', () => {
  if (linkConnected) { send({ t: 'disconnect' }); return; }
  const tr = document.getElementById('transport').value;
  const cfg = { t: 'connect', transport: tr };
  if (tr === 'udp') cfg.listen = document.getElementById('udpListen').value;
  else if (tr === 'tcp') { cfg.host = document.getElementById('tcpHost').value; cfg.port = document.getElementById('tcpPort').value; }
  else { cfg.path = document.getElementById('serPath').value; cfg.baud = document.getElementById('serBaud').value; }
  saveSettings(); send(cfg); logLine('正在连接 (' + tr + ')…', 'sys');
});

document.getElementById('btnArm').addEventListener('click', () => { if (guard()) { send({ t: 'arm', arm: true }); logLine('发送: 解锁', 'info'); } });
document.getElementById('btnDisarm').addEventListener('click', () => { if (guard()) { send({ t: 'arm', arm: false }); logLine('发送: 上锁', 'info'); } });
document.getElementById('btnSetMode').addEventListener('click', () => { if (guard()) { const mode = document.getElementById('modeSel').value; send({ t: 'mode', mode }); logLine('发送: 模式 ' + mode, 'info'); } });
document.getElementById('btnRtl').addEventListener('click', () => { if (guard()) { send({ t: 'rtl' }); logLine('发送: 返航 RTL', 'info'); } });
document.getElementById('btnStart').addEventListener('click', startMission);
document.getElementById('btnStart2').addEventListener('click', startMission);
function startMission() { if (guard()) { send({ t: 'startMission' }); logLine('发送: 启动任务 (AUTO)', 'info'); } }
document.getElementById('btnEstop').addEventListener('click', () => {
  if (!guard()) return;
  if (confirm('确认急停？将强制上锁（电机立即停止）。')) { send({ t: 'estop' }); logLine('⛔ 发送: 急停 (强制上锁)', 'err'); }
});

document.getElementById('btnAdd').addEventListener('click', (e) => {
  addMode = !addMode; e.target.classList.toggle('addmode', addMode);
  e.target.textContent = addMode ? '✓ 点击地图压点' : '✏️ 添加航点';
  document.getElementById('hint').textContent = addMode ? '添加航点模式：点击地图压点，拖动可微调，✕ 删除。完成后点「上传任务」。' :
    '提示：开启「添加航点」后点击地图压点；Shift+点击地图 = 引导前往(Guided Goto)。';
});
document.getElementById('btnUpload').addEventListener('click', () => {
  if (!guard()) return;
  if (!wps.length) return logLine('没有航点可上传', 'warn');
  const alt = parseFloat(document.getElementById('defAlt').value) || 0;
  send({ t: 'uploadMission', items: wps.map((w) => ({ lat: w.lat, lon: w.lon, alt })) });
  logLine('发送: 上传 ' + wps.length + ' 个航点…', 'info');
});
document.getElementById('btnDownload').addEventListener('click', () => { if (guard()) { send({ t: 'downloadMission' }); logLine('发送: 下载任务…', 'info'); } });
document.getElementById('btnClear').addEventListener('click', () => { clearMission(); logLine('已清空本地航点', 'sys'); });

// ----- change speed / pause / skip -----
document.getElementById('btnPause').addEventListener('click', () => { if (guard()) { send({ t: 'pause' }); logLine('发送: 暂停 (HOLD)', 'info'); } });
document.getElementById('btnSpeed').addEventListener('click', () => {
  if (!guard()) return; const s = parseFloat(document.getElementById('spd').value);
  if (!isFinite(s) || s <= 0) return logLine('速度无效', 'warn');
  send({ t: 'changeSpeed', speed: s }); logLine('发送: 改速 ' + s + ' m/s', 'info');
});
document.getElementById('btnSkip').addEventListener('click', () => {
  if (!guard()) return; const v = prompt('跳到第几个航点 (seq)?', '1'); if (v === null) return;
  const seq = parseInt(v, 10); if (!isFinite(seq)) return;
  send({ t: 'setCurrent', seq }); logLine('发送: 跳到航点 #' + seq, 'info');
});

// ----- operator parameters (whitelist) -----
const PARAM_WHITELIST = [
  ['CRUISE_SPEED', '巡航速度 m/s'], ['WP_SPEED', '任务速度 m/s (0=巡航)'], ['WP_RADIUS', '航点到达半径 m'],
  ['TURN_MAX_G', '最大转弯 G'], ['FS_GCS_ENABLE', '地面站失联保护'], ['FS_TIMEOUT', '失联超时 s'],
  ['FS_ACTION', '失效动作'], ['BATT_LOW_VOLT', '低电压阈值 V'],
];
const paramInputs = {};
(function buildParamRows() {
  const box = document.getElementById('paramList');
  PARAM_WHITELIST.forEach(([id, label]) => {
    const row = document.createElement('div'); row.className = 'wp';
    const n = document.createElement('span'); n.className = 'c'; n.style.flex = '1.4'; n.title = id;
    n.textContent = label; row.appendChild(n);
    const inp = document.createElement('input'); inp.className = 'num'; inp.type = 'number'; inp.step = 'any';
    inp.style.width = '74px'; inp.disabled = true; paramInputs[id] = inp; row.appendChild(inp);
    const b = document.createElement('button'); b.textContent = '写入'; b.style.padding = '3px 8px';
    b.addEventListener('click', () => {
      if (!guard()) return; const val = parseFloat(inp.value);
      if (!isFinite(val)) return logLine('参数值无效', 'warn');
      if (!confirm('确认写入 ' + id + ' = ' + val + ' ?')) return;
      send({ t: 'setParam', id, value: val }); logLine('发送: 设参数 ' + id + '=' + val, 'info');
    });
    row.appendChild(b); box.appendChild(row);
  });
})();
function onParam(m) {
  const inp = paramInputs[m.id]; if (inp) { inp.disabled = false; inp.value = (Math.round(m.value * 1000) / 1000); }
  setText('paramHint', '已读取 ' + m.id);
}
document.getElementById('btnParamsRead').addEventListener('click', () => {
  if (!guard()) return; send({ t: 'getParams', names: PARAM_WHITELIST.map((p) => p[0]) });
  setText('paramHint', '读取中…'); logLine('发送: 读取操作员参数', 'info');
});

// ----- low battery alert -----
let lowBattAlerted = false;
function lowBattCheck(pct) {
  if (pct >= 0 && pct < 20 && !lowBattAlerted) { lowBattAlerted = true; beep(); logLine('⚠ 电量低: ' + pct + '%', 'warn'); }
  if (pct >= 25) lowBattAlerted = false;
}
function beep() {
  try { const a = new (window.AudioContext || window.webkitAudioContext)(); const o = a.createOscillator(), g = a.createGain();
    o.connect(g); g.connect(a.destination); o.frequency.value = 880; g.gain.value = 0.12; o.start(); o.stop(a.currentTime + 0.3); } catch (_) {}
}

// ----- mission file save / load (.waypoints, QGC WPL 110) -----
document.getElementById('btnSaveWp').addEventListener('click', () => {
  if (!wps.length) return logLine('无航点可保存', 'warn');
  const alt = parseFloat(document.getElementById('defAlt').value) || 0;
  const lines = ['QGC WPL 110'];
  lines.push([0, 1, 0, 16, 0, 0, 0, 0, wps[0].lat, wps[0].lon, 0, 1].join('\t')); // home placeholder
  wps.forEach((w, i) => lines.push([i + 1, 0, 3, 16, 0, 0, 0, 0, w.lat, w.lon, alt, 1].join('\t')));
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = 'mission.waypoints'; a.click();
  logLine('已保存航点文件 (' + wps.length + ' 点)', 'info');
});
document.getElementById('btnLoadWp').addEventListener('click', () => document.getElementById('fileWp').click());
document.getElementById('fileWp').addEventListener('change', (e) => {
  const f = e.target.files[0]; if (!f) return; const r = new FileReader();
  r.onload = () => { loadWaypoints(String(r.result)); e.target.value = ''; }; r.readAsText(f);
});
function loadWaypoints(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!/^QGC WPL/.test(lines[0] || '')) return logLine('文件不是 .waypoints 格式', 'err');
  clearMission();
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(/\t/); if (c.length < 11) continue;
    const seq = +c[0], lat = +c[8], lon = +c[9];
    if (seq === 0) continue;
    if (!isFinite(lat) || !isFinite(lon) || (lat === 0 && lon === 0)) continue;
    addWaypoint(lat, lon);
  }
  logLine('已读取航点文件: ' + wps.length + ' 点', 'info');
  if (wps.length) map.fitBounds(missionLine.getBounds().pad(0.3));
}

// ----- KML field boundary import -----
let boundaryLayer = null;
document.getElementById('btnLoadKml').addEventListener('click', () => document.getElementById('fileKml').click());
document.getElementById('fileKml').addEventListener('change', (e) => {
  const f = e.target.files[0]; if (!f) return; const r = new FileReader();
  r.onload = () => { loadKml(String(r.result)); e.target.value = ''; }; r.readAsText(f);
});
function loadKml(text) {
  let doc; try { doc = new DOMParser().parseFromString(text, 'text/xml'); } catch (_) { return logLine('KML 解析失败', 'err'); }
  const el = doc.querySelector('Polygon coordinates') || doc.querySelector('LineString coordinates') || doc.querySelector('coordinates');
  if (!el) return logLine('KML 未找到坐标', 'err');
  const pts = el.textContent.trim().split(/\s+/).map((s) => s.split(',')).filter((a) => a.length >= 2)
    .map((a) => [parseFloat(a[1]), parseFloat(a[0])]).filter((p) => isFinite(p[0]) && isFinite(p[1]));
  if (!pts.length) return logLine('KML 坐标为空', 'err');
  if (boundaryLayer) map.removeLayer(boundaryLayer);
  boundaryLayer = L.polygon(pts, { color: '#e0a800', weight: 2, fillOpacity: 0.06, dashArray: '4,4' }).addTo(map);
  map.fitBounds(boundaryLayer.getBounds().pad(0.2));
  logLine('已导入 KML 田块边界: ' + pts.length + ' 顶点', 'info');
}

// ----- tlog recording -----
let tlogRecording = false;
document.getElementById('btnTlog').addEventListener('click', () => {
  if (!linkConnected && !tlogRecording) return logLine('请先连接飞控再记录', 'warn');
  send({ t: tlogRecording ? 'tlogStop' : 'tlogStart' });
});

// ----- offline map cache -----
let currentBase = baseLayers['Bing 道路(中文)'];
map.on('baselayerchange', (e) => { currentBase = e.layer; });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
document.getElementById('btnCacheMap').addEventListener('click', async () => {
  const layer = currentBase; if (!layer || !layer.getTileUrl) return logLine('当前图层不支持缓存', 'warn');
  const z0 = map.getZoom(), b = map.getBounds(); const urls = [];
  for (let z = z0; z <= Math.min(z0 + 2, 18); z++) {
    const nw = map.project(b.getNorthWest(), z).divideBy(256).floor();
    const se = map.project(b.getSouthEast(), z).divideBy(256).floor();
    for (let x = nw.x; x <= se.x; x++) for (let y = nw.y; y <= se.y; y++) {
      try { const u = layer.getTileUrl({ x, y, z }); if (u) urls.push(u); } catch (_) {}
      if (urls.length > 2000) break;
    }
  }
  setText('cacheHint', '缓存 0/' + urls.length);
  let done = 0;
  for (let i = 0; i < urls.length; i += 8) {
    await Promise.all(urls.slice(i, i + 8).map((u) => fetch(u, { mode: 'no-cors' }).then(() => {}).catch(() => {})));
    done = Math.min(i + 8, urls.length); setText('cacheHint', '缓存 ' + done + '/' + urls.length);
  }
  setText('cacheHint', '✓ 已缓存 ' + urls.length + ' 瓦片'); logLine('离线地图: 已缓存 ' + urls.length + ' 瓦片', 'info');
});

// ----- settings persistence (connection form) -----
function saveSettings() {
  const s = { transport: document.getElementById('transport').value, udpListen: document.getElementById('udpListen').value,
    tcpHost: document.getElementById('tcpHost').value, tcpPort: document.getElementById('tcpPort').value,
    serPath: document.getElementById('serPath').value, serBaud: document.getElementById('serBaud').value };
  try { localStorage.setItem('rover_gcs_conn', JSON.stringify(s)); } catch (_) {}
}
(function restoreSettings() {
  let s; try { s = JSON.parse(localStorage.getItem('rover_gcs_conn') || '{}'); } catch (_) { s = {}; }
  for (const k of ['transport', 'udpListen', 'tcpHost', 'tcpPort', 'serPath', 'serBaud']) {
    if (s[k] != null && document.getElementById(k)) document.getElementById(k).value = s[k];
  }
  document.getElementById('transport').dispatchEvent(new Event('change'));
})();

// ----- geofence -----
let fenceDrawMode = null, fenceTempPts = [], fenceTempLayer = null;
const fences = [];
function startFenceDraw(kind) {
  if (addMode) document.getElementById('btnAdd').click(); // turn off waypoint add
  fenceDrawMode = kind; fenceTempPts = [];
  if (fenceTempLayer) { map.removeLayer(fenceTempLayer); fenceTempLayer = null; }
  setText('hint', '画' + (kind === 'inc' ? '包含区(keep-in)' : '排除区(keep-out)') + '：点击地图加顶点 → 点「完成」闭合（≥3 点）。');
  document.getElementById('hint').style.display = '';
  logLine('围栏绘制: ' + (kind === 'inc' ? '包含区' : '排除区'), 'sys');
}
function addFenceVertex(lat, lon) {
  fenceTempPts.push([lat, lon]);
  const color = fenceDrawMode === 'exc' ? '#e5484d' : '#2e9e4f';
  if (fenceTempLayer) map.removeLayer(fenceTempLayer);
  fenceTempLayer = L.polygon(fenceTempPts, { color, weight: 2, dashArray: '4,4', fillOpacity: 0.05 }).addTo(map);
}
function finishFence() {
  if (!fenceDrawMode) return;
  if (fenceTempPts.length < 3) return logLine('围栏至少需要 3 个顶点', 'warn');
  const color = fenceDrawMode === 'exc' ? '#e5484d' : '#2e9e4f';
  const layer = L.polygon(fenceTempPts.slice(), { color, weight: 2, fillOpacity: 0.08 }).addTo(map);
  fences.push({ kind: fenceDrawMode, pts: fenceTempPts.slice(), layer });
  logLine('已添加' + (fenceDrawMode === 'exc' ? '排除' : '包含') + '围栏 (' + fenceTempPts.length + ' 顶点)', 'info');
  if (fenceTempLayer) { map.removeLayer(fenceTempLayer); fenceTempLayer = null; }
  fenceTempPts = []; fenceDrawMode = null;
}
function clearFences() {
  fences.forEach((f) => map.removeLayer(f.layer)); fences.length = 0;
  if (fenceTempLayer) { map.removeLayer(fenceTempLayer); fenceTempLayer = null; }
  fenceTempPts = []; fenceDrawMode = null; setText('fenceBreach', '--'); logLine('已清空围栏', 'sys');
}
document.getElementById('btnFenceInc').addEventListener('click', () => startFenceDraw('inc'));
document.getElementById('btnFenceExc').addEventListener('click', () => startFenceDraw('exc'));
document.getElementById('btnFenceDone').addEventListener('click', finishFence);
document.getElementById('btnFenceClear').addEventListener('click', clearFences);
document.getElementById('btnFenceUpload').addEventListener('click', () => {
  if (!guard()) return; if (!fences.length) return logLine('没有围栏可上传', 'warn');
  send({ t: 'uploadFence', items: fences.map((f) => ({ kind: f.kind, polygon: f.pts })) });
  logLine('发送: 上传围栏 (' + fences.length + ' 个多边形)', 'info');
});
document.getElementById('btnFenceOn').addEventListener('click', () => { if (guard()) { send({ t: 'fenceEnable', on: true }); logLine('发送: 启用围栏', 'info'); } });
document.getElementById('btnFenceOff').addEventListener('click', () => { if (guard()) { send({ t: 'fenceEnable', on: false }); logLine('发送: 停用围栏', 'info'); } });

// ----- joystick / keyboard manual control -----
let joyOn = false, joyTimer = null; const keys = {};
function dz(v) { return Math.abs(v) < 0.08 ? 0 : v; }
function clamp1(v) { return Math.max(-1, Math.min(1, v)); }
function joyEnable(on) {
  joyOn = on; const b = document.getElementById('btnJoy');
  b.textContent = on ? '⏹ 停止遥控' : '🎮 启用遥控'; b.classList.toggle('danger', on);
  if (on) {
    if (linkConnected) send({ t: 'mode', mode: 'MANUAL' });
    joyTimer = setInterval(joyTick, 66); logLine('遥控开启 (切 MANUAL，请确保已解锁)', 'info');
  } else {
    clearInterval(joyTimer); joyTimer = null; Object.keys(keys).forEach((k) => keys[k] = false);
    if (linkConnected) send({ t: 'rcRelease' }); setText('joySteer', '0.00'); setText('joyThr', '0.00'); logLine('遥控关闭', 'sys');
  }
}
function joyTick() {
  let steer = 0, throttle = 0;
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const gp = pads && pads[0];
  if (gp) { steer = dz(gp.axes[0] || 0); throttle = -dz(gp.axes[1] || 0); }
  if (keys.a) steer = -1; if (keys.d) steer = 1; if (keys.w) throttle = 1; if (keys.s) throttle = -1;
  steer = clamp1(steer); throttle = clamp1(throttle);
  setText('joySteer', steer.toFixed(2)); setText('joyThr', throttle.toFixed(2));
  if (linkConnected) send({ t: 'rc', steer, throttle });
}
document.addEventListener('keydown', (e) => {
  if (!joyOn) return; const k = (e.key || '').toLowerCase();
  if (['w', 'a', 's', 'd'].includes(k)) { keys[k] = true; e.preventDefault(); }
  if (k === ' ' || e.code === 'Space') { if (linkConnected) send({ t: 'estop' }); joyEnable(false); logLine('⛔ 键盘急停', 'err'); e.preventDefault(); }
});
document.addEventListener('keyup', (e) => { const k = (e.key || '').toLowerCase(); if (['w', 'a', 's', 'd'].includes(k)) keys[k] = false; });
document.getElementById('btnJoy').addEventListener('click', () => { if (!joyOn && !linkConnected) return logLine('请先连接飞控', 'warn'); joyEnable(!joyOn); });
window.addEventListener('gamepadconnected', () => logLine('手柄已连接', 'info'));

connectWS();
