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

// ---- Basemaps: ONLY WGS-84-aligned sources are offered (no coordinate conversion) ----
// Why: the vehicle GPS / MAVLink are WGS-84. Chinese map providers (Bing/Google road,
// and their China satellite endpoints) serve GCJ-02 ("火星坐标") *shifted* tiles. With a
// shifted basemap, clicking the imagery returns a TRUE WGS-84 coordinate that is offset by
// ~hundreds of metres from the feature you see — so waypoints / goto land in the wrong
// place (exactly the "rover didn't follow my waypoints" bug). Since we do NOT do GCJ-02
// correction, we keep ONLY basemaps that are already WGS-84 in China, so map clicks map
// 1:1 to GPS coordinates. Removed: Bing 道路/卫星/卫星+标注, Google 道路/卫星/卫星+标注.
const esriImagery = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  { maxZoom: 19, attribution: 'Esri World Imagery · WGS-84' });
const osmStreet = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  { maxZoom: 19, attribution: 'OpenStreetMap · WGS-84' });
// transparent place-name labels, also WGS-84 → aligns with the imagery above
const esriPlaces = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
  { maxZoom: 19, attribution: 'Esri Reference · WGS-84' });

const baseLayers = {
  '卫星 (Esri · WGS-84)': esriImagery,
  '街道 (OSM · WGS-84)': osmStreet,
};
const overlayLayers = { '地名注记 (WGS-84)': esriPlaces };

// 天地图 (Tianditu) — 官方基准面 CGCS2000，与 WGS-84 在导航尺度上等价（厘米级差异），
// 不施加 GCJ-02 偏移 → 与 Esri/OSM 同属"真坐标"，点图压航点 1:1 对应 GPS。
// 需注册的 tk 密钥（由 config.js 注入 window.TIANDITU_TK）。用 _w (Web Mercator) 切片配合 Leaflet。
const TIANDITU_TK = (typeof window !== 'undefined' && window.TIANDITU_TK) ? String(window.TIANDITU_TK) : '';
if (TIANDITU_TK) {
  const tdt = (t) => L.tileLayer(
    'https://t{s}.tianditu.gov.cn/DataServer?T=' + t + '&x={x}&y={y}&l={z}&tk=' + TIANDITU_TK,
    { subdomains: '01234567', maxNativeZoom: 18, maxZoom: 19, attribution: '天地图 · CGCS2000≈WGS-84' });
  baseLayers['天地图·卫星(中文)'] = L.layerGroup([tdt('img_w'), tdt('cia_w')]); // 影像 + 中文注记
  baseLayers['天地图·街道(中文)'] = L.layerGroup([tdt('vec_w'), tdt('cva_w')]); // 矢量 + 中文注记
  logLine('天地图图层已启用 (CGCS2000≈WGS-84，无 GCJ-02 偏移)', 'sys');
} else {
  logLine('天地图未启用：先用 scripts/set-tianditu-key.sh 设置 tk 密钥', 'sys');
}
// Default: WGS-84 satellite imagery — clicks correspond 1:1 to GPS, no offset.
esriImagery.addTo(map);
L.control.layers(baseLayers, overlayLayers, { position: 'topleft', collapsed: true }).addTo(map);

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
// Map interaction modes — exactly one active at a time (QGC-style explicit tool)
// ----------------------------------------------------------------------------
let mapMode = null; // 'plan' | 'goto' | 'field' | 'fenceInc' | 'fenceExc' | null
const MODE_INFO = {
  plan:     { btn: 'btnAdd',      cls: 'm-plan',  txt: '✏️ 规划航点：点击地图依次添加航点 · 拖动微调 · ✕ 删除 · 完成后点「⬆ 上传任务」' },
  goto:     { btn: 'btnGoto',     cls: 'm-goto',  txt: '🎯 去这里：点击地图，将该点作为单点任务发送并启动' },
  field:    { btn: 'btnDrawField', cls: 'm-field', txt: '🌾 绘制田块：依次点击边界顶点，至少 3 点；完成后点「闭合田块」' },
  fenceInc: { btn: 'btnFenceInc', cls: 'm-fence', txt: '▰ 画包含区(keep-in)：点击地图加顶点 → 点「✓ 完成」闭合（≥3 点）' },
  fenceExc: { btn: 'btnFenceExc', cls: 'm-fence', txt: '▱ 画排除区(keep-out)：点击地图加顶点 → 点「✓ 完成」闭合（≥3 点）' },
};
function setMapMode(mode) {
  if (mode === mapMode) mode = null;                 // clicking the active tool exits it
  if (mapMode && mapMode.indexOf('fence') === 0 && mode !== mapMode) cancelFenceDraw(); // discard half-drawn fence
  mapMode = mode;
  Object.values(MODE_INFO).forEach((i) => { const b = document.getElementById(i.btn); if (b) b.classList.remove('active'); });
  const banner = document.getElementById('mapMode'), mapEl = document.getElementById('map');
  if (mapMode && MODE_INFO[mapMode]) {
    const info = MODE_INFO[mapMode];
    const b = document.getElementById(info.btn); if (b) b.classList.add('active');
    document.getElementById('mapModeText').textContent = info.txt;
    banner.className = 'mapmode ' + info.cls;
    mapEl.classList.add('crosshair');
    if (mapMode.indexOf('fence') === 0) beginFenceDraw();
  } else {
    banner.className = 'mapmode hidden';
    mapEl.classList.remove('crosshair');
  }
}

