import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const run = process.env.KAZAN_RUN_ID || 'stage5-v1';
const raw = path.join(root, 'data/raw', run);
const load = (name) => JSON.parse(fs.readFileSync(path.join(raw, name), 'utf8'));
const rows = load('results.json');
const manifest = load('run_manifest.json');
const timings = load('runtime.json');
const snapshot = load('snapshot_manifest.json');
const catalog = JSON.parse(fs.readFileSync(path.join(raw, 'snapshot/data/places_catalog_full.json'), 'utf8'));
const matrix = load('matrix.json');
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
assert.equal(sha(path.join(raw, 'results.json')), manifest.resultsHash);
assert.equal(sha(path.join(raw, 'matrix.json')), manifest.matrixHash);
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const total = (values) => values.reduce((sum, value) => sum + value, 0);
const quantile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b); const position = (sorted.length - 1) * p;
  const lo = Math.floor(position); return sorted[lo] + (sorted[Math.ceil(position)] - sorted[lo]) * (position - lo);
};
const describe = (values) => ({ n: values.length, mean: mean(values), median: quantile(values, 0.5),
  q1: quantile(values, 0.25), q3: quantile(values, 0.75), min: Math.min(...values), max: Math.max(...values) });
const algorithms = ['nearest_feasible', 'zone_progression_greedy'];
const labels = { nearest_feasible: 'Базовый', zone_progression_greedy: 'Зональный' };
const profiles = [...new Set(rows.map((row) => row.profile))];
const primary = rows.filter((row) => row.profile === 'primary');
const key = (row) => `${row.profile}|${row.startId}|${row.budgetMinutes}|${row.algorithm}`;
const keys = new Set(rows.map(key));
assert.equal(keys.size, rows.length, 'Duplicate result keys');
assert.equal(rows.length, manifest.expectedAllResults, 'Missing results');
assert.equal(primary.length, manifest.expectedPrimaryResults);
const fieldNames = ['totalWalkDistanceMeters', 'totalWalkMinutes', 'totalVisitMinutes', 'totalMinutes',
  'zoneReentryCount', 'zoneTransitionCount', 'uniqueZonesVisited', 'zoneCoverageRatio'];
const summarize = (group) => ({ count: group.length,
  compliance: group.filter((row) => row.budgetCompliant).length / group.length,
  visited: describe(group.map((row) => row.stops.length)),
  visitedTotal: total(group.map((row) => row.stops.length)),
  reentriesTotal: total(group.map((row) => row.zoneReentryCount)),
  ...Object.fromEntries(fieldNames.map((field) => [field, describe(group.map((row) => row[field]))])),
});
const stats = Object.fromEntries(algorithms.map((id) => [id, summarize(primary.filter((row) => row.algorithm === id))]));
const byBudget = [60, 90, 120, 180, 240].flatMap((budget) => algorithms.map((algorithm) => ({ budget, algorithm,
  ...summarize(primary.filter((row) => row.budgetMinutes === budget && row.algorithm === algorithm)) })));
const byStartZone = [...new Set(catalog.places.map((place) => place.zone))].flatMap((zone) => algorithms.map((algorithm) => ({ zone, algorithm,
  ...summarize(primary.filter((row) => row.startZone === zone && row.algorithm === algorithm)) })));
