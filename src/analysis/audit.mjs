import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const run = process.env.KAZAN_RUN_ID || 'stage5-v1';
const raw = path.join(root, 'data/raw', run);
const read = (file) => fs.readFileSync(file, 'utf8');
const json = (file) => JSON.parse(read(file));
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const manifest = json(path.join(raw, 'run_manifest.json'));
const snapshot = json(path.join(raw, 'snapshot_manifest.json'));
const results = json(path.join(raw, 'results.json'));
const matrix = json(path.join(raw, 'matrix.json'));
const summary = json(path.join(root, 'data/processed', run, 'summary.json'));
const paper = read(path.join(root, 'reports/research_paper.md'));
const checks = [];
function check(name, action) {
  try { action(); checks.push({ name, passed: true }); }
  catch (error) { checks.push({ name, passed: false, error: String(error) }); }
}
check('Контрольные суммы сырых результатов, времени и матрицы', () => {
  assert.equal(hash(path.join(raw, 'results.json')), manifest.resultsHash);
  assert.equal(hash(path.join(raw, 'runtime.json')), manifest.runtimeHash);
  assert.equal(hash(path.join(raw, 'matrix.json')), manifest.matrixHash);
});
check('Архивные копии исходников/конфигурации совпадают с манифестом', () => {
  for (const item of snapshot.files) assert.equal(hash(path.join(raw, 'snapshot', item.file)), item.sha256, item.file);
});
check('Действующее алгоритмическое ядро совпадает с исследованной версией', () => {
  for (const item of snapshot.files.filter((item) => item.file.startsWith('src/core/'))) {
    assert.equal(hash(path.join(root, item.file)), item.sha256, item.file);
  }
});
check('Точное воспроизведение решений офлайн', () => {
  const verification = json(path.join(raw, 'offline_verification.json'));
  assert.ok(verification.exactMatch); assert.equal(verification.resultCount, results.length);
  assert.equal(verification.originalResultHash, manifest.resultsHash);
});
check('Полнота серий и уникальность ключей', () => {
  assert.equal(results.length, 2240);
  assert.equal(results.filter((row) => row.profile === 'primary').length, 320);
  assert.equal(new Set(results.map((row) => `${row.profile}|${row.startId}|${row.budgetMinutes}|${row.algorithm}`)).size, results.length);
  assert.equal(json(path.join(raw, 'errors.json')).length, 0);
});
check('Матрица точно соответствует архивным ответам API', () => {
  const records = fs.readdirSync(path.join(raw, 'network')).map((file) => json(path.join(raw, 'network', file)))
    .filter((record) => record.url.endsWith('/sources_to_targets'));
  assert.equal(records.length, 16);
  const assembled = Array.from({ length: 32 }, () => Array(32));
  const catalog = json(path.join(raw, 'snapshot/data/places_catalog_full.json'));
  const coords = catalog.places.map((p) => `${p.lat},${p.lon}`);
  for (const record of records) {
    assert.equal(record.status, 200);
    const answer = JSON.parse(record.responseBody).sources_to_targets.distances;
    record.requestBody.sources.forEach((source, i) => record.requestBody.targets.forEach((target, j) => {
      const a = coords.indexOf(`${source.lat},${source.lon}`), b = coords.indexOf(`${target.lat},${target.lon}`);
      assert.ok(a >= 0 && b >= 0);
      assembled[a][b] = answer[i][j] === null ? null : answer[i][j] * 1000;
    }));
  }
  assert.deepEqual(assembled, matrix.distancesMeters);
});
check('Время каждого маршрута пересчитано из сетевых рёбер, остановок и скорости', () => {
  const idToIndex = new Map(matrix.placeIds.map((id, index) => [id, index]));
  for (const row of results) {
    let distance = 0;
    for (let index = 1; index < row.stops.length; index++) {
      const edge = matrix.distancesMeters[idToIndex.get(row.stops[index - 1])][idToIndex.get(row.stops[index])];
      assert.notEqual(edge, null); distance += edge;
    }
    assert.ok(Math.abs(distance - row.totalWalkDistanceMeters) < 1e-8);
    const duration = distance / (row.walkingSpeedKmh * 1000 / 60) + row.stops.length * row.visitMinutes;
    assert.ok(Math.abs(duration - row.totalMinutes) < 1e-8);
    assert.ok(duration <= row.budgetMinutes + 1e-9);
  }
});
check('Гипотеза оценена по исходному порогу без подмены основной серии', () => {
  const main = summary.sensitivity.find((row) => row.profile === 'primary');
  assert.equal(main.supportRule, main.zonalReentries < main.baselineReentries && main.visitRetention >= .9 && main.compliance === 1);
  assert.equal(main.supportRule, false);
  assert.ok(paper.includes('гипотеза по совместному критерию не поддержана'));
  assert.ok(paper.includes(main.baselineVisits.toString()) && paper.includes(main.zonalVisits.toString()));
  assert.ok(paper.includes((main.visitRetention * 100).toFixed(2).replace('.', ',') + '%'));
});
check('Главная таблица статьи совпадает с программной сводкой', () => {
  const table = read(path.join(root, 'reports/tables/main_comparison.md')).trim();
  assert.ok(paper.includes(table));
  assert.equal(summary.manifest.resultsHash, manifest.resultsHash);
});
check('Нумерация ссылок и наличие всех иллюстраций', () => {
  const refs = [...paper.matchAll(/^([0-9]+)\. .+$/gm)].map((match) => Number(match[1]));
  assert.deepEqual(refs, Array.from({ length: 11 }, (_, index) => index + 1));
  const citations = [...paper.matchAll(/\[([0-9]+(?:, *[0-9]+)*)\]/g)].flatMap((match) => match[1].split(',').map(Number));
  assert.ok(citations.every((citation) => refs.includes(citation)));
  assert.ok(refs.every((ref) => citations.includes(ref)));
  for (const match of paper.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) assert.ok(fs.existsSync(path.resolve(root, 'reports', match[1])));
  assert.ok(!paper.includes('{{') && !paper.includes('TODO'));
});
check('Ограничения не скрыты в тексте', () => {
  for (const phrase of ['Координатный стресс-тест не выполнен', 'браузерный benchmark отдельно не выполнен',
    'Независимая полевая или экспертная проверка не проводилась']) assert.ok(paper.includes(phrase));
});
check('Чистая установка, 14 тестов и сборка из отдельной копии завершены', () => {
  const logText = (name) => {
    const bytes = fs.readFileSync(path.join(root, 'reports', name));
    return bytes[0] === 255 && bytes[1] === 254 ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8');
  };
  assert.match(logText('verification_clean_install.log'), /added 26 packages/);
  assert.match(logText('verification_tests.log'), /pass 14/);
  assert.match(logText('verification_tests.log'), /fail 0/);
  assert.match(logText('verification_build.log'), /built in/);
});
const failed = checks.filter((item) => !item.passed);
const report = `# Итоговый научный и технический аудит

Дата: ${new Date().toISOString()}. Проверка выполнена отдельно от агрегирования: \`src/analysis/audit.mjs\`.

## Итог автоматической проверки

Успешно: ${checks.length - failed.length}/${checks.length}. Критические ошибки проверок: ${failed.length}.

| Проверка | Результат |
|---|---|
${checks.map((item) => `| ${item.name} | ${item.passed ? 'пройдена' : item.error.replaceAll('|', '/')} |`).join('\n')}

## Научная согласованность

Название, цель и реализация соответствуют задаче выбора части мест при бюджете. Оба метода используют то же ядро, один каталог и одну сохранённую сетевую матрицу. Времена ходьбы и остановок пересчитаны независимо от полей результата; сеть, карта и анимация не участвуют в расчёте. Статистика относится к 160 парам основного набора. Гипотеза не поддержана: 1350/1533 = 0,880626 < 0,90, хотя возвраты снизились 77→0. Результат не исправлялся ради положительного вывода.

## Существенные незакрытые ограничения

1. Координатный стресс-тест не выполнен: нет предусмотренного протоколом тестового движка/подтверждённого bulk endpoint. Полнота этапа в части устойчивости координат ограничена; численные выводы о ней отсутствуют.
2. Runtime измерен в Node.js, не в браузере. Медиана отражает чистый вызов ядра с заранее построенным соседством. Браузерный и пользовательский benchmarks не заявлены.
3. Пользовательская проверка 32 координат не является независимой верификацией входов/пешеходного доступа. Тематические зоны не означают геометрические районы. Нулевые повторные входы не доказывают отсутствия физического хождения назад.
4. Поле \`confirmatory_run_allowed\` остаётся false: проведена предусмотренная сценарием вычислительная серия, а не валидация качества реальных прогулок. Не измерены скорость людей, время осмотра и пользовательская полезность.
5. Часть утверждений обзора опирается на доступные библиографические записи и официальные страницы; закрытые полные тексты не выдаются за прочитанные. В итоговой статье использованы проверяемые 11 источников; карта подтверждений — \`source_verification.md\`.
6. Граф маршрутизатора не архивирован; сохранены ответы, версия и серверный timestamp тайлов. Будущий онлайн-пересчёт может отличаться, зато алгоритмические результаты точно воспроизведены по архивной матрице.
7. Аудит проверяет воспроизводимую Markdown-редакцию исследования. Конкурсный DOCX оформляется отдельно и в репозитории не хранится; его последние редакторские изменения этим аудитом не проверяются.

## Исправления и косметические замечания

- Противоречивая формулировка резерва и различие UI/экспериментальной обработки скорости описаны до серии в \`docs/run_decisions.md\`. Применены действующие функции без подгонки.
- В общей базе исправлен избыточный \`et al.\` и обновлён адрес Valhalla Matrix; в статье отдельная последовательная нумерация.
- В статье оставлено явно обозначенное место для необязательного актуального скриншота интерфейса. Это не пропущенный экспериментальный рисунок.
- На графиках проверено читаемое отображение русского текста; PNG и SVG рассчитаны кодом из архива. Округление относится к отображению; JSON/CSV сохраняют полные значения.
- Отсутствие чистой Git-истории компенсируется файловыми SHA-256 и копиями исходников на момент запуска. Текущая документация и обработка отчётов могли измениться после запуска; архив неизменён.
- Первая попытка npm ci в основной папке остановилась с Windows EPERM: занята DLL Rollup работающим процессом. Зависимости восстановлены без завершения пользовательского сервера. Чистая установка проверена в отдельной копии: npm ci успешен, 14/14 тестов и строгая TypeScript/Vite-сборка успешны. Первоначальный сбой сохранён, а не скрыт.

## Задачи и результаты

| Задача | Проверяемый результат |
|---|---|
| Обзор постановок и аналогов | docs/literature_review.md, docs/competitor_analysis.md; итоговый текст раздел 1 |
| Данные и формальная модель | каталог, протокол 1.1, run_decisions.md; текст раздел 2 |
| Разработка сервиса | React/TypeScript, карта, два метода, экспорт; текст раздел 3 |
| Парное сравнение | 320 основных результатов, trial.json, offline_verification.json |
| Анализ параметров | 1920 дополнительных результатов; координатный блок честно не выполнен |
| Текст и воспроизводимость | reports/research_paper.md, README, скрипты обработки и этот аудит |

## Команды проверки

\`npm.cmd ci\`; \`npm.cmd test\`; \`npm.cmd run build\`; \`npm.cmd run experiments:reproduce\`; \`npm.cmd run analysis\`; \`python src/analysis/figures.py\`; \`npm.cmd run paper\`; \`npm.cmd run audit\`.

Сохранены только логи, необходимые проверке: \`verification_clean_install.log\` (успешная чистая установка), \`verification_tests.log\`, \`verification_build.log\`. Автоматический аудит не заменяет независимую внешнюю научную рецензию.
`;
fs.writeFileSync(path.join(root, 'reports/final_audit.md'), report);
fs.writeFileSync(path.join(root, 'data/processed', run, 'audit.json'), JSON.stringify({ checks, failed: failed.length }, null, 2) + '\n');
console.log(`${checks.length - failed.length}/${checks.length} audit checks passed`);
if (failed.length) { console.error(failed); process.exitCode = 1; }
