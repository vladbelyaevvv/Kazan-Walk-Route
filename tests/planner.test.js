import test from 'node:test';
import assert from 'node:assert/strict';
import { buildZoneAdjacency, nearestFeasibleRoute, zoneProgressionRoute } from '../src/core/planner.ts';

function setup() {
  const places = [
    { id: 'a-start', name: 'Start', zone: 'A', lat: 55, lon: 49, coordinateStatus: 'candidate' },
    { id: 'b-same-zone', name: 'Same zone', zone: 'A', lat: 55, lon: 49.001, coordinateStatus: 'candidate' },
    { id: 'c-nearby', name: 'Nearby other zone', zone: 'B', lat: 55, lon: 49.002, coordinateStatus: 'candidate' },
    { id: 'd-zone-b', name: 'Another place', zone: 'B', lat: 55, lon: 49.003, coordinateStatus: 'candidate' },
  ];
  const distancesMeters = [
    [0, 500, 100, 1000],
    [500, 0, 100, 300],
    [100, 100, 0, 100],
    [1000, 300, 100, 0],
  ];
  const matrix = { placeIds: places.map((place) => place.id), distancesMeters };
  return { places, matrix };
}

test('nearest feasible uses the same cost model and leaves the route open', () => {
  const { places, matrix } = setup();
  const result = nearestFeasibleRoute({ places, matrix, startId: 'a-start', budgetMinutes: 16, visitMinutes: 5, walkingSpeedKmh: 6 });
  assert.equal(result.stops[0].id, 'a-start');
  assert.notEqual(result.stops.at(-1).id, 'a-start');
  assert.ok(result.totalMinutes <= 16);
  assert.equal(result.totalVisitMinutes, result.stops.length * 5);
  assert.equal(result.budgetCompliant, true);
});

test('zone progression prefers a feasible place in the current zone', () => {
  const { places, matrix } = setup();
  const result = zoneProgressionRoute({ places, matrix, startId: 'a-start', budgetMinutes: 20, visitMinutes: 5, walkingSpeedKmh: 6, zoneNeighborThresholdMinutes: 12 });
  assert.equal(result.stops[1].id, 'b-same-zone');
  assert.equal(result.budgetCompliant, true);
  assert.equal(result.zoneReentryCount, 0);
});

test('zone adjacency follows the configured pedestrian-time threshold', () => {
  const { places, matrix } = setup();
  const tight = buildZoneAdjacency(places, matrix, 5, 1);
  const broad = buildZoneAdjacency(places, matrix, 5, 2);
  assert.equal(tight.get('A').has('B'), false);
  assert.equal(broad.get('A').has('B'), true);
});

test('invalid inputs, empty data and time-budget violations are handled', () => {
  const { places, matrix } = setup();
  assert.throws(() => nearestFeasibleRoute({ places: [], matrix, startId: 'a-start', budgetMinutes: 30, visitMinutes: 5, walkingSpeedKmh: 5 }), /Нет объектов/);
  assert.throws(() => nearestFeasibleRoute({ places, matrix, startId: 'missing', budgetMinutes: 30, visitMinutes: 5, walkingSpeedKmh: 5 }), /отсутствует в каталоге/);
  assert.throws(() => nearestFeasibleRoute({ places, matrix, startId: 'a-start', budgetMinutes: 2, visitMinutes: 5, walkingSpeedKmh: 5 }), /превышает бюджет/);
  assert.throws(() => zoneProgressionRoute({ places, matrix: {}, startId: 'a-start', budgetMinutes: 30, visitMinutes: 5, walkingSpeedKmh: 5 }), /Матрица/);
});

test('unreachable edges are skipped, not replaced by straight-line estimates', () => {
  const { places, matrix } = setup();
  matrix.distancesMeters[0][1] = null;
  matrix.distancesMeters[0][2] = null;
  matrix.distancesMeters[0][3] = null;
  const result = nearestFeasibleRoute({ places, matrix, startId: 'a-start', budgetMinutes: 90, visitMinutes: 5, walkingSpeedKmh: 5 });
  assert.deepEqual(result.stops.map((place) => place.id), ['a-start']);
  assert.equal(result.totalWalkDistanceMeters, 0);
});
