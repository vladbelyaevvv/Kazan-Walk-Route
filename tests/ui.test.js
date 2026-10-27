import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { App } from '../src/ui/App.tsx';

test('React page renders the catalog and controls without removed page sections', () => {
  const html = renderToStaticMarkup(createElement(App));
  assert.equal((html.match(/<option value="/g) || []).length, 41);
  for (const hours of ['1,5', '2', '3', '4']) assert.ok(html.includes(`>${hours}<small>ч</small>`));
  assert.ok(html.includes('Собор Петра и Павла'));
  assert.ok(html.includes('Фуксовский сад'));
  assert.ok(html.includes('Сравнить два маршрута'));
  assert.doesNotMatch(html, /<header|<footer|Открыть источник|Пешеходные переходы:|версия данных от/);
  assert.doesNotMatch(html, /confirm-candidate/);
});