// ----- mission lifecycle status pill -----
const MSTATE = { none: '未规划', plan: '规划中', preview: '待批准', uploaded: '已上传', running: '执行中', done: '已完成' };
let coverageUploadPending = false, coverageMissionReady = false;
function setCoverageActions(canUpload, canStart) {
  const upload = document.getElementById('btnF2cUpload');
  const start = document.getElementById('btnF2cStart');
  if (upload) upload.disabled = !canUpload;
  if (start) start.disabled = !canStart;
}
function setMissionState(s) { const el = document.getElementById('missionState'); if (el) { el.textContent = MSTATE[s] || s; el.className = 'mst mst-' + s; } }
function getMissionState() { const el = document.getElementById('missionState'); return el ? el.className.replace(/^mst mst-/, '') : 'none'; }
function markPlanDirty() {
  coverageMissionReady = false; setCoverageActions(!!planPreview && planPreview.src === 'coverage', false);
  setMissionState(wps.length ? 'plan' : 'none');
} // local edit ⇒ no longer matches vehicle

const wps = [];                 // {lat, lon, marker}
const missionLine = L.polyline([], { color: '#2e9e4f', weight: 2, dashArray: '6,6' }).addTo(map);
const missionReverseLine = L.polyline([], { color: '#f0a93b', weight: 4, opacity: .95 }).addTo(map);

// Keep every trajectory sample in the polyline and in the uploaded mission,
// but draw only representative numbered markers.  Direction/section changes
// are always retained so fish-tail cusps remain obvious on the map.
function trajectoryMarkerIndices(items, regularMarkerLimit = 32) {
  const selected = new Set();
  if (!Array.isArray(items) || !items.length) return selected;
  const stride = Math.max(1, Math.ceil(items.length / regularMarkerLimit));
  selected.add(0); selected.add(items.length - 1);
  for (let i = 0; i < items.length; i += stride) selected.add(i);
  for (let i = 1; i < items.length; ++i) {
    const directionChanged = (items[i].dir || 1) !== (items[i - 1].dir || 1);
    const sectionChanged = items[i].section != null && items[i - 1].section != null &&
      items[i].section !== items[i - 1].section;
    if (directionChanged || sectionChanged) {
      selected.add(i - 1); selected.add(i);
    }
  }
  return selected;
}

function wpIcon(n) { return L.divIcon({ className: '', html: '<div class="wp-marker">' + n + '</div>', iconSize: [24, 24], iconAnchor: [12, 12] }); }
function redrawMission() {
  missionLine.setLatLngs(wps.map((w) => [w.lat, w.lon]));
  missionReverseLine.setLatLngs(wps.slice(1).flatMap((w, i) =>
    w.dir < 0 ? [[[wps[i].lat, wps[i].lon], [w.lat, w.lon]]] : []));
  wps.forEach((w, i) => { if (w.marker) w.marker.setIcon(wpIcon(i + 1)); });
  const list = document.getElementById('wpList'); list.innerHTML = '';
  wps.slice(0, 200).forEach((w, i) => {
    const row = document.createElement('div'); row.className = 'wp';
    const direction = w.dir < 0 ? '↙R ' : '';
    const dirControl = i === 0 ? '<span class="wp-dir origin" title="起点">起</span>'
      : '<button class="wp-dir ' + (w.dir < 0 ? 'reverse' : '') + '" data-dir-i="' + i +
        '" title="从上一点到此点的方向；点击切换">' + (w.dir < 0 ? '倒' : '前') + '</button>';
    row.innerHTML = '<span class="n">' + (i + 1) + '</span><span class="c">' + direction + w.lat.toFixed(6) + ', ' + w.lon.toFixed(6) + '</span>' + dirControl + '<span class="x" data-i="' + i + '">✕</span>';
    list.appendChild(row);
  });
  if (wps.length > 200) {
    const more = document.createElement('div'); more.className = 'lbl';
    more.textContent = '轨迹共 ' + wps.length + ' 点；列表只显示前 200 点，地图显示完整轨迹'; list.appendChild(more);
  }
  setText('wpCount', wps.length);
}
function addWaypoint(lat, lon, extra = {}) {
  const w = Object.assign({ lat, lon, dir: 1 }, extra, { lat, lon });
  const makeMarker = extra.renderMarker === true ||
    (extra.renderMarker !== false && wps.length < 250);
  if (makeMarker) {
    w.marker = L.marker([lat, lon], { icon: wpIcon(wps.length + 1), draggable: !w.planned }).addTo(map);
    if (!w.planned) w.marker.on('drag', (e) => { const p = e.target.getLatLng(); w.lat = p.lat; w.lon = p.lng; redrawMission(); markPlanDirty(); });
  }
  wps.push(w); redrawMission();
}
function clearMission() { wps.forEach((w) => w.marker && map.removeLayer(w.marker)); wps.length = 0; redrawMission(); }
document.getElementById('wpList').addEventListener('click', (e) => {
  const dirI = e.target.getAttribute && e.target.getAttribute('data-dir-i');
  if (dirI !== null && dirI !== undefined) {
    const idx = +dirI;
    if (wps[idx]) {
      wps[idx].dir = wps[idx].dir < 0 ? 1 : -1;
      delete wps[idx].speed;
      redrawMission(); markPlanDirty();
      logLine('第 ' + idx + ' 段改为' + (wps[idx].dir < 0 ? '倒车' : '前进') + '（航点 ' + idx + ' → ' + (idx + 1) + '）', 'info');
    }
    return;
  }
  const i = e.target.getAttribute && e.target.getAttribute('data-i');
  if (i !== null && i !== undefined) { const idx = +i; if (wps[idx]) { map.removeLayer(wps[idx].marker); wps.splice(idx, 1); redrawMission(); markPlanDirty(); } }
});

