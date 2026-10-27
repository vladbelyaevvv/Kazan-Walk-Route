import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const run = process.env.KAZAN_RUN_ID || 'stage5-v1';
const load = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const s = load(`data/processed/${run}/summary.json`);
const engine = load(`data/raw/${run}/routing_manifest.json`);
const environment = load(`data/raw/${run}/environment.json`);
const main = s.sensitivity.find((row) => row.profile === 'primary');
const f = (value, digits = 3) => value.toFixed(digits).replace('.', ',');
const table = (headers, rows) => ['| ' + headers.join(' | ') + ' |', '|' + headers.map(() => '---').join('|') + '|',
  ...rows.map((row) => '| ' + row.join(' | ') + ' |')].join('\n');
const names = { nearest_feasible: 'Базовый', zone_progression_greedy: 'Зональный' };
const values = {
  baselineReentries: main.baselineReentries, zonalReentries: main.zonalReentries,
  retentionPercent: f(main.visitRetention * 100, 2), retention: f(main.visitRetention, 6),
  baselineVisits: main.baselineVisits, zonalVisits: main.zonalVisits,
  adjacencyEdges: s.adjacencyEdges, allResults: s.quality.actualRows,
  datasetHash: s.snapshot.datasetHash, matrixHash: s.manifest.matrixHash, resultsHash: s.manifest.resultsHash,
  engineVersion: engine.engineVersion ?? 'не раскрыта', nodeVersion: environment.node, cpu: environment.cpu.trim(),
  moreVisits: main.moreVisits, equalVisits: main.equalVisits, fewerVisits: main.fewerVisits,
  fewerReentries: main.fewerReentries, equalReentries: main.equalReentries, sameRoutes: main.sameRouteCount,
  retentionDwell5: f(s.sensitivity.find((row) => row.profile === 'dwell_5').visitRetention, 6),
  retentionDwell20: f(s.sensitivity.find((row) => row.profile === 'dwell_20').visitRetention, 6),
  runtimeBaseline: f(s.runtime.find((row) => row.algorithm === 'nearest_feasible').median, 6),
  runtimeZonal: f(s.runtime.find((row) => row.algorithm === 'zone_progression_greedy').median, 6),
  timingFlags: s.quality.timingFlags,
  mainTable: fs.readFileSync(path.join(root, 'reports/tables/main_comparison.md'), 'utf8').trim(),
  simpleBudgetTable: table(['Время, мин', 'Способ', 'Среднее число мест', 'Среднее повторных входов'],
    s.byBudget.map((row) => [row.budget, names[row.algorithm], f(row.visited.mean, 2), f(row.zoneReentryCount.mean, 2)])),
  budgetTable: table(['Бюджет, мин', 'Метод', 'Среднее посещений', 'Среднее возвратов', 'Средняя длина, м', 'Среднее время, мин', 'Среднее зон'],
    s.byBudget.map((row) => [row.budget, names[row.algorithm], f(row.visited.mean), f(row.zoneReentryCount.mean), f(row.totalWalkDistanceMeters.mean), f(row.totalMinutes.mean), f(row.uniqueZonesVisited.mean)])),
  sensitivityTable: table(['Профиль', 'Посещения Б/З', 'Возвраты Б/З', 'Сохранение посещений', 'Выполнено совместное правило'],
    s.sensitivity.map((row) => [row.profile, `${row.baselineVisits}/${row.zonalVisits}`, `${row.baselineReentries}/${row.zonalReentries}`, f(row.visitRetention, 4), row.supportRule ? 'да' : 'нет'])),
};
const template = fs.readFileSync(path.join(root, 'docs/research_paper.template.md'), 'utf8');
const paper = template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
  if (!(key in values)) throw new Error(`Unknown field: ${key}`);
  return String(values[key]);
});
if (paper.includes('{{')) throw new Error('Unresolved placeholders');
fs.writeFileSync(path.join(root, 'reports/research_paper.md'), paper);
console.log('Generated reports/research_paper.md from archived metrics and editable template');