const paired = profiles.flatMap((profile) => rows.filter((row) => row.profile === profile && row.algorithm === algorithms[0]).map((baseline) => {
  const zonal = rows.find((row) => row.profile === profile && row.algorithm === algorithms[1] && row.startId === baseline.startId && row.budgetMinutes === baseline.budgetMinutes);
  assert.ok(zonal);
  return { profile, startId: baseline.startId, budgetMinutes: baseline.budgetMinutes,
    baselineStops: baseline.stops.length, zonalStops: zonal.stops.length,
    stopsDifference: zonal.stops.length - baseline.stops.length,
    reentriesDifference: zonal.zoneReentryCount - baseline.zoneReentryCount,
    distanceDifferenceMeters: zonal.totalWalkDistanceMeters - baseline.totalWalkDistanceMeters,
    zonesDifference: zonal.uniqueZonesVisited - baseline.uniqueZonesVisited,
    sameStopOrder: JSON.stringify(zonal.stops) === JSON.stringify(baseline.stops),
  };
}));
const sensitivity = profiles.map((profile) => {
  const b = summarize(rows.filter((row) => row.profile === profile && row.algorithm === algorithms[0]));
  const z = summarize(rows.filter((row) => row.profile === profile && row.algorithm === algorithms[1]));
  const pairs = paired.filter((row) => row.profile === profile);
  return { profile, baselineVisits: b.visitedTotal, zonalVisits: z.visitedTotal,
    visitRetention: z.visitedTotal / b.visitedTotal,
    baselineReentries: b.reentriesTotal, zonalReentries: z.reentriesTotal,
    baselineDistanceMean: b.totalWalkDistanceMeters.mean, zonalDistanceMean: z.totalWalkDistanceMeters.mean,
    baselineZonesMean: b.uniqueZonesVisited.mean, zonalZonesMean: z.uniqueZonesVisited.mean,
    compliance: Math.min(b.compliance, z.compliance),
    supportRule: z.reentriesTotal < b.reentriesTotal && z.visitedTotal / b.visitedTotal >= 0.9 && b.compliance === 1 && z.compliance === 1,
    moreVisits: pairs.filter((pair) => pair.stopsDifference > 0).length,
    equalVisits: pairs.filter((pair) => pair.stopsDifference === 0).length,
    fewerVisits: pairs.filter((pair) => pair.stopsDifference < 0).length,
    fewerReentries: pairs.filter((pair) => pair.reentriesDifference < 0).length,
    equalReentries: pairs.filter((pair) => pair.reentriesDifference === 0).length,
    moreReentries: pairs.filter((pair) => pair.reentriesDifference > 0).length,
    sameRouteCount: pairs.filter((pair) => pair.sameStopOrder).length,
  };
});
const runtime = algorithms.map((algorithm) => {
  const group = timings.filter((record) => record.algorithm === algorithm);
  return { algorithm, ...describe(group.map((record) => quantile(record.millisecondsPerCallByBatch, 0.5))),
    rawBatchCount: total(group.map((record) => record.millisecondsPerCallByBatch.length)) };
});
const timingFlags = timings.flatMap((record) => {
  const values = record.millisecondsPerCallByBatch;
  const q1 = quantile(values, .25), q3 = quantile(values, .75), iqr = q3 - q1;
  return values.flatMap((value, index) => value > q3 + 1.5 * iqr ? [{ algorithm: record.algorithm,
    startId: record.startId, budgetMinutes: record.budgetMinutes, batch: index, millisecondsPerCall: value,
    method: 'within-scenario upper Tukey fence; retained' }] : []);
});
const minimalSlack = [...primary].sort((a, b) => (a.budgetMinutes - a.totalMinutes) - (b.budgetMinutes - b.totalMinutes))[0];
const zeroOffDiagonal = matrix.distancesMeters.flatMap((row, i) => row.flatMap((value, j) => i !== j && value === 0 ? [{ from: matrix.placeIds[i], to: matrix.placeIds[j] }] : []));
const invalidRows = rows.filter((row) => !row.budgetCompliant || !Number.isFinite(row.totalMinutes) || row.overrunMinutes > 1e-9);
const neighbors = Object.entries(manifest.zoneAdjacency);
const adjacencyEdges = neighbors.reduce((count, [, adjacent]) => count + adjacent.length, 0) / 2;
const examples = [...paired.filter((row) => row.profile === 'primary')]
  .sort((a, b) => a.stopsDifference - b.stopsDifference || a.reentriesDifference - b.reentriesDifference)
  .slice(0, 3).map((pair) => ({ pair, routes: primary.filter((row) => row.startId === pair.startId && row.budgetMinutes === pair.budgetMinutes) }));
const output = { generatedAt: new Date().toISOString(), run, manifest, snapshot, stats, byBudget, byStartZone,
  sensitivity, runtime, adjacencyEdges, adjacency: manifest.zoneAdjacency,
  quality: { expectedRows: manifest.expectedAllResults, actualRows: rows.length, primaryRows: primary.length,
    uniqueKeys: keys.size, errors: load('errors.json').length, invalidRows: invalidRows.length,
    unavailableEdges: matrix.distancesMeters.flat().filter((value) => value === null).length,
    zeroOffDiagonal, timingFlags: timingFlags.length,
    minimalSlackMinutes: minimalSlack.budgetMinutes - minimalSlack.totalMinutes }, examples };