function doGoto(lat, lon) {
  if (!linkConnected) return logLine('未连接，无法前往', 'warn');
  send({ t: 'goto', lat, lon });
  logLine('🎯 引导前往 ' + lat.toFixed(6) + ', ' + lon.toFixed(6), 'info');
}
map.on('click', (e) => {
  const lat = e.latlng.lat, lon = e.latlng.lng;
  if (mapMode === 'plan') { addWaypoint(lat, lon); logLine('航点 #' + wps.length + ': ' + lat.toFixed(6) + ', ' + lon.toFixed(6), 'sys'); markPlanDirty(); return; }
  if (mapMode === 'goto') { doGoto(lat, lon); return; }
  if (mapMode === 'field') { addFieldVertex(lat, lon); return; }
  if (mapMode === 'fenceInc' || mapMode === 'fenceExc') { addFenceVertex(lat, lon); return; }
  if (e.originalEvent && e.originalEvent.shiftKey) doGoto(lat, lon); // power-user shortcut when no tool is active
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && mapMode) setMapMode(null); });

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
    case 'text': logLine('FC: ' + m.text, sevClass(m.severity)); if (/mission complete/i.test(m.text)) setMissionState('done'); break;
    case 'ack': logLine('命令ACK: cmd=' + m.command + ' result=' + ackName(m.result), m.result === 0 ? 'info' : 'warn'); break;
    case 'mission_uploaded': {
      const w = m.fence ? '围栏' : '任务';
      logLine(m.ok ? '✓ ' + w + '上传成功' : '✗ ' + w + '上传被拒(type=' + m.result + ')', m.ok ? 'info' : 'err');
      if (!m.fence && coverageUploadPending) {
        coverageUploadPending = false;
        coverageMissionReady = !!m.ok;
        setCoverageActions(!m.ok && wps.some((p) => p.planned), !!m.ok);
        setText('f2cStatus', m.ok
          ? '轨迹已写入车辆：' + wps.length + ' 点。完成 ARM 后点击③启动。'
          : '轨迹上传失败，可点击②重试。');
      }
      if (m.ok && !m.fence) setMissionState('uploaded');
      break;
    }
    case 'fence_status': {
      const el = document.getElementById('fenceBreach');
      if (m.breach) { el.textContent = '⚠ 越界!'; el.className = 'v armed'; }
      else { el.textContent = '正常'; el.className = 'v disarmed'; } break;
    }
    case 'mission_list': loadDownloadedMission(m.items); break;
    case 'coverage_status': setText('f2cStatus', 'Fields2Cover 正在规划…'); break;
    case 'coverage_error': setText('f2cStatus', '规划失败'); logLine('Fields2Cover: ' + m.error, 'err'); break;
    case 'coverage_plan':
      setText('f2cStatus', '完成：' + m.swaths + ' 条作业行 / ' + m.items.length + ' 点 / ' + Number(m.lengthM || 0).toFixed(1) + ' m' +
        (m.fieldContained ? ' / 田块内校验通过' : ''));
      coverageMissionReady = false; setCoverageActions(true, false);
      showPlanPreview(m.items, 'coverage'); break;
    case 'mission_current': setText('tMode', getText('tMode')); break;
    case 'mission_reached': logLine('已到达航点 #' + m.seq, 'info'); break;
    case 'mstat': renderMstat(m); break;
    case 'rtcm': { const parts = Object.keys(m).filter((k) => k !== 't').map((k) => k + '=' + m[k]); logLine('RTCM 中继: ' + parts.join(' '), 'sys'); break; }
    case 'stale': setLinkStale(); break;
    case 'log': logLine(m.msg, 'sys'); break;
    default: break;
  }
}
function applyVehicle(v) { if (v.modeName) setMode(v.modeName); setArmed(v.armed); }
function loadDownloadedMission(items) {
  clearMission();
  const markers = trajectoryMarkerIndices(items);
  items.forEach((it, i) => addWaypoint(it.lat, it.lon, Object.assign({}, it, { renderMarker: markers.has(i) })));
  logLine('已下载任务: ' + items.length + ' 个航点', 'info');
  setMissionState(items.length ? 'uploaded' : 'none'); // came from the vehicle ⇒ in sync
  if (items.length) map.fitBounds(missionLine.getBounds().pad(0.3));
}

// ----- northbound mission-progress line (MSTAT → small status line under the mission pill) -----
function renderMstat(m) {
  const el = document.getElementById('mstatLine'); if (!el) return;
  const state = m.state || '', total = m.total || 0;
  if (!total && (state === 'IDLE' || state === '')) { el.style.display = 'none'; return; } // idle & no mission ⇒ hide
  let s = '车端任务: ' + (state || '--');
  if (total) s += '  ' + (m.cur || 0) + '/' + total;
  if (m.dist_next != null) s += ' · 距下一点 ' + (Math.round(m.dist_next * 10) / 10) + ' m';
  if (m.cmd_speed != null) s += ' · 指令 ' + m.cmd_speed.toFixed(2) + ' m/s';
  if (m.cte != null) s += ' · 横误差 ' + m.cte.toFixed(2) + ' m';
  if (m.dir != null) s += m.dir < 0 ? ' · 倒车' : ' · 前进';
  if (m.curvature_saturated) s += ' · 转弯已限幅';
  el.textContent = s; el.style.display = '';
  if (state === 'COMPLETED') setMissionState('done');
  else if (state === 'RUNNING') setMissionState('running');
  else if (state === 'PAUSED') setMissionState('uploaded');
}

