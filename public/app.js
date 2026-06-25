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
      setText('vBatt', m.battV.toFixed(1) + 'V ' + (m.battPct < 0 ? '' : m.battPct + '%')); break;
    case 'vfr': if (m.gs != null) setText('tGs', m.gs.toFixed(1) + ' m/s'); break;
    case 'home': updateHome(m.lat, m.lon); logLine('收到 Home 位置', 'sys'); break;
    case 'text': logLine('FC: ' + m.text, sevClass(m.severity)); break;
    case 'ack': logLine('命令ACK: cmd=' + m.command + ' result=' + ackName(m.result), m.result === 0 ? 'info' : 'warn'); break;
    case 'mission_uploaded': logLine(m.ok ? '✓ 任务上传成功' : '✗ 任务上传被拒(type=' + m.result + ')', m.ok ? 'info' : 'err'); break;
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
  send(cfg); logLine('正在连接 (' + tr + ')…', 'sys');
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

connectWS();