const processed = path.join(root, 'data/processed', run);
const tables = path.join(root, 'reports/tables');
fs.mkdirSync(processed, { recursive: true }); fs.mkdirSync(tables, { recursive: true });
fs.writeFileSync(path.join(processed, 'summary.json'), JSON.stringify(output, null, 2) + '\n');
fs.writeFileSync(path.join(processed, 'paired.json'), JSON.stringify(paired, null, 2) + '\n');
const csv = (file, records) => {
  if (!records.length) { fs.writeFileSync(path.join(tables, file), ''); return; }
  const fields = Object.keys(records[0]);
  const cell = (value) => '"' + String(value ?? '').replaceAll('"', '""') + '"';
  fs.writeFileSync(path.join(tables, file), '\uFEFF' + [fields.map(cell).join(','), ...records.map((record) => fields.map((field) => cell(record[field])).join(','))].join('\n') + '\n');
};
csv('scenario_metrics.csv', rows.map((row) => ({ profile: row.profile, algorithm: row.algorithm, startId: row.startId,
  budgetMinutes: row.budgetMinutes, visited: row.stops.length, distanceMeters: row.totalWalkDistanceMeters,
  totalMinutes: row.totalMinutes, reentries: row.zoneReentryCount, uniqueZones: row.uniqueZonesVisited, compliant: row.budgetCompliant })));
csv('paired_comparison.csv', paired);
csv('sensitivity.csv', sensitivity);
csv('runtime.csv', runtime);
csv('timing_anomalies.csv', timingFlags);
csv('budget_summary.csv', byBudget.map((row) => ({ budget: row.budget, algorithm: row.algorithm, n: row.count,
  visitsMean: row.visited.mean, visitsMedian: row.visited.median, visitsQ1: row.visited.q1, visitsQ3: row.visited.q3,
  reentriesMean: row.zoneReentryCount.mean, distanceMeanMeters: row.totalWalkDistanceMeters.mean,
  totalMinutesMean: row.totalMinutes.mean, zonesMean: row.uniqueZonesVisited.mean, compliance: row.compliance })));
csv('start_zone_summary.csv', byStartZone.map((row) => ({ startZone: row.zone, algorithm: row.algorithm, n: row.count,
  visitsMean: row.visited.mean, reentriesMean: row.zoneReentryCount.mean, distanceMeanMeters: row.totalWalkDistanceMeters.mean })));
const f = (value, digits = 3) => Number(value).toFixed(digits);
const table = (headers, body) => ['| ' + headers.join(' | ') + ' |', '|' + headers.map(() => '---').join('|') + '|',
  ...body.map((row) => '| ' + row.join(' | ') + ' |')].join('\n');
const b = stats.nearest_feasible, z = stats.zone_progression_greedy;
const main = sensitivity[0];
const comparisonTable = table(['Показатель', 'Базовый', 'Зональный'], [
  ['Результатов', b.count, z.count], ['Доля в лимите', f(b.compliance, 4), f(z.compliance, 4)],
  ['Посещений всего', b.visitedTotal, z.visitedTotal], ['Посещений, среднее', f(b.visited.mean), f(z.visited.mean)],
  ['Посещений, медиана [Q1; Q3]', `${f(b.visited.median)} [${f(b.visited.q1)}; ${f(b.visited.q3)}]`, `${f(z.visited.median)} [${f(z.visited.q1)}; ${f(z.visited.q3)}]`],
  ['Повторных входов всего', b.reentriesTotal, z.reentriesTotal],
  ['Повторных входов, среднее', f(b.zoneReentryCount.mean), f(z.zoneReentryCount.mean)],
  ['Длина, среднее, м', f(b.totalWalkDistanceMeters.mean), f(z.totalWalkDistanceMeters.mean)],
  ['Расчётная длительность, среднее, мин', f(b.totalMinutes.mean), f(z.totalMinutes.mean)],
  ['Различных зон, среднее', f(b.uniqueZonesVisited.mean), f(z.uniqueZonesVisited.mean)],
]);
fs.writeFileSync(path.join(tables, 'main_comparison.md'), comparisonTable + '\n');
const budgetTable = table(['Бюджет, мин', 'Метод', 'Среднее посещений', 'Среднее возвратов', 'Средняя длина, м', 'Среднее время, мин', 'Среднее зон'],
  byBudget.map((row) => [row.budget, labels[row.algorithm], f(row.visited.mean), f(row.zoneReentryCount.mean), f(row.totalWalkDistanceMeters.mean), f(row.totalMinutes.mean), f(row.uniqueZonesVisited.mean)]));
