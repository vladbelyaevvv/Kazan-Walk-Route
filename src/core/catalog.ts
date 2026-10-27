import type { Catalog, Place } from './types.ts';

export function validateCatalog(raw: Catalog): Catalog {
  if (!raw || !Array.isArray(raw.places) || raw.places.length === 0) {
    throw new Error('Каталог не содержит список places.');
  }

  const ids = new Set();
  const places = raw.places.map((place, index) => {
    if (!place || typeof place.id !== 'string' || !place.id.trim()) {
      throw new Error(`У места №${index + 1} отсутствует id.`);
    }
    if (ids.has(place.id)) throw new Error(`Повторяется id места: ${place.id}.`);
    ids.add(place.id);

    if (place.lat === null || place.lat === undefined || String(place.lat).trim() === ''
      || place.lon === null || place.lon === undefined || String(place.lon).trim() === '') {
      throw new Error(`У места «${place.name || place.id}» отсутствуют координаты.`);
    }
    const lat = Number(place.lat);
    const lon = Number(place.lon);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
      throw new Error(`У места «${place.name || place.id}» некорректные координаты.`);
    }
    if (!place.name || !place.zone || !place.coordinateStatus) {
      throw new Error(`У места «${place.name || place.id}» отсутствует название, зона или статус координат.`);
    }

    return {
      ...place,
      lat,
      lon,
      zone: String(place.zone),
      coordinateStatus: String(place.coordinateStatus),
      coordinateSource: String(place.coordinateSource || 'Источник не указан'),
    };
  });

  return { ...raw, places };
}

export function catalogFingerprint(places: Place[]) {
  const source = JSON.stringify(places.map(({ id, lat, lon, zone, coordinateStatus }) => ({ id, lat, lon, zone, coordinateStatus })));
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function escapeHtml(value: unknown) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character as '&' | '<' | '>' | '"' | "'"]!);
}