// ----- PLAN preview + approval gate (northbound §3.8: vehicle computes, GCS previews/approves) --
// The vehicle pushes a concrete PLAN (waypoint echo, or F2C coverage path) for operator review
// BEFORE it is authorised to drive. Render it read-only in a distinct layer and gate execution
// behind explicit approval — instead of silently overwriting the editable mission and marking it
// "in sync" (the old behaviour, which let a vehicle-computed path start with no operator check).
let planPreview = null;                                       // {items, src} | null
const planLine = L.polyline([], { color: '#38bdf8', weight: 3, opacity: .95, dashArray: '2,7' }).addTo(map);
const planReverseLine = L.polyline([], { color: '#f0a93b', weight: 5, opacity: .95 }).addTo(map);
let planMarkers = [];
function clearPlanPreview() {
  planLine.setLatLngs([]); planReverseLine.setLatLngs([]);
  planMarkers.forEach((mk) => map.removeLayer(mk)); planMarkers = [];
  planPreview = null;
  const b = document.getElementById('planBanner'); if (b) b.className = 'mapmode hidden';
}
function showPlanPreview(items, src) {
  items = Array.isArray(items) ? items : [];
  clearPlanPreview();
  if (!items.length) { logLine('车端计划为空，忽略', 'warn'); return; }
  planPreview = { items, src: src || '' };
  planLine.setLatLngs(items.map((it) => [it.lat, it.lon]));
  planReverseLine.setLatLngs(items.slice(1).flatMap((it, i) =>
    it.dir < 0 ? [[[items[i].lat, items[i].lon], [it.lat, it.lon]]] : []));
  const markerIndices = trajectoryMarkerIndices(items);
  items.forEach((it, i) => { if (markerIndices.has(i)) planMarkers.push(
    L.marker([it.lat, it.lon], { icon: L.divIcon({ className: '', html: '<div class="plan-marker">' + (i + 1) + '</div>', iconSize: [20, 20], iconAnchor: [10, 10] }) }).addTo(map)); });
  if (planLine.getBounds().isValid()) map.fitBounds(planLine.getBounds().pad(0.3));
  const label = src === 'coverage' ? '覆盖规划' : (src === 'wp' ? '航点' : (src || '车端'));
  const reverseCount = items.slice(1).filter((it) => it.dir < 0).length;
  setText('planBannerText', '🛰 计划预览：' + items.length + ' 点（来源: ' + label +
    '，倒车段 ' + reverseCount + '）— 橙色为倒车；确认后上传到车辆，但不会自动启动');
  document.getElementById('planBanner').className = 'mapmode m-plan-preview';
  setMissionState('preview');
  logLine('🛰 收到车端计划 ' + items.length + ' 点 (src=' + (src || '?') + ')，待批准', 'info');
}
function approvePlan() {
  if (!planPreview || !guard()) return;
  const items = planPreview.items;
  const source = planPreview.src;
  clearPlanPreview();
  clearMission();
  const markers = trajectoryMarkerIndices(items);
  items.forEach((it, i) => addWaypoint(it.lat, it.lon, Object.assign({}, it, { renderMarker: markers.has(i) })));
  markPlanDirty();
  coverageUploadPending = source === 'coverage';
  setCoverageActions(false, false);
  if (coverageUploadPending) {
    syncCoverageSpeeds(items);
    setText('f2cStatus', '正在同步前/后退速度并上传 ' + items.length + ' 点…');
  }
  uploadCurrentMission();
  logLine('✓ 已采用计划并上传 (' + items.length + ' 点)；上传不会启动车辆', 'info');
}
function rejectPlan() {
  if (!planPreview) return;
  const n = planPreview.items.length;
  clearPlanPreview();
  coverageUploadPending = false; coverageMissionReady = false; setCoverageActions(false, false);
  setText('f2cStatus', '已丢弃预览轨迹，车辆任务未改变');
  setMissionState(wps.length ? 'uploaded' : 'none');
  logLine('✗ 已拒绝车端计划 (' + n + ' 点)，未启动', 'warn');
}

