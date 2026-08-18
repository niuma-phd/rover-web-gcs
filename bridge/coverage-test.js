#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { DEFAULT_BINARY, normaliseRequest, planCoverage } = require('./coverage-planner');

function check(condition, message) {
  if (!condition) throw new Error(message);
  console.log('  ✓ ' + message);
}

function localPolygon(points, originLat = 31.230400, originLon = 121.473700) {
  const metersPerDegreeLat = 111319.49079327357;
  const metersPerDegreeLon = metersPerDegreeLat * Math.cos(originLat * Math.PI / 180);
  return points.map(([x, y]) => ({
    lat: originLat + y / metersPerDegreeLat,
    lon: originLon + x / metersPerDegreeLon,
  }));
}

function pointInsidePolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if (((a.lat > point.lat) !== (b.lat > point.lat)) &&
        point.lon < (b.lon - a.lon) * (point.lat - a.lat) / (b.lat - a.lat) + a.lon) inside = !inside;
  }
  return inside;
}

function isExecutable(file) {
  try { fs.accessSync(file, fs.constants.X_OK); return true; } catch (_) { return false; }
}

(async () => {
  const polygon = [
    { lat: 31.230400, lon: 121.473700 },
    { lat: 31.230400, lon: 121.473910 },
    { lat: 31.230508, lon: 121.473910 },
    { lat: 31.230508, lon: 121.473700 },
  ];
  const request = { polygon, params: { coverageWidth: 1.0, robotWidth: 0.7,
    headland: 2.8, turningRadius: 1.25, maxCurvatureRate: 0.8, forwardSpeed: 1.0,
    reverseSpeed: 1.0, sampleStep: 0.2, rowHeading: 'auto', allowReverse: true } };
  const normalized = normaliseRequest(request);
  check(normalized.polygon.length === 4, 'coverage request keeps four field vertices');
  check(normalized.params.turningRadius === 1.25, 'working turn radius is 1.25 m');
  check(normalized.params.forwardSpeed === 1.0 && normalized.params.reverseSpeed === 1.0,
    'forward and reverse presets are both 1.00 m/s');
  const maximumSpeeds = normaliseRequest({ polygon, params: { forwardSpeed: 6.0, reverseSpeed: 6.0 } });
  check(maximumSpeeds.params.forwardSpeed === 6.0 && maximumSpeeds.params.reverseSpeed === 6.0,
    'forward and reverse requests both accept 6.00 m/s');
  let excessiveSpeedRejected = false;
  try { normaliseRequest({ polygon, params: { reverseSpeed: 6.01 } }); } catch (_) { excessiveSpeedRejected = true; }
  check(excessiveSpeedRejected, 'reverse speed above 6.00 m/s is rejected');
  let invalidPlanPromise = null;
  let invalidPlanThrewSynchronously = false;
  try { invalidPlanPromise = planCoverage({ polygon, params: { reverseSpeed: 6.01 } }); }
  catch (_) { invalidPlanThrewSynchronously = true; }
  check(!invalidPlanThrewSynchronously && invalidPlanPromise && typeof invalidPlanPromise.then === 'function',
    'invalid coverage parameters return a rejected promise instead of crashing the bridge');
  let invalidPlanRejected = false;
  try { await invalidPlanPromise; } catch (_) { invalidPlanRejected = true; }
  check(invalidPlanRejected, 'invalid coverage parameter promise is rejected for the browser error path');
  let rejected = false;
  try { normaliseRequest({ polygon, params: { turningRadius: 1.24 } }); } catch (_) { rejected = true; }
  check(rejected, 'a turn radius below the 1.25 m tested working envelope is rejected');

  if (!isExecutable(DEFAULT_BINARY)) {
    if (process.env.AUTO_ROVER_F2C_BIN) {
      throw new Error('AUTO_ROVER_F2C_BIN is not executable: ' + DEFAULT_BINARY);
    }
    console.log('\n  ⊘ real Fields2Cover integration skipped (set AUTO_ROVER_F2C_BIN to enable it).');
    return;
  }

  const result = await planCoverage(request);
  check(result.engine === 'Fields2Cover-2.0.0', 'real Fields2Cover 2.0.0 engine executed');
  check(result.swaths >= 2 && result.items.length > 20, 'coverage contains multiple swaths and a dense path');
  check(result.turnPolicy === 'forward_if_fits' &&
    result.forwardTurns + result.reverseTurns === result.swaths - 1,
    'each headland connector uses the forward-if-it-fits hybrid policy');
  check(result.reverseTurns === 0 || result.minReverseRunM >= 1.0 - 1e-6,
    'hybrid planner never emits a reverse run shorter than 1.00 m');
  check(result.items.filter((p) => p.dir < 0).every((p) => Math.abs(p.speed - 1.0) < 1e-9),
    'any selected fish-tail samples preserve the requested 1.00 m/s speed');
  check(result.items.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) &&
    (p.dir === 1 || p.dir === -1) && p.speed > 0), 'every trajectory sample has coordinates, direction, and speed');
  check(result.fieldContained === true && result.items.every((p) => pointInsidePolygon(p, polygon)),
    'the planner certifies the complete rear-axle trajectory and every benchmark sample remains inside the field');

  const maximumResult = await planCoverage({ polygon, params: Object.assign({}, request.params, {
    forwardSpeed: 6.0, reverseSpeed: 6.0,
  }) });
  check(maximumResult.items.some((p) => p.dir > 0 && Math.abs(p.speed - 6.0) < 1e-9) &&
    maximumResult.items.filter((p) => p.dir < 0).every((p) => Math.abs(p.speed - 6.0) < 1e-9),
    'real F2C output preserves the 6.00 m/s forward and any reverse maximum');

  const mixedPolygon = localPolygon([[0, 0], [50, 0], [45, 30], [25, 18], [0, 30]]);
  const mixedResult = await planCoverage({ polygon: mixedPolygon, params: Object.assign({}, request.params, {
    coverageWidth: 2.0, headland: 4.0,
  }) });
  check(mixedResult.forwardTurns > 0 && mixedResult.reverseTurns > 0,
    'irregular field selects wide forward arcs where they fit and fish-tail turns only where needed');
  check(mixedResult.minReverseRunM >= 1.0 - 1e-6,
    'mixed-turn field also rejects impractical short reverse pulses');
  console.log('\n  coverage planner test passed (' + result.items.length + ' samples).');
})().catch((error) => { console.error('  ✗ ' + error.message); process.exit(1); });
