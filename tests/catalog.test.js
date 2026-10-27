import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { catalogFingerprint, validateCatalog } from '../src/core/catalog.ts';

const rawCatalog = JSON.parse(await readFile(new URL('../data/places_catalog_full.json', import.meta.url), 'utf8'));

test('full catalog validates and preserves coordinate provenance', () => {
  const catalog = validateCatalog(rawCatalog);
  assert.equal(catalog.places.length, 32);
  assert.ok(catalog.places.every((place) => place.coordinateStatus && place.coordinateSource));
  assert.equal(new Set(catalog.places.map((place) => place.id)).size, 32);
  assert.equal(new Set(catalog.places.map((place) => place.zone)).size, 5);
});

test('catalog fingerprint is deterministic and changes with coordinate version', () => {
  const places = validateCatalog(rawCatalog).places;
  assert.equal(catalogFingerprint(places), catalogFingerprint(places));
  const modified = places.map((place, index) => index === 0 ? { ...place, lat: place.lat + 0.0001 } : place);
  assert.notEqual(catalogFingerprint(places), catalogFingerprint(modified));
});

test('invalid and duplicate catalog records are rejected', () => {
  assert.throws(() => validateCatalog({ places: [] }), /не содержит список/);
  const duplicate = { places: [rawCatalog.places[0], rawCatalog.places[0]] };
  assert.throws(() => validateCatalog(duplicate), /Повторяется id/);
  const invalidCoordinates = { places: [{ ...rawCatalog.places[0], lat: 123 }] };
  assert.throws(() => validateCatalog(invalidCoordinates), /некорректные координаты/);
  const missingCoordinate = { places: [{ ...rawCatalog.places[0], lon: '' }] };
  assert.throws(() => validateCatalog(missingCoordinate), /отсутствуют координаты/);
});
