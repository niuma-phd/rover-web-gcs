'use strict';

// Off-board Fields2Cover process adapter.  Coverage generation deliberately
// lives beside the GCS, not in the vehicle mission executor.
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_BINARY = process.env.AUTO_ROVER_F2C_BIN ||
  path.resolve(__dirname, '..', '..', '..', 'install', 'bin', 'auto_rover_f2c');
const DEFAULT_LIB = path.resolve(__dirname, '..', '..', '..', 'install', 'lib');
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

function finite(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(name + ' 不是有效数字');
  return n;
}

function between(v, lo, hi, name) {
  const n = finite(v, name);
  if (n < lo || n > hi) throw new Error(name + ' 必须在 ' + lo + '～' + hi + ' 之间');
  return n;
}

function normaliseRequest(request) {
  const polygon = [];
  for (const p of (Array.isArray(request && request.polygon) ? request.polygon : [])) {
    if (!p || typeof p !== 'object') continue;
    const lat = finite(p.lat, '纬度'), lon = finite(p.lon, '经度');
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) throw new Error('田块坐标超出 WGS84 范围');
    if (!polygon.length || Math.abs(polygon[polygon.length - 1].lat - lat) > 1e-11 ||
        Math.abs(polygon[polygon.length - 1].lon - lon) > 1e-11) polygon.push({ lat, lon });
  }
  if (polygon.length > 1 && Math.abs(polygon[0].lat - polygon[polygon.length - 1].lat) < 1e-11 &&
      Math.abs(polygon[0].lon - polygon[polygon.length - 1].lon) < 1e-11) polygon.pop();
  if (polygon.length < 3) throw new Error('田块至少需要 3 个不同顶点');
  if (polygon.length > 1000) throw new Error('田块顶点不能超过 1000 个');
  const p = (request && request.params) || {};
  const rowRaw = p.rowHeading == null || p.rowHeading === '' ? 'auto' : p.rowHeading;
  const rowHeading = String(rowRaw).toLowerCase() === 'auto' ? 'auto'
    : between(rowRaw, 0, 360, '作业行航向');
  return {
    polygon,
    params: {
      coverageWidth: between(p.coverageWidth == null ? 1.0 : p.coverageWidth, 0.15, 20, '作业幅宽'),
      robotWidth: between(p.robotWidth == null ? 0.70 : p.robotWidth, 0.15, 5, '规划占用宽度'),
      headland: between(p.headland == null ? 2.8 : p.headland, 0, 30, '地头宽度'),
      turningRadius: between(p.turningRadius == null ? 1.25 : p.turningRadius, 1.25, 10, '最小转弯半径'),
      maxCurvatureRate: between(p.maxCurvatureRate == null ? 0.8 : p.maxCurvatureRate, 0.05, 2, '曲率变化率'),
      forwardSpeed: between(p.forwardSpeed == null ? 1.00 : p.forwardSpeed, 0.05, 6.00, '前进速度'),
      reverseSpeed: between(p.reverseSpeed == null ? 1.00 : p.reverseSpeed, 0.05, 6.00, '倒车速度'),
      sampleStep: between(p.sampleStep == null ? 0.20 : p.sampleStep, 0.10, 1.0, '轨迹采样间距'),
      rowHeading,
      allowReverse: p.allowReverse !== false,
    },
  };
}

async function planCoverage(request, options = {}) {
  const input = normaliseRequest(request);
  const p = input.params;
  const args = [
    '--coverage-width', String(p.coverageWidth), '--robot-width', String(p.robotWidth),
    '--headland', String(p.headland), '--turning-radius', String(p.turningRadius),
    '--max-curvature-rate', String(p.maxCurvatureRate), '--forward-speed', String(p.forwardSpeed),
    '--reverse-speed', String(p.reverseSpeed), '--sample-step', String(p.sampleStep),
    '--row-heading', String(p.rowHeading), '--allow-reverse', p.allowReverse ? '1' : '0',
  ];
  const binary = options.binary || DEFAULT_BINARY;
  const timeoutMs = options.timeoutMs || 30000;
  const oldLdPath = process.env.LD_LIBRARY_PATH || '';
  const env = Object.assign({}, process.env, options.env || {}, {
    LD_LIBRARY_PATH: [DEFAULT_LIB, oldLdPath].filter(Boolean).join(':'),
  });
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], env }); }
    catch (e) { reject(new Error('无法启动 Fields2Cover: ' + e.message)); return; }
    let stdout = '', stderr = '', settled = false;
    const finish = (err, result) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (err) reject(err); else resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      finish(new Error('Fields2Cover 规划超时'));
    }, timeoutMs);
    child.on('error', (e) => finish(new Error('无法启动 Fields2Cover: ' + e.message)));
    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
      if (stdout.length > MAX_OUTPUT_BYTES) {
        try { child.kill('SIGKILL'); } catch (_) {}
        finish(new Error('Fields2Cover 输出过大'));
      }
    });
    child.stderr.on('data', (d) => { if (stderr.length < 8192) stderr += d.toString('utf8'); });
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) return finish(new Error((stderr || 'Fields2Cover 规划失败').trim()));
      let result;
      try { result = JSON.parse(stdout); } catch (_) { return finish(new Error('Fields2Cover 返回了无效 JSON')); }
      if (!result || result.ok !== true || !Array.isArray(result.items) || result.items.length < 2) {
        return finish(new Error('Fields2Cover 没有生成可执行轨迹'));
      }
      if (result.fieldContained !== true) {
        return finish(new Error('Fields2Cover 未通过整条轨迹的田块内校验'));
      }
      finish(null, result);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input.polygon.map((v) => v.lat + ',' + v.lon).join('\n') + '\n');
  });
}

module.exports = { DEFAULT_BINARY, normaliseRequest, planCoverage };