// ----------------------------------------------------------------------------
// UI helpers
// ----------------------------------------------------------------------------
function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
function getText(id) { const el = document.getElementById(id); return el ? el.textContent : ''; }
function setMode(name) {
  setText('tMode', name || '--'); setText('vMode', name || '--');
  if (getMissionState() === 'preview') return;        // a vehicle plan awaits approval — don't let heartbeats clobber the 待批准 pill
  if (name === 'AUTO') setMissionState('running');
  else if (getMissionState() === 'running') setMissionState('uploaded'); // paused/changed out of AUTO, mission still loaded
}
function setArmed(armed) {
  const cls = armed ? 'armed' : 'disarmed';
  const a = document.getElementById('tArmed'); if (a) { a.textContent = armed ? '已武装' : '已上锁'; a.className = 'inst-val ' + cls; }
}
function setLink(on) {
  linkConnected = on;
  const dot = document.getElementById('linkDot'), txt = document.getElementById('linkText'), btn = document.getElementById('btnConn');
  dot.className = 'dot' + (on ? ' on' : ''); txt.textContent = on ? '已连接' : '未连接';
  btn.textContent = on ? '断开' : '连接'; btn.className = on ? '' : 'primary';
  if (!on) { firstFix = true; clearPlanPreview(); const ml = document.getElementById('mstatLine'); if (ml) ml.style.display = 'none'; }  // 断链清待批准计划（防陈旧移动授权）+ 隐藏车端任务行
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
function guard() { if (!linkConnected) { logLine('请先连接车辆', 'warn'); return false; } return true; }

// ---- transport-aware UI: the northbound (self-dev VCU) protocol supports a smaller command
// surface than ArduPilot/MAVLink. In north mode, adapt the mode dropdown and hide controls that
// would silently no-op, so operators aren't misled. Pure show/hide + <option> rebuild; switching
// back to a MAVLink transport restores the full ArduPilot UI (the demo path is unaffected). ----
// ⚠ ROVER_MODES 必须与 index.html #modeSel 的 <option> 保持一致（applyTransportUI 会用本数组重建下拉）。
const ROVER_MODES = ['MANUAL', 'HOLD', 'AUTO', 'GUIDED', 'RTL', 'SMART_RTL', 'STEERING', 'LOITER', 'ACRO', 'FOLLOW'];
const NORTH_MODES = [['MANUAL', 'MANUAL'], ['IDLE', '待命 (IDLE)'], ['AUTO', '自动 (AUTO)']];
const NORTH_HIDE = ['btnSkip', 'btnTlog'];
function applyTransportUI(tr) {
  const north = (tr === 'north');
  const sel = document.getElementById('modeSel');
  if (sel) {
    const opts = north ? NORTH_MODES : ROVER_MODES.map((m) => [m, m]);
    const want = opts.map((o) => o[0]).join(',');
    if (sel.getAttribute('data-modes') !== want) {            // rebuild only when the set changes
      sel.innerHTML = '';
      opts.forEach(([v, label]) => { const o = document.createElement('option'); o.value = v; o.textContent = label; sel.appendChild(o); });
      sel.setAttribute('data-modes', want);
    }
  }
  NORTH_HIDE.forEach((id) => { const el = document.getElementById(id); if (el) el.style.display = north ? 'none' : ''; });
  const speed = document.getElementById('spd');
  if (speed) { speed.max = north ? '6.00' : ''; if (north && parseFloat(speed.value) > 6.00) speed.value = '6.00'; }
  const stageNote = document.getElementById('northStageNote'); if (stageNote) stageNote.style.display = north ? '' : 'none';
  const estopReset = document.getElementById('btnEstopReset'); if (estopReset) estopReset.style.display = north ? '' : 'none';
  const fenceCard = document.getElementById('cardFence'); if (fenceCard) fenceCard.style.display = north ? 'none' : ''; // north v1 has no fence
  if (!north) { const ml = document.getElementById('mstatLine'); if (ml) ml.style.display = 'none'; }  // 车端任务进度行仅北向用
}

document.getElementById('transport').addEventListener('change', (e) => {
  for (const k of ['udp', 'tcp', 'serial', 'north']) document.getElementById('f-' + k).style.display = (e.target.value === k ? '' : 'none');
  applyTransportUI(e.target.value);
  clearPlanPreview();   // 切换传输清任何待批准计划（防跨传输陈旧移动授权）
});
document.getElementById('btnConn').addEventListener('click', () => {
  if (linkConnected) { send({ t: 'disconnect' }); return; }
  const tr = document.getElementById('transport').value;
  const cfg = { t: 'connect', transport: tr };
  if (tr === 'udp') cfg.listen = document.getElementById('udpListen').value;
  else if (tr === 'tcp') { cfg.host = document.getElementById('tcpHost').value; cfg.port = document.getElementById('tcpPort').value; }
  else if (tr === 'north') { cfg.host = document.getElementById('northHost').value; cfg.port = document.getElementById('northPort').value; }
  else { cfg.path = document.getElementById('serPath').value; cfg.baud = document.getElementById('serBaud').value; }
  saveSettings(); send(cfg); logLine('正在连接 (' + tr + ')…', 'sys');
});

document.getElementById('btnPlanApprove').addEventListener('click', approvePlan);
document.getElementById('btnPlanReject').addEventListener('click', rejectPlan);

document.getElementById('btnArm').addEventListener('click', () => { if (guard()) { send({ t: 'arm', arm: true }); logLine('发送: 解锁', 'info'); } });
document.getElementById('btnDisarm').addEventListener('click', () => { if (guard()) { send({ t: 'arm', arm: false }); logLine('发送: 上锁', 'info'); } });
document.getElementById('btnSetMode').addEventListener('click', () => { if (guard()) { const mode = document.getElementById('modeSel').value; send({ t: 'mode', mode }); logLine('发送: 模式 ' + mode, 'info'); } });
document.getElementById('btnRtl').addEventListener('click', () => { if (guard()) { send({ t: 'rtl' }); logLine('发送: 返航 RTL', 'info'); } });
document.getElementById('btnStart2').addEventListener('click', startMission);
function startMission() {
  if (guard()) { send({ t: 'startMission' }); logLine('发送: 启动任务 (AUTO)', 'info'); }
}
document.getElementById('btnF2cUpload').addEventListener('click', () => {
  if (planPreview && planPreview.src === 'coverage') approvePlan();
  else if (wps.some((p) => p.planned) && guard()) {
    coverageUploadPending = true; setCoverageActions(false, false);
    syncCoverageSpeeds(wps);
    setText('f2cStatus', '正在同步前/后退速度并重新上传 ' + wps.length + ' 点…');
    uploadCurrentMission();
  }
});
document.getElementById('btnF2cStart').addEventListener('click', () => {
  if (!coverageMissionReady) return logLine('请先完成第②步，确认轨迹已上传到车辆', 'warn');
  startMission();
  setText('f2cStatus', '已发送启动命令：车辆先前往轨迹起点，再执行覆盖轨迹');
});
document.getElementById('btnEstop').addEventListener('click', () => {
  if (!guard()) return;
  if (confirm('确认急停？将强制上锁（电机立即停止）。')) { send({ t: 'estop' }); logLine('⛔ 发送: 急停 (强制上锁)', 'err'); }
});
document.getElementById('btnEstopReset').addEventListener('click', () => {
  if (!guard()) return;
  if (confirm('确认车辆已经静止且急停条件已解除？')) {
    send({ t: 'estop', on: false }); logLine('发送: 解除软件急停（解除后仍需重新 ARM）', 'warn');
  }
});

document.getElementById('btnAdd').addEventListener('click', () => setMapMode('plan'));
document.getElementById('btnGoto').addEventListener('click', () => setMapMode('goto'));
document.getElementById('btnDrawField').addEventListener('click', () => {
  fieldPoints = []; redrawFieldBoundary(false); setMapMode('field');
});
document.getElementById('btnFieldDone').addEventListener('click', () => {
  if (fieldPoints.length < 3) return logLine('田块至少需要 3 个顶点', 'warn');
  redrawFieldBoundary(true); setMapMode(null);
  logLine('田块边界已闭合：' + fieldPoints.length + ' 个顶点', 'info');
});
document.getElementById('btnFieldClear').addEventListener('click', () => {
  fieldPoints = []; if (boundaryLayer) { map.removeLayer(boundaryLayer); boundaryLayer = null; }
  setText('f2cStatus', '尚未规划');
});
document.getElementById('btnF2cPlan').addEventListener('click', () => {
  if (fieldPoints.length < 3) return logLine('请先绘制田块或导入 KML 边界', 'warn');
  const val = (id) => parseFloat(document.getElementById(id).value);
  const rowText = document.getElementById('f2cRowHeading').value.trim();
  send({ t: 'planCoverage', polygon: fieldPoints, params: {
    coverageWidth: val('f2cWidth'), robotWidth: val('f2cRobotWidth'), headland: val('f2cHeadland'),
    turningRadius: val('f2cRadius'), maxCurvatureRate: val('f2cCurvRate'),
    forwardSpeed: val('f2cForwardSpeed'), reverseSpeed: val('f2cReverseSpeed'),
    sampleStep: val('f2cStep'), rowHeading: rowText || 'auto',
    allowReverse: document.getElementById('f2cReverse').checked,
  } });
  coverageUploadPending = false; coverageMissionReady = false; setCoverageActions(false, false);
  setText('f2cStatus', 'Fields2Cover 正在规划…');
  logLine('发送田块到本机 Fields2Cover（不会直接启动车辆）', 'info');
});
document.getElementById('btnModeExit').addEventListener('click', () => setMapMode(null));
function uploadCurrentMission() {
  if (!guard()) return;
  if (!wps.length) return logLine('没有航点可上传', 'warn');
  send({ t: 'uploadMission', items: wps.map((w) => ({
    lat: w.lat, lon: w.lon, alt: 0, yaw: w.yaw, dir: w.dir || 1,
    speed: w.speed, section: w.section, planned: !!w.planned,
  })) }); // rover ignores altitude; north vehicle preserves trajectory metadata
  logLine('发送: 上传 ' + wps.length + ' 个航点…', 'info');
}
function syncCoverageSpeeds(items) {
  if (document.getElementById('transport').value !== 'north') return;
  const speeds = (items || []).map((p) => ({
    dir: Number(p.dir) < 0 ? -1 : 1,
    speed: Math.min(6.0, Math.max(0.05, Math.abs(Number(p.speed) || 0))),
  }));
  const forward = speeds.filter((p) => p.dir > 0).reduce((v, p) => Math.max(v, p.speed), 0);
  const reverse = speeds.filter((p) => p.dir < 0).reduce((v, p) => Math.max(v, p.speed), 0);
  if (forward > 0) send({ t: 'setParam', id: 'CRUISE_SPEED', value: forward });
  if (reverse > 0) send({ t: 'setParam', id: 'REVERSE_SPEED', value: reverse });
  logLine('同步 F2C 执行速度：前进 ' + forward.toFixed(2) +
    ' / 后退 ' + (reverse || 0).toFixed(2) + ' m/s', 'info');
}
document.getElementById('btnUpload').addEventListener('click', uploadCurrentMission);
document.getElementById('btnDownload').addEventListener('click', () => { if (guard()) { send({ t: 'downloadMission' }); logLine('发送: 下载任务…', 'info'); } });
document.getElementById('btnClear').addEventListener('click', () => { clearMission(); setMissionState('none'); logLine('已清空本地航点', 'sys'); });

// ----- change speed / pause / skip -----
document.getElementById('btnPause').addEventListener('click', () => { if (guard()) { send({ t: 'pause' }); logLine('发送: 暂停 (HOLD)', 'info'); } });
document.getElementById('btnSpeed').addEventListener('click', () => {
  if (!guard()) return; const s = parseFloat(document.getElementById('spd').value);
  if (!isFinite(s) || s <= 0) return logLine('速度无效', 'warn');
  send({ t: 'changeSpeed', speed: s });
  if (document.getElementById('transport').value === 'north') {
    send({ t: 'setParam', id: 'REVERSE_SPEED', value: s });
  }
  logLine('发送: 自动前/后退改速 ' + s + ' m/s', 'info');
});
document.getElementById('btnSkip').addEventListener('click', () => {
  if (!guard()) return; const v = prompt('跳到第几个航点 (seq)?', '1'); if (v === null) return;
  const seq = parseInt(v, 10); if (!isFinite(seq)) return;
  send({ t: 'setCurrent', seq }); logLine('发送: 跳到航点 #' + seq, 'info');
});

// ----- operator parameters (whitelist) -----
const PARAM_WHITELIST = [
  ['MANUAL_SPEED', '手动最大速度 m/s'],
  ['CRUISE_SPEED', '前进速度 m/s'], ['REVERSE_SPEED', '后退速度 m/s'],
  ['WP_SPEED', '任务速度 m/s (0=巡航)'], ['WP_RADIUS', '航点到达半径 m'],
  ['MIN_TURN_RADIUS', '最小转弯半径 m'], ['LOOKAHEAD_MIN', '最小前视 m'], ['LOOKAHEAD_MAX', '最大前视 m'],
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
  if (m.id === 'MANUAL_SPEED') {
    const manual = document.getElementById('manualSpeed');
    if (manual) manual.value = (Math.round(m.value * 1000) / 1000);
  }
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
  const alt = 0; // rover ignores altitude
  const lines = ['QGC WPL 110'];
  lines.push([0, 1, 0, 16, 0, 0, 0, 0, wps[0].lat, wps[0].lon, 0, 1].join('\t')); // home placeholder
  wps.forEach((w, i) => lines.push([i + 1, 0, 3, 16, 0, 0, 0, 0, w.lat, w.lon, alt, 1].join('\t')));
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = 'mission.waypoints'; a.click();
  logLine('已保存航点文件 (' + wps.length + ' 点)', 'info');
});
document.getElementById('btnSaveArf').addEventListener('click', () => {
  if (!wps.length) return logLine('无轨迹可保存', 'warn');
  const doc = { format: 'AutoRoverFieldMissionV1', allowReverse: wps.some((w) => w.dir < 0),
    items: wps.map((w) => ({ lat: w.lat, lon: w.lon, yaw: w.yaw, dir: w.dir || 1,
      speed: w.speed, section: w.section, planned: !!w.planned })) };
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = 'mission.arf.json'; a.click();
  logLine('已保存 AutoRoverField 轨迹文件（保留前进/倒车与速度）', 'info');
});
document.getElementById('btnLoadWp').addEventListener('click', () => document.getElementById('fileWp').click());
document.getElementById('fileWp').addEventListener('change', (e) => {
  const f = e.target.files[0]; if (!f) return; const r = new FileReader();
  r.onload = () => {
    if (/\.json$/i.test(f.name)) loadArfMission(String(r.result)); else loadWaypoints(String(r.result));
    e.target.value = '';
  }; r.readAsText(f);
});
function loadArfMission(text) {
  let doc; try { doc = JSON.parse(text); } catch (_) { return logLine('ARF 轨迹 JSON 解析失败', 'err'); }
  if (!doc || doc.format !== 'AutoRoverFieldMissionV1' || !Array.isArray(doc.items)) {
    return logLine('不是 AutoRoverFieldMissionV1 轨迹文件', 'err');
  }
  const items = doc.items.filter((it) => it && isFinite(it.lat) && isFinite(it.lon));
  if (!items.length) return logLine('ARF 轨迹文件没有有效点', 'err');
  clearMission();
  const markers = trajectoryMarkerIndices(items);
  items.forEach((it, i) => addWaypoint(+it.lat, +it.lon, Object.assign({}, it, { renderMarker: markers.has(i) })));
  markPlanDirty(); if (missionLine.getBounds().isValid()) map.fitBounds(missionLine.getBounds().pad(0.3));
  logLine('已读取 ARF 轨迹：' + items.length + ' 点，倒车段=' + (items.some((it) => it.dir < 0) ? '有' : '无'), 'info');
}
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
  markPlanDirty(); // loaded locally, not yet uploaded to the vehicle
  if (wps.length) map.fitBounds(missionLine.getBounds().pad(0.3));
}

