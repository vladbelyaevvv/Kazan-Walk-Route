import { catalogFingerprint } from './catalog.ts';
import type { Place, WalkingMatrix, Coordinate } from './types.ts';
type Location = Pick<Place, 'lat' | 'lon'>;
interface RoutingOptions {
  fetchImpl?: typeof fetch; baseUrl?: string; blockSize?: number; requestGapMs?: number;
  onProgress?: (progress: {completed: number; total: number}) => void;
}
interface MatrixPayload { distances?: (number | null)[][]; durations?: (number | null)[][] }
interface MatrixResponse extends MatrixPayload { sources_to_targets?: MatrixPayload; units?: string }

export const VALHALLA_BASE_URL = 'https://valhalla1.openstreetmap.de';
const MATRIX_CACHE_PREFIX = 'kazan-walk-route:pedestrian-matrix:';
const MATRIX_BLOCK_SIZE = 10;
const PUBLIC_REQUEST_GAP_MS = 1100;
let lastPublicRequestStartedAt: number | null = null;

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function respectPublicRequestGap(requestGapMs: number) {
  if (lastPublicRequestStartedAt !== null) {
    const elapsed = Date.now() - lastPublicRequestStartedAt;
    if (elapsed < requestGapMs) await wait(requestGapMs - elapsed);
  }
  lastPublicRequestStartedAt = Date.now();
}

async function apiErrorMessage(response: Response, operation: string) {
  const responseBody = await response.text().catch(() => '');
  let detail = responseBody.trim();
  try {
    const payload = JSON.parse(detail);
    detail = [payload.error_code ? `код ${payload.error_code}` : '', payload.error]
      .filter(Boolean)
      .join(': ');
  } catch {
    // Retain a non-JSON server response for diagnostics.
  }
  return `${operation} (HTTP ${response.status})${detail ? `: ${detail}` : '.'}`;
}

