import type { Place, PlannerInput, WalkingMatrix, RouteResult, Segment } from './types.ts';
interface Context extends PlannerInput { start: Place; indexById: Map<string, number> }
interface Candidate { place: Place; cost: {distanceMeters: number; walkMinutes: number; totalMinutes: number} }

function distanceBetween(matrix: WalkingMatrix, fromId: string, toId: string, indexById: Map<string, number>) {
  const from = indexById.get(fromId);
  const to = indexById.get(toId);
  const distance = from === undefined || to === undefined ? null : matrix.distancesMeters[from]?.[to];
  return typeof distance === 'number' && Number.isFinite(distance) && distance >= 0 ? distance : null;
}

function candidateCost(current: Place, candidate: Place, context: Context) {
  const distanceMeters = distanceBetween(context.matrix, current.id, candidate.id, context.indexById);
  if (distanceMeters === null) return null;
  const walkMinutes = distanceMeters / (context.walkingSpeedKmh * 1000 / 60);
  const totalMinutes = walkMinutes + context.visitMinutes;
  return { distanceMeters, walkMinutes, totalMinutes };
}

function compareCandidates(a: Candidate, b: Candidate) {
  return a.cost.distanceMeters - b.cost.distanceMeters || a.place.id.localeCompare(b.place.id, 'en');
}

function makeContext({ places, startId, budgetMinutes, visitMinutes, walkingSpeedKmh, matrix }: PlannerInput): Context {
  if (!Array.isArray(places) || places.length === 0) throw new Error('Нет объектов для построения маршрута.');
  if (!matrix?.distancesMeters || matrix.distancesMeters.length !== places.length) {
    throw new Error('Матрица пеших переходов не соответствует каталогу.');
  }
  if (!Number.isFinite(budgetMinutes) || budgetMinutes <= 0) throw new Error('Время прогулки должно быть положительным.');
  if (!Number.isFinite(visitMinutes) || visitMinutes < 0) throw new Error('Время остановки должно быть неотрицательным.');
  if (!Number.isFinite(walkingSpeedKmh) || walkingSpeedKmh <= 0) throw new Error('Скорость ходьбы должна быть положительной.');

  const indexById = new Map(places.map((place, index) => [place.id, index]));
  const start = places.find((place) => place.id === startId);
  if (!start) throw new Error('Выбранная точка старта отсутствует в каталоге.');
  if (visitMinutes > budgetMinutes) throw new Error('Время остановки на старте превышает бюджет прогулки.');

  return { places, start, startId, budgetMinutes, visitMinutes, walkingSpeedKmh, matrix, indexById };
}

function isFeasible(current: Place, candidate: Place, elapsedMinutes: number, context: Context) {
  const cost = candidateCost(current, candidate, context);
  return cost && elapsedMinutes + cost.totalMinutes <= context.budgetMinutes + 1e-9 ? cost : null;
}

function availableCandidates(current: Place, route: Place[], elapsedMinutes: number, context: Context, predicate: (place: Place) => boolean = () => true): Candidate[] {
  const visited = new Set(route.map((place) => place.id));
  visited.add(context.start.id);
  return context.places
    .filter((place) => !visited.has(place.id) && predicate(place))
    .map((place) => ({ place, cost: isFeasible(current, place, elapsedMinutes, context) }))
    .filter((entry): entry is Candidate => entry.cost !== null)
    .sort(compareCandidates);
}

function summarize(route: Place[], start: Place, context: Context): RouteResult {
  const stops = [start, ...route];
  const segments: Segment[] = [];
  let totalWalkDistanceMeters = 0;
  let totalWalkMinutes = 0;

  for (let index = 1; index < stops.length; index += 1) {
    const from = stops[index - 1];
    const to = stops[index];
    const distanceMeters = distanceBetween(context.matrix, from.id, to.id, context.indexById);
    if (distanceMeters === null) throw new Error(`В матрице нет пешего перехода ${from.id} → ${to.id}.`);
    const walkMinutes = distanceMeters / (context.walkingSpeedKmh * 1000 / 60);
    segments.push({ fromId: from.id, toId: to.id, distanceMeters, walkMinutes });
    totalWalkDistanceMeters += distanceMeters;
    totalWalkMinutes += walkMinutes;
  }

  const visitMinutes = stops.length * context.visitMinutes;
  const zoneSequence = stops.map((place) => place.zone).filter((zone, index, list) => index === 0 || zone !== list[index - 1]);
  const seenZones = new Set();
  let zoneReentryCount = 0;
  for (const zone of zoneSequence) {
    if (seenZones.has(zone)) zoneReentryCount += 1;
    seenZones.add(zone);
  }
  const zonesInInput = new Set(context.places.map((place) => place.zone));
  const totalMinutes = totalWalkMinutes + visitMinutes;

  return {
    stops,
    segments,
    totalWalkDistanceMeters,
    totalWalkMinutes,
    totalVisitMinutes: visitMinutes,
    totalMinutes,
    budgetMinutes: context.budgetMinutes,
    budgetCompliant: totalMinutes <= context.budgetMinutes + 1e-9,
    overrunMinutes: Math.max(0, totalMinutes - context.budgetMinutes),
    zoneSequence,
    zoneReentryCount,
    zoneTransitionCount: Math.max(0, stops.reduce((count, place, index) => count + (index > 0 && place.zone !== stops[index - 1].zone ? 1 : 0), 0)),
    uniqueZonesVisited: seenZones.size,
    zoneCoverageRatio: zonesInInput.size ? seenZones.size / zonesInInput.size : 0,
    endZoneDiffersFromStart: stops.at(-1)!.zone !== start.zone,
  };
}

