import { useEffect, useRef, useState } from 'react';
import type * as Leaflet from 'leaflet';
import type { Coordinate, Place, RouteComparison } from '../core/types.ts';

interface Props {
  places: Place[]; startId: string; route?: RouteComparison; shape?: Coordinate[];
  onStart: (id: string) => void;
}

export function RouteMap({ places, startId, route, shape, onStart }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<Leaflet.Map | null>(null);
  const layers = useRef<Leaflet.LayerGroup | null>(null);
  const [L, setLeaflet] = useState<typeof Leaflet | null>(null);
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    let mounted = true;
    import('leaflet').then((library) => { if (mounted) setLeaflet(library); })
      .catch(() => { if (mounted) setLoadError('Не удалось загрузить карту. Обнови страницу.'); });
    return () => { mounted = false; };
  }, []);
  useEffect(() => {
    if (!L) return;
    const instance = L.map(host.current!, { zoomControl: false, scrollWheelZoom: false, attributionControl: false }).setView([55.7915, 49.1155], 13);
    L.control.attribution({ prefix: false, position: 'bottomleft' }).addTo(instance);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    }).addTo(instance);
    L.control.zoom({ position: 'bottomright' }).addTo(instance);
    layers.current = L.layerGroup().addTo(instance);
    map.current = instance;
    return () => { instance.remove(); map.current = null; layers.current = null; };
  }, [L]);

  useEffect(() => {
    const instance = map.current;
    const group = layers.current;
    if (!instance || !group || !L) return;
    group.clearLayers();
    const order = new Map(route?.result.stops.map((place, index) => [place.id, index + 1]));
    for (const place of places) {
      const selected = order.has(place.id);
      const isStart = place.id === startId;
      const marker = L.circleMarker([place.lat, place.lon], {
        radius: isStart ? 10 : selected ? 9 : 5, color: '#fff', weight: selected || isStart ? 3 : 1,
        fillColor: isStart ? '#d56b47' : selected ? '#315b48' : '#cf8b57', fillOpacity: 0.95,
      }).addTo(group);
      const popup = document.createElement('div');
      const name = document.createElement('strong'); name.textContent = place.name;
      const zone = document.createElement('p'); zone.textContent = place.zone;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'popup-start'; button.textContent = 'Выбрать стартом';
      button.onclick = () => { onStart(place.id); instance.closePopup(); };
      popup.append(name, zone, button);
      marker.bindPopup(popup).bindTooltip(() => {
        const text = document.createElement('span'); text.textContent = place.name; return text;
      });
    }
    if (shape && shape.length > 1) {
      L.polyline(shape, { color: route?.id === 'nearest_feasible' ? '#315b48' : '#d56b47', weight: 5, opacity: 0.88 }).addTo(group);
    }
    route?.result.stops.forEach((place, index) => {
      L.marker([place.lat, place.lon], {
        icon: L.divIcon({ className: 'route-number-icon', html: `<span>${index + 1}</span>`, iconSize: [30, 30], iconAnchor: [15, 15] }),
      }).addTo(group);
    });
    if (route) {
      const bounds = L.latLngBounds(shape?.length ? shape : route.result.stops.map((place): Coordinate => [place.lat, place.lon]));
      if (bounds.isValid()) instance.fitBounds(bounds, { padding: [32, 32], maxZoom: 16 });
    }
  }, [places, startId, route, shape, onStart, L]);

  return <section className="map-panel">
    <div className="map-toolbar"><div><span className="map-kicker">КАТАЛОГ МЕСТ</span><strong>Центр Казани</strong></div><button className="map-reset" type="button" onClick={() => map.current?.setView([55.7915, 49.1155], 13)}>↗ <span>Обзор</span></button></div>
    <div id="map" ref={host} aria-label="Карта мест и выбранного маршрута">{loadError && <p role="alert">{loadError}</p>}</div>
    <div className="map-legend"><span><i className="legend-start" /> Старт</span><span><i className="legend-stop" /> Выбранное место</span><span><i className="legend-candidate" /> Точка из каталога</span><span><i className="legend-route" /> Пешеходный путь</span></div>
    <p className="map-message" aria-live="polite">{!route ? 'Нажми на место, чтобы выбрать его стартом.' : shape?.length ? 'На карте показаны пешеходный путь и порядок остановок.' : 'Показан порядок остановок. Пешеходная линия загружается либо недоступна.'}</p>
  </section>;
}
