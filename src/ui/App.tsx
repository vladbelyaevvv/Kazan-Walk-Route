import { useCallback, useEffect, useRef, useState } from 'react';
import rawCatalog from '../../data/places_catalog_full.json';
import protocol from '../../configs/experiments.json';
import { catalogFingerprint, validateCatalog } from '../core/catalog.ts';
import { buildZoneAdjacency, nearestFeasibleRoute, zoneProgressionRoute } from '../core/planner.ts';
import { cacheMatrix, fetchRouteShape, fetchWalkingMatrix, readCachedMatrix } from '../core/routing.ts';
import { buildExperimentExport, downloadFile, resultRows, toCsv } from '../core/export.ts';
import type { Coordinate, RouteComparison, Scenario, WalkingMatrix } from '../core/types.ts';
import { RouteMap } from './RouteMap.tsx';

function parseCatalog() {
  try { return { catalog: validateCatalog(rawCatalog), error: '' }; }
  catch (error) { return { catalog: null, error: error instanceof Error ? error.message : String(error) }; }
}
const loaded = parseCatalog();
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
function formatTime(minutes: number) {
  const total = Math.round(minutes); const hours = Math.floor(total / 60); const rest = total % 60;
  return hours ? `${hours} ч${rest ? ` ${rest} мин` : ''}` : `${rest} мин`;
}

export function App() {
  if (!loaded.catalog) return <main className="fatal-state"><h1>Не удалось открыть каталог</h1><p>{loaded.error}</p></main>;
  return <Planner />;
}

