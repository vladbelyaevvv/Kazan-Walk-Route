import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchRouteShape, fetchWalkingMatrix, normalizeValhallaMatrix } from '../src/core/routing.ts';

const places = [
  { id: 'p1', lat: 55, lon: 49 },
  { id: 'p2', lat: 55.01, lon: 49.01 },
];

test('Valhalla response is converted from kilometers to meters and null stays unreachable', () => {
  const matrix = normalizeValhallaMatrix({
    units: 'kilometers',
    sources_to_targets: {
      distances: [[0, 1.25], [null, 0]],
      durations: [[0, 900], [null, 0]],
    },
  }, places);
  assert.deepEqual(matrix.distancesMeters, [[0, 1250], [null, 0]]);
  assert.deepEqual(matrix.placeIds, ['p1', 'p2']);
});

test('small catalog matrix is requested in one batch', async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ sources_to_targets: { distances: [[0, 1], [1, 0]], durations: [[0, 100], [100, 0]] } }) };
  };
  const matrix = await fetchWalkingMatrix(places, { fetchImpl, baseUrl: 'https://routing.test' });
  assert.equal(captured.url, 'https://routing.test/sources_to_targets');
  assert.equal(captured.body.costing, 'pedestrian');
  assert.equal(captured.body.sources.length, 2);
  assert.equal(captured.body.targets.length, 2);
  assert.equal(matrix.distancesMeters[0][1], 1000);
});

test('large catalog matrix is split into blocks of at most 100 pairs and reassembled', async () => {
  const manyPlaces = Array.from({ length: 11 }, (_, index) => ({
    id: `p${index}`,
    lat: 55 + index,
    lon: 49 + index,
  }));
  const requests = [];
  const progress = [];
  const matrix = await fetchWalkingMatrix(manyPlaces, {
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      const distances = body.sources.map((source) => body.targets.map((target) =>
        (source.lat - 55) + (target.lat - 55) / 100));
      return { ok: true, json: async () => ({ sources_to_targets: { distances } }) };
    },
    baseUrl: 'https://routing.test',
    requestGapMs: 0,
    onProgress: (value) => progress.push(value),
  });

  assert.equal(requests.length, 4);
  assert.ok(requests.every((request) => request.sources.length * request.targets.length <= 100));
  assert.equal(matrix.distancesMeters.length, 11);
  assert.equal(matrix.distancesMeters[10][0], 10000);
  assert.equal(matrix.distancesMeters[0][10], 100);
  assert.deepEqual(progress.at(-1), { completed: 4, total: 4 });
});

test('route geometry is split into at most ten locations with one shared endpoint', async () => {
  const manyPlaces = Array.from({ length: 17 }, (_, index) => ({
    id: `p${index}`,
    lat: 55 + index / 100,
    lon: 49 + index / 100,
  }));
  const requests = [];
  const line = await fetchRouteShape(manyPlaces, {
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      return {
        ok: true,
        json: async () => ({ trip: { legs: Array.from({ length: body.locations.length - 1 }, () => ({ shape: '??' })) } }),
      };
    },
    baseUrl: 'https://routing.test',
    requestGapMs: 0,
  });

  assert.deepEqual(requests.map((request) => request.locations.length), [10, 8]);
  assert.equal(requests[0].locations.at(-1).lat, requests[1].locations[0].lat);
  assert.equal(line.length, 15);
});

test('incomplete matrices and network errors fail explicitly', async () => {
  await assert.rejects(() => fetchWalkingMatrix(places, {
    fetchImpl: async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error_code: 150, error: 'Exceeded max locations: 100' }) }),
    baseUrl: 'https://routing.test',
    requestGapMs: 0,
  }), /HTTP 400\): код 150: Exceeded max locations: 100/);
  assert.throws(() => normalizeValhallaMatrix({ distances: [[0], [0]] }, places), /Размер матрицы/);
});
