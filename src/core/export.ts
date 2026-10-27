import type { Catalog, WalkingMatrix, Scenario, RouteComparison } from './types.ts';
function csvCell(value: unknown) {
  const text = String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

export function resultRows(routes: RouteComparison[], scenario: Scenario) {
  return routes.flatMap(({ id, label, result }) => result.stops.map((place, index) => ({
    algorithm: id,
    algorithm_label: label,
    budget_minutes: scenario.budgetMinutes,
    start_id: scenario.startId,
    stop_order: index + 1,
    place_id: place.id,
    place_name: place.name,
    zone: place.zone,
    coordinate_status: place.coordinateStatus,
    cumulative_walk_distance_m: result.segments.slice(0, index).reduce((sum, segment) => sum + segment.distanceMeters, 0),
    visit_minutes: scenario.visitMinutes,
    total_route_minutes: result.totalMinutes,
    budget_compliant: result.budgetCompliant,
    zone_reentry_count: result.zoneReentryCount,
    unique_zones_visited: result.uniqueZonesVisited,
  })));
}

export function toCsv(rows: Record<string, unknown>[]) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  return [headers.map(csvCell).join(','), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(','))].join('\r\n');
}

export function downloadFile(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function buildExperimentExport({ catalog, catalogHash, matrix, scenario, routes, protocol }: {
  catalog: Catalog; catalogHash: string; matrix: WalkingMatrix; scenario: Scenario;
  routes: RouteComparison[]; protocol: {protocol_version: string};
}) {
  return {
    schemaVersion: '1.0',
    exportedAt: new Date().toISOString(),
    protocolVersion: protocol.protocol_version,
    catalog: {
      title: catalog.title,
      generatedAt: catalog.generatedAt,
      fingerprint: catalogHash,
      includedPlaceIds: catalog.places.map((place) => place.id),
    },
    matrix: {
      ...matrix,
      distancesMeters: matrix.distancesMeters,
    },
    scenario,
    results: routes.map(({ id, label, result }) => ({
      algorithmId: id,
      algorithmLabel: label,
      ...result,
      stops: result.stops.map(({ id: placeId }) => placeId),
    })),
    disclaimer: 'Экспорт результата одного пользовательского сценария, не итоговая серия экспериментов. Координаты каталога могут быть кандидатными.',
  };
}