// ----- KML field boundary import -----
let boundaryLayer = null, fieldPoints = [];
function redrawFieldBoundary(closed) {
  if (boundaryLayer) map.removeLayer(boundaryLayer);
  if (!fieldPoints.length) { boundaryLayer = null; return; }
  boundaryLayer = closed
    ? L.polygon(fieldPoints.map((p) => [p.lat, p.lon]), { color: '#e0a800', weight: 3, fillOpacity: 0.08 }).addTo(map)
    : L.polyline(fieldPoints.map((p) => [p.lat, p.lon]), { color: '#e0a800', weight: 3, dashArray: '4,4' }).addTo(map);
}
function addFieldVertex(lat, lon) {
  fieldPoints.push({ lat, lon }); redrawFieldBoundary(false);
  setText('f2cStatus', '田块边界 ' + fieldPoints.length + ' 点（尚未闭合）');
}
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
  fieldPoints = pts.map((p) => ({ lat: p[0], lon: p[1] }));
  if (fieldPoints.length > 1 && Math.abs(fieldPoints[0].lat - fieldPoints[fieldPoints.length - 1].lat) < 1e-11 &&
      Math.abs(fieldPoints[0].lon - fieldPoints[fieldPoints.length - 1].lon) < 1e-11) fieldPoints.pop();
  redrawFieldBoundary(true);
  map.fitBounds(boundaryLayer.getBounds().pad(0.2));
  setText('f2cStatus', '已导入田块：' + fieldPoints.length + ' 个顶点');
  logLine('已导入 KML 田块边界: ' + fieldPoints.length + ' 顶点', 'info');
}

