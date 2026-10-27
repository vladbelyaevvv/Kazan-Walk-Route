import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { validateCatalog } from '../core/catalog.ts';
import { fetchWalkingMatrix } from '../core/routing.ts';
import { buildZoneAdjacency, nearestFeasibleRoute, zoneProgressionRoute } from '../core/planner.ts';

// Run with tsx: imports are the production TypeScript implementations.
const root = fileURLToPath(new URL('../../', import.meta.url));
const offline = process.argv.includes('--offline');
const runName = process.env.KAZAN_RUN_ID || 'stage5-v1';
if (!/^[a-zA-Z0-9_-]+$/.test(runName)) throw new Error('Invalid run ID');
const runDir = path.join(root, 'data/raw', runName);
if (!offline && fs.existsSync(path.join(runDir, 'results.json'))) {
  throw new Error('This run already has archived results. Use --offline to reproduce or a new KAZAN_RUN_ID for a new series.');
}
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const read = (file) => fs.readFileSync(path.join(root, file));
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, object) => fs.writeFileSync(file, JSON.stringify(object, null, 2) + '\n');
const collect = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
  const relative = `${dir}/${entry.name}`;
  return entry.isDirectory() ? collect(relative) : [relative];
});
const files = [...collect('src'), 'package.json', 'package-lock.json', 'tsconfig.json',
  'configs/experiments.json', 'data/places_catalog_full.json', 'docs/experiment_protocol.md', 'docs/run_decisions.md'].sort();
fs.mkdirSync(runDir, { recursive: true });
const config = JSON.parse(read('configs/experiments.json'));
const catalog = validateCatalog(JSON.parse(read(config.dataset.path)));
const datasetHash = hash(read(config.dataset.path));
const configHash = hash(read('configs/experiments.json'));
const sourceFiles = files.map((file) => ({ file, sha256: hash(read(file)) }));
const codeHash = hash(JSON.stringify(sourceFiles));
const snapshotPath = path.join(runDir, 'snapshot_manifest.json');
if (fs.existsSync(snapshotPath)) {
  const previous = json(snapshotPath);
  assert.equal(previous.datasetHash, datasetHash, 'Dataset changed: choose a new KAZAN_RUN_ID');
  assert.equal(previous.configHash, configHash, 'Config changed: choose a new KAZAN_RUN_ID');
  if (!offline) assert.equal(previous.codeHash, codeHash, 'Code changed: choose a new KAZAN_RUN_ID');
} else {
  if (offline) throw new Error('No archived run to reproduce');
  write(snapshotPath, { createdAt: new Date().toISOString(), datasetHash, configHash, codeHash, files: sourceFiles });
  for (const file of files) {
    const destination = path.join(runDir, 'snapshot', file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, file), destination);
  }
}
assert.equal(catalog.places.length, config.dataset.expected_place_count);
assert.equal(new Set(catalog.places.map((place) => place.zone)).size, config.dataset.expected_zone_count);
assert.ok(catalog.places.every((place) => place.coordinateStatus === 'verified'));
const matrixPath = path.join(runDir, 'matrix.json');
let matrix;
if (fs.existsSync(matrixPath)) matrix = json(matrixPath);
else {
  if (offline) throw new Error('No saved matrix');
  const networkDir = path.join(runDir, 'network');
  fs.mkdirSync(networkDir, { recursive: true });
  let requestIndex = 0;
  const captureFetch = async (url, options = {}) => {
    const index = ++requestIndex;
    const record = { url, method: options.method || 'GET', requestBody: options.body ? JSON.parse(options.body) : null,
      requestAt: new Date().toISOString() };
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(60000) });
      const body = await response.text();
      write(path.join(networkDir, `${String(index).padStart(3, '0')}.json`), {
        ...record, responseAt: new Date().toISOString(), status: response.status,
        headers: Object.fromEntries(response.headers), responseBody: body,
      });
      return new Response(body, { status: response.status, headers: response.headers });
    } catch (error) {
      write(path.join(networkDir, `${String(index).padStart(3, '0')}.json`), { ...record, error: String(error) });
      throw error;
    }
  };
  // Status is diagnostic; an unavailable field remains unknown.
  let status = null;
  try {
    const response = await captureFetch('https://valhalla1.openstreetmap.de/status');
    if (response.ok) status = await response.json();
  } catch (error) { console.warn('Engine status unavailable:', String(error)); }
  await new Promise((resolve) => setTimeout(resolve, 1200));
  matrix = await fetchWalkingMatrix(catalog.places, { fetchImpl: captureFetch,
    onProgress: ({ completed, total }) => console.log(`matrix ${completed}/${total}`) });
  write(matrixPath, matrix);
  write(path.join(runDir, 'routing_manifest.json'), {
    datasetHash, placeIdOrder: matrix.placeIds, provider: 'https://valhalla1.openstreetmap.de',
    costing: 'pedestrian', engineStatus: status, engineVersion: status?.version ?? null,
    graphSnapshotDate: status?.tileset_last_modified ?? null,
    graphSource: 'OpenStreetMap (Valhalla documentation)', matrixHash: hash(fs.readFileSync(matrixPath)),
    requestCount: matrix.requestCount, retrievedAt: matrix.retrievedAt,
  });
}
assert.deepEqual(matrix.placeIds, catalog.places.map((place) => place.id));
assert.equal(matrix.distancesMeters.length, catalog.places.length);
for (const row of matrix.distancesMeters) {
  assert.equal(row.length, catalog.places.length);
  assert.ok(row.every((value) => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)));
}
const n = catalog.places.length;
const algorithms = { nearest_feasible: nearestFeasibleRoute, zone_progression_greedy: zoneProgressionRoute };
const base = { speed: config.time_model.walking_speed_kmh_primary,
  dwell: config.time_model.visit_minutes_per_place_primary, threshold: config.zones.primary_threshold_minutes };