export function nearestFeasibleRoute(input: PlannerInput) {
  const context = makeContext(input);
  const route: Place[] = [];
  let current = context.start;
  let elapsedMinutes = context.visitMinutes;

  while (true) {
    const next = availableCandidates(current, route, elapsedMinutes, context)[0];
    if (!next) break;
    route.push(next.place);
    elapsedMinutes += next.cost.totalMinutes;
    current = next.place;
  }

  return summarize(route, context.start, context);
}

export function buildZoneAdjacency(places: Place[], matrix: WalkingMatrix, walkingSpeedKmh: number, thresholdMinutes: number) {
  if (!Number.isFinite(walkingSpeedKmh) || walkingSpeedKmh <= 0 || !Number.isFinite(thresholdMinutes) || thresholdMinutes < 0) {
    throw new Error('Некорректные параметры соседства зон.');
  }
  const indexById = new Map(places.map((place, index) => [place.id, index]));
  const zones = [...new Set(places.map((place) => place.zone))].sort((a, b) => a.localeCompare(b, 'ru'));
  const adjacency = new Map(zones.map((zone) => [zone, new Set<string>()]));

  for (let firstIndex = 0; firstIndex < zones.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < zones.length; secondIndex += 1) {
      const firstZone = zones[firstIndex];
      const secondZone = zones[secondIndex];
      let minimumMeters = Infinity;
      for (const from of places.filter((place) => place.zone === firstZone)) {
        for (const to of places.filter((place) => place.zone === secondZone)) {
          const forward = distanceBetween(matrix, from.id, to.id, indexById);
          const backward = distanceBetween(matrix, to.id, from.id, indexById);
          if (forward !== null) minimumMeters = Math.min(minimumMeters, forward);
          if (backward !== null) minimumMeters = Math.min(minimumMeters, backward);
        }
      }
      const minimumMinutes = minimumMeters / (walkingSpeedKmh * 1000 / 60);
      if (minimumMinutes <= thresholdMinutes) {
        adjacency.get(firstZone)!.add(secondZone);
        adjacency.get(secondZone)!.add(firstZone);
      }
    }
  }
  return adjacency;
}

export function zoneProgressionRoute(input: PlannerInput) {
  const context = makeContext(input);
  const adjacency = input.zoneAdjacency || buildZoneAdjacency(
    context.places,
    context.matrix,
    context.walkingSpeedKmh,
    input.zoneNeighborThresholdMinutes ?? 12,
  );
  const route: Place[] = [];
  let current = context.start;
  let elapsedMinutes = context.visitMinutes;
  const enteredZones = new Set([context.start.zone]);

  while (true) {
    let candidates = availableCandidates(current, route, elapsedMinutes, context, (place) => place.zone === current.zone);
    if (!candidates.length) {
      const adjacentUnvisitedZones = adjacency.get(current.zone) || new Set();
      candidates = availableCandidates(
        current,
        route,
        elapsedMinutes,
        context,
        (place) => adjacentUnvisitedZones.has(place.zone) && !enteredZones.has(place.zone),
      ).sort((a, b) => a.cost.distanceMeters - b.cost.distanceMeters
        || a.place.zone.localeCompare(b.place.zone, 'ru')
        || a.place.id.localeCompare(b.place.id, 'en'));
    }
    if (!candidates.length) {
      candidates = availableCandidates(current, route, elapsedMinutes, context);
    }
    const next = candidates[0];
    if (!next) break;
    route.push(next.place);
    enteredZones.add(next.place.zone);
    elapsedMinutes += next.cost.totalMinutes;
    current = next.place;
  }

  return summarize(route, context.start, context);
}