// ----- tlog recording -----
let tlogRecording = false;
document.getElementById('btnTlog').addEventListener('click', () => {
  if (!linkConnected && !tlogRecording) return logLine('请先连接飞控再记录', 'warn');
  send({ t: tlogRecording ? 'tlogStop' : 'tlogStart' });
});

// ----- offline map cache -----
let currentBase = esriImagery;
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
    serPath: document.getElementById('serPath').value, serBaud: document.getElementById('serBaud').value,
    northHost: document.getElementById('northHost').value, northPort: document.getElementById('northPort').value };
  try { localStorage.setItem('rover_gcs_conn', JSON.stringify(s)); } catch (_) {}
}
(function restoreSettings() {
  let s; try { s = JSON.parse(localStorage.getItem('rover_gcs_conn') || '{}'); } catch (_) { s = {}; }
  for (const k of ['transport', 'udpListen', 'tcpHost', 'tcpPort', 'serPath', 'serBaud', 'northHost', 'northPort']) {
    if (s[k] != null && document.getElementById(k)) document.getElementById(k).value = s[k];
  }
  document.getElementById('transport').dispatchEvent(new Event('change'));
})();

// ----- geofence (uses the shared mapMode state machine) -----
let fenceTempPts = [], fenceTempLayer = null;
const fences = [];
function beginFenceDraw() {
  fenceTempPts = [];
  if (fenceTempLayer) { map.removeLayer(fenceTempLayer); fenceTempLayer = null; }
  logLine('围栏绘制: ' + (mapMode === 'fenceExc' ? '排除区' : '包含区'), 'sys');
}
function cancelFenceDraw() {
  if (fenceTempLayer) { map.removeLayer(fenceTempLayer); fenceTempLayer = null; }
  fenceTempPts = [];
}
function addFenceVertex(lat, lon) {
  fenceTempPts.push([lat, lon]);
  const color = mapMode === 'fenceExc' ? '#e5484d' : '#2e9e4f';
  if (fenceTempLayer) map.removeLayer(fenceTempLayer);
  fenceTempLayer = L.polygon(fenceTempPts, { color, weight: 2, dashArray: '4,4', fillOpacity: 0.05 }).addTo(map);
}
function finishFence() {
  if (mapMode !== 'fenceInc' && mapMode !== 'fenceExc') return logLine('请先点「画包含区 / 画排除区」', 'warn');
  if (fenceTempPts.length < 3) return logLine('围栏至少需要 3 个顶点', 'warn');
  const exc = mapMode === 'fenceExc', color = exc ? '#e5484d' : '#2e9e4f';
  const layer = L.polygon(fenceTempPts.slice(), { color, weight: 2, fillOpacity: 0.08 }).addTo(map);
  fences.push({ kind: exc ? 'exc' : 'inc', pts: fenceTempPts.slice(), layer });
  logLine('已添加' + (exc ? '排除' : '包含') + '围栏 (' + fenceTempPts.length + ' 顶点)', 'info');
  fenceTempPts = []; if (fenceTempLayer) { map.removeLayer(fenceTempLayer); fenceTempLayer = null; }
  setMapMode(null);
}
function clearFences() {
  fences.forEach((f) => map.removeLayer(f.layer)); fences.length = 0;
  cancelFenceDraw();
  if (mapMode && mapMode.indexOf('fence') === 0) setMapMode(null);
  setText('fenceBreach', '--'); logLine('已清空围栏', 'sys');
}
document.getElementById('btnFenceInc').addEventListener('click', () => setMapMode('fenceInc'));
document.getElementById('btnFenceExc').addEventListener('click', () => setMapMode('fenceExc'));
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
document.getElementById('btnJoy').addEventListener('click', () => { if (!joyOn && !linkConnected) return logLine('请先连接车辆', 'warn'); joyEnable(!joyOn); });
document.getElementById('btnManualSpeed').addEventListener('click', () => {
  if (!guard()) return;
  const speed = parseFloat(document.getElementById('manualSpeed').value);
  if (!isFinite(speed) || speed < 0.05 || speed > 6.0) return logLine('手动最大速度必须在 0.05～6.00 m/s', 'warn');
  send({ t: 'setParam', id: 'MANUAL_SPEED', value: speed });
  logLine('发送: 手动最大速度 ' + speed.toFixed(2) + ' m/s', 'info');
});
window.addEventListener('gamepadconnected', () => logLine('手柄已连接', 'info'));

// ----- collapsible panel sections -----
document.querySelectorAll('.card-h').forEach((h) => h.addEventListener('click', () => h.parentElement.classList.toggle('open')));

connectWS();