const graph = (threshold) => buildZoneAdjacency(catalog.places, matrix, base.speed, threshold);
const baseGraph = graph(base.threshold);
const profiles = [ { id: 'primary', ...base },
  ...config.time_model.walking_speed_sensitivity_kmh.map((speed) => ({ id: `speed_${speed}`, ...base, speed })),
  ...config.time_model.visit_minutes_sensitivity.map((dwell) => ({ id: `dwell_${dwell}`, ...base, dwell })),
  ...config.zones.sensitivity_threshold_minutes.map((threshold) => ({ id: `threshold_${threshold}`, ...base, threshold })),
];
write(path.join(runDir, offline ? 'offline_environment.json' : 'environment.json'), {
  recordedAt: new Date().toISOString(), node: process.version, platform: process.platform,
  architecture: process.arch, os: os.release(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length,
  totalMemoryBytes: os.totalmem(), runtime: 'Node.js via tsx; not browser timing',
  packageVersions: json(path.join(root, 'package-lock.json')).packages,
});
function validate(result, scenario) {
  assert.equal(result.stops[0].id, scenario.startId);
  assert.equal(new Set(result.stops.map((place) => place.id)).size, result.stops.length);
  let distance = 0;
  for (let index = 1; index < result.stops.length; index++) {
    const from = matrix.placeIds.indexOf(result.stops[index - 1].id);
    const to = matrix.placeIds.indexOf(result.stops[index].id);
    const edge = matrix.distancesMeters[from][to];
    assert.notEqual(edge, null); distance += edge;
  }
  const time = distance / (scenario.walkingSpeedKmh * 1000 / 60) + result.stops.length * scenario.visitMinutes;
  assert.ok(Math.abs(time - result.totalMinutes) < 1e-8);
  assert.ok(time <= scenario.budgetMinutes + 1e-9);
  assert.ok(result.budgetCompliant);
  assert.equal(result.overrunMinutes, 0);
  const compressed = result.stops.map((place) => place.zone).filter((zone, index, zones) => index === 0 || zone !== zones[index - 1]);
  const seen = new Set(); let reentries = 0;
  for (const zone of compressed) { if (seen.has(zone)) reentries++; seen.add(zone); }
  assert.equal(reentries, result.zoneReentryCount);
  assert.equal(seen.size, result.uniqueZonesVisited);
}
const makeInput = (profile, startId, budgetMinutes) => ({ places: catalog.places, matrix, startId,
  budgetMinutes, visitMinutes: profile.dwell, walkingSpeedKmh: profile.speed,
  zoneNeighborThresholdMinutes: profile.threshold,
  zoneAdjacency: profile.threshold === base.threshold ? baseGraph : graph(profile.threshold),
});
const trialInput = makeInput(profiles[0], catalog.places[0].id, 90);
const trial = Object.entries(algorithms).map(([id, algorithm]) => {
  const first = algorithm(trialInput); const second = algorithm(trialInput);
  assert.deepEqual(first, second); validate(first, trialInput);
  return { algorithm: id, scenario: { startId: trialInput.startId, budgetMinutes: 90 }, deterministic: true,
    stopIds: first.stops.map((place) => place.id), totalMinutes: first.totalMinutes };
});
const trialPath = path.join(runDir, 'trial.json');
if (!fs.existsSync(trialPath)) write(trialPath, trial);
else assert.deepEqual(json(trialPath), trial);
console.log('Trial: two exact repetitions per algorithm passed');

let state = config.randomness.order_randomization_seed >>> 0;
const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
const rows = []; const errors = []; const runtime = [];
const timing = config.metrics.runtime;
let checksumSink = 0;
for (const profile of profiles) {
  for (const place of catalog.places) for (const budget of config.scenario_design.budgets_minutes) {
    const input = makeInput(profile, place.id, budget);
    const order = next() < 0.5 ? Object.keys(algorithms) : Object.keys(algorithms).reverse();
    for (const id of order) {
      try {
        const result = algorithms[id](input); validate(result, input);
        rows.push({ profile: profile.id, algorithm: id, startId: place.id, startZone: place.zone,
          budgetMinutes: budget, walkingSpeedKmh: profile.speed, visitMinutes: profile.dwell,
          zoneNeighborThresholdMinutes: profile.threshold, ...result, stops: result.stops.map((stop) => stop.id) });
        if (profile.id === 'primary' && !offline) {
          for (let index = 0; index < timing.warmup_runs; index++) checksumSink += algorithms[id](input).stops.length;
          const batches = [];
          for (let batch = 0; batch < timing.batches; batch++) {
            const started = performance.now();
            for (let run = 0; run < timing.runs_per_batch; run++) checksumSink += algorithms[id](input).stops.length;
            batches.push((performance.now() - started) / timing.runs_per_batch);
          }
          runtime.push({ algorithm: id, startId: place.id, budgetMinutes: budget, millisecondsPerCallByBatch: batches });
        }
      } catch (error) { errors.push({ profile: profile.id, algorithm: id, startId: place.id, budget, error: String(error) }); }
    }
  }
  console.log(`${profile.id}: ${rows.filter((row) => row.profile === profile.id).length} results`);
}
const rawPath = path.join(runDir, 'results.json');
if (offline) {
  assert.deepEqual(rows, json(rawPath));
  write(path.join(runDir, 'offline_verification.json'), { checkedAt: new Date().toISOString(), exactMatch: true,
    resultCount: rows.length, errors, originalResultHash: hash(fs.readFileSync(rawPath)), currentCodeHash: codeHash,
    archivedCodeHash: json(snapshotPath).codeHash });
  console.log('Offline reproduction: exact match for all result records');
} else {
  if (fs.existsSync(rawPath)) throw new Error('Raw results already exist; use --offline or a new KAZAN_RUN_ID');
  write(rawPath, rows); // Raw records are persisted BEFORE aggregation.
  write(path.join(runDir, 'runtime.json'), runtime);
  write(path.join(runDir, 'errors.json'), errors);
  write(path.join(runDir, 'run_manifest.json'), { runName, finishedAt: new Date().toISOString(),
    classification: 'computational scenario study; not real-world route validation',
    datasetHash, configHash, codeHash, matrixHash: hash(fs.readFileSync(matrixPath)),
    resultsHash: hash(fs.readFileSync(rawPath)), runtimeHash: hash(fs.readFileSync(path.join(runDir, 'runtime.json'))),
    expectedPrimaryResults: n * config.scenario_design.budgets_minutes.length * 2,
    expectedAllResults: n * config.scenario_design.budgets_minutes.length * 2 * profiles.length,
    profiles, actualResults: rows.length, errors: errors.length, checksumSink,
    zoneAdjacency: Object.fromEntries([...baseGraph].map(([zone, neighbors]) => [zone, [...neighbors].sort()])),
    notPerformed: ['coordinate jitter: no test engine/explicitly permitted bulk endpoint',
      'exclude-unverified sensitivity: not applicable, all active records verified',
      'browser runtime: timings collected in Node.js'],
  });
  console.log(`Saved immutable raw results: ${rawPath}`);
}
if (errors.length) process.exitCode = 1;