async function requestMatrixBlock(sources: Location[], targets: Location[], { fetchImpl, baseUrl, requestGapMs }: Required<Pick<RoutingOptions, 'fetchImpl' | 'baseUrl' | 'requestGapMs'>>): Promise<MatrixResponse> {
  await respectPublicRequestGap(requestGapMs);
  const response = await fetchImpl(`${baseUrl}/sources_to_targets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sources,
      targets,
      costing: 'pedestrian',
      units: 'kilometers',
      verbose: false,
    }),
  });
  if (!response.ok) {
    throw new Error(await apiErrorMessage(response, 'Матрица пеших переходов не получена'));
  }
  return response.json();
}

function normalizeMatrix(values: (number | null)[][] | (number | null)[], size: number, placeIds: string[]) {
  if (!Array.isArray(values)) throw new Error('Ответ маршрутизатора не содержит матрицу расстояний.');
  let rows = values as (number | null)[][];
  if (values.length === size * size && !Array.isArray(values[0])) {
    const flat = values as (number | null)[];
    rows = Array.from({ length: size }, (_, index) => flat.slice(index * size, (index + 1) * size));
  }
  if (rows.length !== size || rows.some((row) => !Array.isArray(row) || row.length !== size)) {
    throw new Error(`Размер матрицы не совпадает с каталогом (${size} × ${size}).`);
  }
  return rows.map((row, rowIndex) => row.map((value, columnIndex) => {
    if (value === null) return null;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) {
      throw new Error(`Некорректное расстояние в матрице: ${placeIds[rowIndex]} → ${placeIds[columnIndex]}.`);
    }
    return number * 1000;
  }));
}

export function normalizeValhallaMatrix(payload: MatrixResponse, places: Place[]): WalkingMatrix {
  const size = places.length;
  const matrixPayload = payload?.sources_to_targets || payload;
  const distances = matrixPayload?.distances;
  if (!Array.isArray(distances)) throw new Error('В ответе Valhalla отсутствует поле distances.');
  const placeIds = places.map((place) => place.id);
  const distancesMeters = normalizeMatrix(distances, size, placeIds);
  const durationsSeconds = Array.isArray(matrixPayload?.durations)
    ? matrixPayload.durations
    : null;

  return {
    placeIds,
    distancesMeters,
    durationsSeconds,
    engine: 'Valhalla',
    costing: 'pedestrian',
    unitsReceived: payload?.units || 'kilometers',
    retrievedAt: new Date().toISOString(),
    catalogFingerprint: catalogFingerprint(places),
  };
}

export async function fetchWalkingMatrix(places: Place[], {
  fetchImpl = fetch,
  baseUrl = VALHALLA_BASE_URL,
  blockSize = MATRIX_BLOCK_SIZE,
  requestGapMs = PUBLIC_REQUEST_GAP_MS,
  onProgress = () => {},
}: RoutingOptions = {}): Promise<WalkingMatrix> {
  if (!Array.isArray(places) || places.length < 2) throw new Error('Для матрицы нужно не менее двух мест.');
  if (!Number.isInteger(blockSize) || blockSize < 1 || blockSize * blockSize > 100) {
    throw new Error('Размер блока матрицы должен давать не более 100 пар источник–цель.');
  }
  const locations = places.map(({ lat, lon }) => ({ lat, lon }));
  const blockCount = Math.ceil(locations.length / blockSize);
  const requestCount = blockCount * blockCount;
  const distances: (number | null)[][] = Array.from({ length: places.length }, () => Array(places.length).fill(null));
  const durations: (number | null)[][] = Array.from({ length: places.length }, () => Array(places.length).fill(null));
  let completed = 0;

  for (let sourceStart = 0; sourceStart < places.length; sourceStart += blockSize) {
    const sourceEnd = Math.min(sourceStart + blockSize, places.length);
    for (let targetStart = 0; targetStart < places.length; targetStart += blockSize) {
      const targetEnd = Math.min(targetStart + blockSize, places.length);
      const payload = await requestMatrixBlock(
        locations.slice(sourceStart, sourceEnd),
        locations.slice(targetStart, targetEnd),
        { fetchImpl, baseUrl, requestGapMs },
      );
      const matrixPayload = payload?.sources_to_targets || payload;
      const blockDistances = matrixPayload?.distances;
      const blockDurations = matrixPayload?.durations;
      const sourceCount = sourceEnd - sourceStart;
      const targetCount = targetEnd - targetStart;
      if (!Array.isArray(blockDistances) || blockDistances.length !== sourceCount
        || blockDistances.some((row) => !Array.isArray(row) || row.length !== targetCount)) {
        throw new Error(`Valhalla вернула неполный блок матрицы ${sourceStart}:${sourceEnd} × ${targetStart}:${targetEnd}.`);
      }
      for (let row = 0; row < sourceCount; row += 1) {
        for (let column = 0; column < targetCount; column += 1) {
          distances[sourceStart + row][targetStart + column] = blockDistances[row][column];
          if (Array.isArray(blockDurations?.[row])) {
            durations[sourceStart + row][targetStart + column] = blockDurations[row][column] ?? null;
          }
        }
      }
      completed += 1;
      onProgress({ completed, total: requestCount });
    }
  }

  const matrix = normalizeValhallaMatrix({
    units: 'kilometers',
    sources_to_targets: { distances, durations },
  }, places);
  return {
    ...matrix,
    requestCount,
    maxPairsPerRequest: blockSize * blockSize,
    minimumRequestGapMs: requestGapMs,
  };
}

export function matrixCacheKey(places: Place[]) {
  return `${MATRIX_CACHE_PREFIX}${catalogFingerprint(places)}`;
}

export function readCachedMatrix(places: Place[], storage = globalThis.localStorage): WalkingMatrix | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(matrixCacheKey(places));
    if (!raw) return null;
    const matrix = JSON.parse(raw);
    if (matrix.catalogFingerprint !== catalogFingerprint(places)) return null;
    if (matrix.placeIds?.join('|') !== places.map((place) => place.id).join('|')) return null;
    if (matrix.distancesMeters?.length !== places.length) return null;
    return matrix;
  } catch {
    return null;
  }
}

export function cacheMatrix(matrix: WalkingMatrix, places: Place[], storage = globalThis.localStorage) {
  if (!storage) return false;
  try {
    storage.setItem(matrixCacheKey(places), JSON.stringify(matrix));
    return true;
  } catch {
    return false;
  }
}

export function decodePolyline6(encoded: string): Coordinate[] {
  if (typeof encoded !== 'string') throw new Error('Маршрутизатор вернул некорректную геометрию.');
  let index = 0;
  let lat = 0;
  let lon = 0;
  const points: Coordinate[] = [];
  const decodeValue = () => {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      if (index >= encoded.length) throw new Error('Повреждена геометрия маршрута.');
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };

  while (index < encoded.length) {
    lat += decodeValue();
    lon += decodeValue();
    points.push([lat / 1e6, lon / 1e6]);
  }
  return points;
}

export async function fetchRouteShape(places: Place[], {
  fetchImpl = fetch,
  baseUrl = VALHALLA_BASE_URL,
  requestGapMs = PUBLIC_REQUEST_GAP_MS,
}: RoutingOptions = {}): Promise<Coordinate[]> {
  if (!Array.isArray(places) || places.length < 2) return [];
  const maxLocations = 10;
  const points: Coordinate[] = [];

  for (let startIndex = 0; startIndex < places.length - 1; startIndex += maxLocations - 1) {
    const chunk = places.slice(startIndex, startIndex + maxLocations);
    await respectPublicRequestGap(requestGapMs);
    const response = await fetchImpl(`${baseUrl}/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        locations: chunk.map(({ lat, lon }) => ({ lat, lon })),
        costing: 'pedestrian',
        units: 'kilometers',
        shape_format: 'polyline6',
        language: 'ru-RU',
      }),
    });
    if (!response.ok) throw new Error(await apiErrorMessage(response, 'Геометрия пешего пути не получена'));
    const payload = await response.json();
    const legs = payload?.trip?.legs;
    if (!Array.isArray(legs) || legs.length === 0) throw new Error('Маршрутизатор не вернул участки пути.');
    const chunkPoints: Coordinate[] = legs.flatMap((leg: {shape: string}) => decodePolyline6(leg.shape));
    points.push(...(points.length ? chunkPoints.slice(1) : chunkPoints));
  }

  return points;
}