const sensitivityTable = table(['Профиль', 'Посещения Б/З', 'Возвраты Б/З', 'Сохранение посещений', 'Правило гипотезы'],
  sensitivity.map((row) => [row.profile, `${row.baselineVisits}/${row.zonalVisits}`, `${row.baselineReentries}/${row.zonalReentries}`, f(row.visitRetention, 4), row.supportRule ? 'выполнено' : 'не выполнено']));
const report = `# Эксперименты и анализ результатов

Серия: \`${run}\`. Классификация: вычислительное сценарное исследование ограниченного каталога. Географическая пригодность для реальных прогулок и удобство для людей не измерялись. Решения до запуска: [run_decisions.md](../docs/run_decisions.md).

## Воспроизводимость и входы

В архиве сохранены каталог 32 точек, конфигурация, исходники, точные запросы/ответы Valhalla и матрица 32×32. SHA-256 каталога: \`${snapshot.datasetHash}\`. SHA-256 матрицы: \`${manifest.matrixHash}\`. Версия кода: \`${snapshot.codeHash}\` (SHA-256 манифеста файлов; Git отсутствует). SHA-256 результатов: \`${manifest.resultsHash}\`.

Все старты пересечены с пятью бюджетами; пары используют одинаковую матрицу, скорость, остановки и граф зон. Перед серией пробный сценарий дважды выполнен каждым алгоритмом с точным совпадением полного результата. Runtime — Node.js, не браузер; подробности в \`data/raw/${run}/environment.json\`.

## Полнота и качество

Получено ${rows.length}/${manifest.expectedAllResults} результатов: ${primary.length} основных и ${rows.length - primary.length} однофакторных. Ошибок алгоритмов: ${output.quality.errors}; дубликатов ключей: ${rows.length - keys.size}; нарушений бюджета/числовых инвариантов: ${invalidRows.length}. Недоступных ячеек матрицы: ${output.quality.unavailableEdges}; нулевых межточечных расстояний: ${zeroOffDiagonal.length}. Минимальный остаток бюджета в основной серии: ${f(output.quality.minimalSlackMinutes, 6)} мин. Записи не удалялись.

## Основное сравнение (160 пар)

Таблица 1. Метрики основной серии. Источник: сохранённые \`results.json\`, обработка \`src/analysis/analyze.mjs\`.

${comparisonTable}

Зональный алгоритм даёт больше посещений в ${main.moreVisits} парах, столько же в ${main.equalVisits}, меньше в ${main.fewerVisits}. Повторных входов меньше в ${main.fewerReentries} парах, столько же в ${main.equalReentries}, больше в ${main.moreReentries}. Полностью совпадает порядок точек в ${main.sameRouteCount} парах. Сохранение суммарных посещений = ${f(main.visitRetention, 6)}; уменьшение возвратов = ${b.reentriesTotal - z.reentriesTotal}. По заранее заданному совместному правилу гипотеза **${main.supportRule ? 'поддержана' : 'не поддержана'}** на этом наборе сценариев. Раздельное улучшение одного показателя не заменяет совместное правило.

![Рисунок 1. Число посещений и повторных входов](figures/main_metrics.png)

Источник рисунка 1: \`budget_summary.csv\`, средние по 32 стартам для каждого бюджета.

## Влияние лимита времени

Таблица 2. Сводки по бюджету. Для каждой строки n=32; исходные и квартильные сводки — \`tables/budget_summary.csv\`.

${budgetTable}

Число посещённых зон описывает пространственное покрытие тематических групп, а не разнообразие туристических интересов. Сравнение не устанавливает оптимум. Средняя длина сама по себе не является критерием победы: более длинный путь может сопровождаться иным числом посещений.

![Рисунок 2. Длина, время и зональное покрытие](figures/route_costs.png)

Источник рисунка 2: \`budget_summary.csv\`.

## Чувствительность

Таблица 3. Все предусмотренные однофакторные варианты на той же матрице; Б/З — базовый/зональный методы.

${sensitivityTable}

В тестах скорости и остановок граф соседства сохранён при базовых 5 км/ч и 12 мин; для 8/16 мин он перестроен. Если пороговые варианты совпадают, это означает лишь отсутствие эффекта выбранных порогов на этом наборе. Основной граф имеет ${adjacencyEdges} неориентированных связей из 10 возможных; соседство и типы зон доступны в \`summary.json\`.

![Рисунок 3. Сохранение посещений и возвраты при изменении параметров](figures/sensitivity.png)

Источник рисунка 3: \`sensitivity.csv\`. Координатные смещения 75/150 м (seed 17/43) **не выполнены**: нет тестового движка/подтверждённого bulk-доступа, требуемого протоколом. Это незакрытая часть исследования; устойчивость к погрешностям координат не доказана. Исключение непроверенных записей неприменимо, поскольку все 32 записи отмечены проверенными пользователем.

## Время вычисления и аномалии

${table(['Метод', 'Медиана по сценариям, мс/вызов', 'Q1', 'Q3', 'Min', 'Max'], runtime.map((row) => [labels[row.algorithm], f(row.median, 6), f(row.q1, 6), f(row.q3, 6), f(row.min, 6), f(row.max, 6)]))}

Сначала 100 прогревочных вызовов, затем 7 партий по 100 вызовов на каждый метод и основной сценарий; порядок методов перемешан зафиксированным seed. В каждой партии сохранено среднее на вызов, далее вычислена медиана семи партий. Построение графа соседства, сеть и интерфейс исключены. Верхний критерий Тьюки внутри семи партий пометил ${timingFlags.length} значений как потенциальные выбросы; они сохранены и не удалены. Таблица \`timing_anomalies.csv\` — диагностическая, не основание для исключений.

![Рисунок 4. Распределение времени расчёта](figures/runtime.png)

Источник рисунка 4: \`runtime.json\`; по каждой паре старт/бюджет показана медиана партий. Результаты относятся к Node.js и этой машине, не к скорости отображения карты или браузерному опыту.

## Парные случаи и ограничения

Примеры выбраны воспроизводимо: первые три сценария после сортировки по разнице посещений, затем возвратов; \`summary.json/examples\` содержит полные маршруты. Это иллюстрации компромиссов, не специально отобранные удачные прогулки.

${table(['Старт', 'Бюджет', 'Посещения Б/З', 'Разница возвратов З−Б', 'Разница длины З−Б, м'], examples.map(({ pair }) => [pair.startId, pair.budgetMinutes, `${pair.baselineStops}/${pair.zonalStops}`, pair.reentriesDifference, f(pair.distanceDifferenceMeters)]))}

![Рисунок 5. Парные различия основной серии](figures/paired_tradeoff.png)

Источник рисунка 5: \`paired_comparison.csv\`; совпадающие точки могут перекрываться.

Группы каталога тематические: «Парки и сады» пространственно разнесены. Возврат в такую группу не равнозначен геометрическому движению назад; минимальная пара межзональных точек может создавать широкое соседство. Карта точек и зон: рисунок 6.

![Рисунок 6. Положение точек каталога](figures/catalog_zones.png)

Источник рисунка 6: архивная версия каталога; это схематическая диаграмма координат без картографической подложки, а не карта пешеходных путей.

Другие ограничения: пользовательская проверка координат без независимого аудита; вложенные остановки; одна опорная точка у протяжённых объектов; одинаковое время осмотра; неизмеренная скорость; отсутствие данных о часах работы, погоде и доступности; изменяемый граф публичного сервиса; отсутствие эталонного оптимума и пользовательского исследования. Места не являются случайной выборкой, поэтому статистика не описывает население Казани. Не выполнен координатный стресс-тест.

## Команды

\`npm.cmd run experiments:reproduce\` — точное повторение решений по сохранённой матрице без сети (runtime повторно не сравнивается).

\`npm.cmd run analysis\` и \`python src/analysis/figures.py\` — пересчёт таблиц/отчёта и рисунков из исходных результатов. Не редактировать \`results.json\` вручную.
`;
fs.writeFileSync(path.join(root, 'reports/experiment_results.md'), report);
console.log(JSON.stringify({ quality: output.quality, main, runtime, adjacencyEdges }, null, 2));