function Planner() {
  const catalog = loaded.catalog!;
  const places = catalog.places;
  const unchecked = places.some((place) => place.coordinateStatus !== 'verified');
  const [confirmed, setConfirmed] = useState(false);
  const [scenario, setScenario] = useState<Scenario>({ startId: places[0].id, budgetMinutes: 90, visitMinutes: 10, walkingSpeedKmh: 5, zoneNeighborThresholdMinutes: 12 });
  const [routes, setRoutes] = useState<RouteComparison[]>([]);
  const [shapes, setShapes] = useState<Record<string, Coordinate[]>>({});
  const [active, setActive] = useState('nearest_feasible');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Матрица переходов будет загружена при первом сравнении и сохранена в браузере.');
  const [error, setError] = useState('');
  const [caption, setCaption] = useState('Задай параметры и запусти сравнение');
  const matrix = useRef<WalkingMatrix | null>(null);
  const revision = useRef(0);
  const running = useRef(false);
  const snapshot = useRef<Scenario | null>(null);
  useEffect(() => () => { revision.current += 1; }, []);
  const update = useCallback((patch: Partial<Scenario>) => {
    revision.current += 1;
    setScenario((current) => ({ ...current, ...patch }));
    setRoutes([]); setShapes({}); setError(''); setCaption('Параметры изменены — пересчитай оба варианта');
    snapshot.current = null;
  }, []);
  const chooseStart = useCallback((id: string) => update({ startId: id }), [update]);

  async function generate() {
    if (running.current || (unchecked && !confirmed)) return;
    running.current = true; setBusy(true); setError(''); setRoutes([]); setShapes({});
    const version = ++revision.current;
    const current = { ...scenario };
    try {
      let distances = matrix.current ?? readCachedMatrix(places);
      if (!distances) {
        setCaption('Загружаем пешеходные переходы…');
        distances = await fetchWalkingMatrix(places, { onProgress: ({ completed, total }) => {
          if (revision.current === version) setStatus(`Загрузка матрицы: ${completed} из ${total}`);
        } });
        cacheMatrix(distances, places);
      }
      matrix.current = distances;
      if (revision.current !== version) return;
      setStatus('Матрица переходов загружена и сохранена.');
      const input = { places, matrix: distances, ...current };
      const adjacency = buildZoneAdjacency(places, distances, current.walkingSpeedKmh, current.zoneNeighborThresholdMinutes);
      const results: RouteComparison[] = [
        { id: 'nearest_feasible', label: 'База · ближайшая точка', result: nearestFeasibleRoute(input) },
        { id: 'zone_progression_greedy', label: 'Зональный · последовательный проход', result: zoneProgressionRoute({ ...input, zoneAdjacency: adjacency }) },
      ];
      if (results.some((route) => !route.result.budgetCompliant)) throw new Error('Маршрут превысил лимит времени.');
      snapshot.current = current; setRoutes(results); setActive(results[0].id);
      setCaption(`Оба маршрута рассчитаны в пределах ${current.budgetMinutes} минут. Возврат к старту не включён.`);
      for (const route of results) {
        if (revision.current !== version) break;
        try {
          const shape = await fetchRouteShape(route.result.stops);
          if (revision.current === version) setShapes((previous) => ({ ...previous, [route.id]: shape }));
        } catch (failure) {
          console.warn(`Геометрия ${route.id}: ${messageOf(failure)}`);
          if (revision.current === version) setStatus(`Расчёт готов. Линия одного из маршрутов недоступна: ${messageOf(failure)}`);
        }
      }
    } catch (failure) {
      if (revision.current === version) { setError(messageOf(failure)); setCaption('Не удалось построить сравнение'); }
    } finally { running.current = false; setBusy(false); }
  }

  function exportResults(format: 'json' | 'csv') {
    if (!snapshot.current || !matrix.current || !routes.length) return;
    if (format === 'json') {
      const payload = buildExperimentExport({ catalog, catalogHash: catalogFingerprint(places), matrix: matrix.current, scenario: snapshot.current, routes, protocol });
      downloadFile('kazan-walk-scenario.json', JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
    } else downloadFile('kazan-walk-results.csv', '\uFEFF' + toCsv(resultRows(routes, snapshot.current)), 'text/csv;charset=utf-8');
  }

  return <main id="top">
    <section className="intro"><div className="eyebrow"><span>ГОРОД В ТВОЁМ ТЕМПЕ</span><i /><span>ЭКСПЕРИМЕНТАЛЬНАЯ ВЕРСИЯ</span></div><h1>Центр Казани.<br /><em>Твой темп прогулки.</em></h1><p>Выбери время и точку старта. Сравним обычный подбор ближайших мест с вариантом, который старается проходить зоны последовательно.</p></section>
    <section className="planner-layout" aria-label="Планировщик прогулки">
      <aside className="controls">
        <div className="section-heading"><span className="step">01</span><h2>Настрой прогулку</h2></div>
        <fieldset className="field-group"><legend>СКОЛЬКО ЕСТЬ ВРЕМЕНИ?</legend><div className="time-options time-options-five">{[60, 90, 120, 180, 240].map((minutes) => <button key={minutes} type="button" className={`time-option ${scenario.budgetMinutes === minutes ? 'selected' : ''}`} aria-pressed={scenario.budgetMinutes === minutes} onClick={() => update({ budgetMinutes: minutes })}>{minutes === 90 ? '1,5' : minutes / 60}<small>ч</small></button>)}</div></fieldset>
        <label className="field-group"><span className="field-label">ТОЧКА СТАРТА</span><select value={scenario.startId} onChange={(event) => chooseStart(event.target.value)}>{places.map((place) => <option key={place.id} value={place.id}>{place.name} · {place.zone}</option>)}</select></label>
        <div className="research-settings"><div className="section-heading compact-heading"><span className="step">02</span><h2>Расчётные допущения</h2></div>
          <label className="field-group"><span className="field-label">ВРЕМЯ НА КАЖДОЙ ОСТАНОВКЕ</span><select value={scenario.visitMinutes} onChange={(event) => update({ visitMinutes: Number(event.target.value) })}>{[5, 10, 20].map((value) => <option key={value} value={value}>{value} минут{value === 10 ? ' · базовый сценарий' : ''}</option>)}</select></label>
          <label className="field-group"><span className="field-label">СЦЕНАРНАЯ СКОРОСТЬ ХОДЬБЫ</span><select value={scenario.walkingSpeedKmh} onChange={(event) => update({ walkingSpeedKmh: Number(event.target.value) })}>{[4, 5, 6].map((value) => <option key={value} value={value}>{value} км/ч{value === 5 ? ' · базовый сценарий' : ''}</option>)}</select></label>
          <label className="field-group"><span className="field-label">ПОРОГ СОСЕДСТВА ЗОН</span><select value={scenario.zoneNeighborThresholdMinutes} onChange={(event) => update({ zoneNeighborThresholdMinutes: Number(event.target.value) })}>{[8, 12, 16].map((value) => <option key={value} value={value}>{value} минут{value === 12 ? ' · базовый сценарий' : ''}</option>)}</select></label>
          <p className="settings-note">Это сценарные параметры, а не измеренные характеристики прогулок. Меняй их, чтобы увидеть чувствительность результата.</p>
        </div>
        {unchecked && <label className="coordinate-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>Понимаю, что часть координат пока не проверена.</span></label>}
        <button className={`primary-button ${busy ? 'loading' : ''}`} type="button" disabled={busy || (unchecked && !confirmed)} onClick={generate}><span>{busy ? 'Считаем…' : 'Сравнить два маршрута'}</span><span className="button-arrow">↗</span></button>
        <p className="form-footnote" aria-live="polite"><span>✳</span> {status}</p>
      </aside>
      <RouteMap places={places} startId={scenario.startId} onStart={chooseStart} route={routes.find((route) => route.id === active)} shape={shapes[active]} />
    </section>
    <section className="results-section" aria-live="polite"><div className="results-heading"><div><div className="eyebrow small-eyebrow">03 <i /> СРАВНЕНИЕ</div><h2>Два алгоритма</h2></div><span className="results-caption">{caption}</span></div>
      <div className="route-cards">{error ? <article className="error-card" role="alert"><span>!</span><div><strong>Маршрут не рассчитан</strong><p>{error}</p></div></article> : routes.length ? routes.map((route) => <button key={route.id} className={`route-card ${active === route.id ? 'active' : ''}`} type="button" aria-pressed={active === route.id} onClick={() => setActive(route.id)}>
        <span className="route-card-top"><span className="route-label">{route.label}</span><span className="route-card-index">{route.id === 'nearest_feasible' ? 'A' : 'B'}</span></span>
        <strong className="route-card-title">{route.result.stops.length} мест · {formatTime(route.result.totalMinutes)}</strong>
        <span className="route-stats"><span><b>{(route.result.totalWalkDistanceMeters / 1000).toFixed(2)} км</b> пешком</span><span><b>{formatTime(route.result.totalWalkMinutes)}</b> ходьба</span><span><b>{route.result.totalVisitMinutes} мин</b> остановки</span><span><b>{route.result.zoneReentryCount}</b> возвратов по зонам</span></span>
        <span className="route-card-stops">{route.result.stops.map((place, index) => <span key={place.id}><i>{String(index + 1).padStart(2, '0')}</i>{place.name}<small>{place.zone}</small></span>)}</span>
        <span className="route-card-action">Показать последовательность на карте <span>↗</span></span>
      </button>) : <article className="empty-card"><span className="empty-icon">↗</span><p>{busy ? 'Получаем данные для расчёта…' : 'Здесь появятся результаты для выбранного сценария.'}</p></article>}</div>
      {routes.length > 0 && <div className="export-actions"><button className="secondary-button" type="button" onClick={() => exportResults('json')}>Скачать JSON со сценарием и матрицей</button><button className="secondary-button" type="button" onClick={() => exportResults('csv')}>Скачать CSV результатов</button><span>Экспорт одного сценария.</span></div>}
    </section>
    <section className="about-section" id="about"><div className="about-mark">К</div><div><div className="eyebrow small-eyebrow">О ПРОЕКТЕ <i /> ПЕРВАЯ ВЕРСИЯ</div><h2>Как читать результат</h2><p>Базовый алгоритм каждый раз выбирает ближайшую допустимую точку. Зональный вариант сначала ищет место в текущей зоне, затем — в соседней, и только при отсутствии таких вариантов использует резервный переход. Это эвристики, не гарантия кратчайшего или «лучшего» маршрута.</p><p>Условное соседство зон вычисляется по минимальному пешеходному переходу между точками. Особенно осторожно интерпретируй группу «Парки и сады»: её объекты могут быть далеко друг от друга.</p></div></section>
  </main>;
}
