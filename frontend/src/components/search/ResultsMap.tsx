import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LngLatBounds, Map as MapLibreMap, Marker, setWorkerUrl, type StyleSpecification } from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Link } from 'react-router-dom';
import closeUrl from '@/assets/icons/close.svg';
import pinUrl from '@/assets/icons/pin.svg';
import { useLanguage } from '@/hooks/use-language';
import { useTheme } from '@/hooks/use-theme';
import { formatRent } from '@/lib/format';
import { clusterBuildings, formatPinPrice } from '@/lib/map-clusters';
import { cn } from '@/lib/utils';
import type { Area } from '@/types/reference';
import type { BuildingCard } from '@/types/search';

// Vite pre-bundles maplibre-gl into .vite/deps/, breaking its relative worker URL lookup.
setWorkerUrl(maplibreWorkerUrl);

interface ResultsMapProps {
  buildings: BuildingCard[];
  selectedArea?: Area;
  hoveredBuildingId?: string | null;
  onHoverBuilding?: (id: string | null) => void;
  className?: string;
}

// MapLibre uses [lng, lat] order.
const NGONG_CENTRE: [number, number] = [36.6569, -1.3617];
const DEFAULT_ZOOM = 12;

const STYLE_URLS = {
  dark: 'https://tiles.openfreemap.org/styles/dark',
  light: 'https://tiles.openfreemap.org/styles/positron',
} as const;

const DARK_FILL_OVERRIDES: Record<string, string> = {
  water: '#1a2426',
  landuse_residential: '#2a3030',
  landcover_wood: '#27332e',
  landuse_park: '#27332e',
  building: '#323a39',
};

const DARK_LINE_OVERRIDES: Record<string, string> = {
  waterway: '#253639',
  highway_path: '#485251',
  highway_minor: '#4b5655',
  highway_major_casing: '#6d7a78',
  highway_major_inner: '#3c4645',
  highway_major_subtle: '#5a6664',
  highway_motorway_casing: '#7d8a88',
  highway_motorway_inner: '#404b4a',
  highway_motorway_subtle: '#626e6c',
  boundary_state: '#5a6664',
  'boundary_country_z0-4': '#687573',
  'boundary_country_z5-': '#687573',
};

const PROMINENT_LABELS = new Set([
  'place_town',
  'place_city',
  'place_city_large',
  'place_state',
  'place_country_other',
  'place_country_minor',
  'place_country_major',
]);

/**
 * OpenFreeMap's default `dark` style uses #0c0c0c land and #181818 minor roads, which are too dark
 * to read easily. Lift the charcoal tones and label contrast to match KHunt's dark surfaces.
 */
function enhanceDarkStyle(nextStyle: StyleSpecification): StyleSpecification {
  return {
    ...nextStyle,
    layers: nextStyle.layers.map((layer) => {
      if (layer.type === 'background') {
        return { ...layer, paint: { ...layer.paint, 'background-color': '#242929' } };
      }
      if (layer.type === 'fill' && DARK_FILL_OVERRIDES[layer.id]) {
        return { ...layer, paint: { ...layer.paint, 'fill-color': DARK_FILL_OVERRIDES[layer.id] } };
      }
      if (layer.type === 'line' && DARK_LINE_OVERRIDES[layer.id]) {
        return { ...layer, paint: { ...layer.paint, 'line-color': DARK_LINE_OVERRIDES[layer.id] } };
      }
      if (layer.type === 'symbol' && layer.paint && 'text-color' in layer.paint) {
        return {
          ...layer,
          paint: {
            ...layer.paint,
            'text-color': PROMINENT_LABELS.has(layer.id) ? '#d6dfdf' : '#a8b5b4',
            'text-halo-color': 'rgba(20, 25, 25, 0.88)',
          },
        };
      }
      return layer;
    }),
  };
}

function buildPinElement(label: string, active: boolean): HTMLButtonElement {
  const wrapper = document.createElement('button');
  wrapper.type = 'button';
  wrapper.className = 'cursor-pointer border-0 bg-transparent p-0 focus:outline-none';
  wrapper.style.zIndex = active ? '20' : '1';

  const pill = document.createElement('span');
  pill.className = cn(
    'inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold tracking-tight shadow-md transition-transform duration-200',
    active
      ? 'scale-110 bg-primary text-primary-foreground ring-2 ring-white'
      : 'bg-card text-foreground ring-1 ring-border hover:scale-105 dark:bg-primary-dark dark:text-white dark:ring-primary-bright/60',
  );
  pill.textContent = label;
  wrapper.appendChild(pill);
  return wrapper;
}

function buildClusterElement(count: number, label: string): HTMLButtonElement {
  const outer = document.createElement('button');
  outer.type = 'button';
  outer.setAttribute('aria-label', label);
  outer.className =
    'flex size-11 cursor-pointer items-center justify-center rounded-full border-0 bg-primary/25 p-1 backdrop-blur-sm focus:outline-none';

  const inner = document.createElement('span');
  inner.className =
    'flex size-full items-center justify-center rounded-full bg-primary-dark text-xs font-semibold text-white ring-2 ring-primary-bright/80 shadow-md transition-transform duration-200 hover:scale-105';
  inner.textContent = String(count);
  outer.appendChild(inner);
  return outer;
}

export function ResultsMap({
  buildings,
  selectedArea,
  hoveredBuildingId,
  onHoverBuilding,
  className,
}: ResultsMapProps) {
  const { t } = useLanguage();
  const { resolvedTheme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const styleThemeRef = useRef<'light' | 'dark'>(resolvedTheme);
  const markersRef = useRef<Marker[]>([]);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selectedBuilding = useMemo(
    () => buildings.find((b) => b.id === selectedId) ?? null,
    [buildings, selectedId],
  );

  const fitMapToResults = useCallback(
    (animate = true) => {
      const map = mapRef.current;
      if (!map) return;

      if (buildings.length === 1) {
        const b = buildings[0]!;
        map.easeTo({
          center: [b.location.longitude, b.location.latitude],
          zoom: 14,
          duration: animate ? 450 : 0,
        });
        return;
      }
      if (buildings.length > 1) {
        const bounds = new LngLatBounds();
        for (const b of buildings) {
          bounds.extend([b.location.longitude, b.location.latitude]);
        }
        map.fitBounds(bounds, { padding: 56, maxZoom: 14, duration: animate ? 450 : 0 });
        return;
      }
      if (selectedArea) {
        map.easeTo({
          center: [selectedArea.centreLng, selectedArea.centreLat],
          zoom: 13,
          duration: animate ? 450 : 0,
        });
        return;
      }
      map.easeTo({ center: NGONG_CENTRE, zoom: DEFAULT_ZOOM, duration: animate ? 450 : 0 });
    },
    [buildings, selectedArea],
  );

  // Initialise MapLibre GL once on mount using free OpenFreeMap vector styles (no API key required).
  useEffect(() => {
    const el = containerRef.current;
    if (!el || mapRef.current) return;

    const map = new MapLibreMap({
      container: el,
      style: STYLE_URLS[styleThemeRef.current],
      transformStyle: (_prev, next) => (styleThemeRef.current === 'dark' ? enhanceDarkStyle(next) : next),
      center: NGONG_CENTRE,
      zoom: DEFAULT_ZOOM,
      attributionControl: { compact: true },
    });

    const onZoom = () => setZoom(Math.round(map.getZoom()));
    const onMapClick = () => setSelectedId(null);
    map.on('zoomend', onZoom);
    map.on('click', onMapClick);
    mapRef.current = map;

    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width < 80 || rect.height < 80) return;
      map.resize();
    });
    observer.observe(el);

    return () => {
      observer.disconnect();
      map.off('zoomend', onZoom);
      map.off('click', onMapClick);
      for (const m of markersRef.current) m.remove();
      markersRef.current = [];
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Swap OpenFreeMap style when the light/dark theme switches.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleThemeRef.current === resolvedTheme) return;
    styleThemeRef.current = resolvedTheme;
    map.setStyle(STYLE_URLS[resolvedTheme], {
      transformStyle: (_prev, next) => (resolvedTheme === 'dark' ? enhanceDarkStyle(next) : next),
    });
  }, [resolvedTheme]);

  // Re-frame viewport whenever the search result set or selected area changes.
  useEffect(() => {
    fitMapToResults(true);
  }, [fitMapToResults]);

  // Sync markers and clusters with current zoom, results, and hover/selection state.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    for (const m of markersRef.current) m.remove();
    markersRef.current = [];

    const items = clusterBuildings(buildings, zoom);
    const rentOnInterestLabel = t('card.rentOnInterest');

    for (const item of items) {
      if (item.kind === 'cluster') {
        const count = item.buildings.length;
        const el = buildClusterElement(count, t('map.clusterLabel', { count }));
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          map.easeTo({ center: [item.lng, item.lat], zoom: Math.min(zoom + 2, 14), duration: 400 });
        });
        const marker = new Marker({ element: el, anchor: 'center' })
          .setLngLat([item.lng, item.lat])
          .addTo(map);
        markersRef.current.push(marker);
      } else {
        const b = item.building;
        const active = b.id === hoveredBuildingId || b.id === selectedId;
        const el = buildPinElement(formatPinPrice(b, rentOnInterestLabel), active);
        el.addEventListener('mouseenter', () => onHoverBuilding?.(b.id));
        el.addEventListener('mouseleave', () => onHoverBuilding?.(null));
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          setSelectedId(b.id);
          map.easeTo({ center: [item.lng, item.lat], duration: 350 });
        });
        const marker = new Marker({ element: el, anchor: 'center' })
          .setLngLat([item.lng, item.lat])
          .addTo(map);
        markersRef.current.push(marker);
      }
    }
  }, [buildings, zoom, hoveredBuildingId, selectedId, onHoverBuilding, t]);

  return (
    <aside
      aria-label={t('map.label')}
      className={cn(
        'relative isolate overflow-hidden rounded-2xl border border-border/80 bg-muted shadow-float dark:border-white/10',
        className,
      )}
    >
      <div ref={containerRef} className="z-0 size-full" />

        {/* Top-right zoom & recenter controls */}
        <div className="pointer-events-auto absolute right-4 top-4 z-10 flex flex-col items-center gap-2.5">
          <div className="flex flex-col items-center gap-1 rounded-full border border-border/80 bg-card/90 p-1 text-foreground shadow-panel backdrop-blur-md">
            <button
              type="button"
              aria-label={t('map.zoomIn')}
              onClick={() => mapRef.current?.zoomIn({ duration: 250 })}
              className="flex size-8 items-center justify-center rounded-full text-base font-medium transition-colors duration-300 ease-fluid hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              +
            </button>
            <button
              type="button"
              aria-label={t('map.zoomOut')}
              onClick={() => mapRef.current?.zoomOut({ duration: 250 })}
              className="flex size-8 items-center justify-center rounded-full text-base font-medium transition-colors duration-300 ease-fluid hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              −
            </button>
          </div>

          <button
            type="button"
            aria-label={t('map.fitResults')}
            onClick={() => fitMapToResults(true)}
            className="flex size-10 items-center justify-center rounded-full border border-border/80 bg-card/90 text-foreground shadow-panel backdrop-blur-md transition-colors duration-300 ease-fluid hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden>
              <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.4" />
              <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Selected building preview card */}
        {selectedBuilding && (
          <div className="pointer-events-auto absolute bottom-3.5 left-3.5 z-10 flex w-max max-w-[calc(100%-3.5rem)] items-center gap-3 rounded-2xl border border-border/80 bg-card/95 p-3 shadow-float backdrop-blur-md">
            {selectedBuilding.coverPhoto && (
              <img
                src={selectedBuilding.coverPhoto.thumb}
                alt=""
                className="size-16 shrink-0 rounded-xl object-cover"
              />
            )}
            <div className="min-w-0">
              <Link
                to={`/buildings/${selectedBuilding.id}`}
                className="block truncate text-sm font-semibold text-foreground underline-offset-4 transition-colors duration-300 ease-fluid hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:text-primary-bright"
              >
                {selectedBuilding.name}
              </Link>
              <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                <img src={pinUrl} alt="" className="size-3 invert dark:invert-0" />
                <span className="truncate">{selectedBuilding.area.name}</span>
              </p>
              <p className="mt-1 text-xs font-semibold text-primary dark:text-primary-bright">
                {formatRent(selectedBuilding.rent) || t('card.rentOnInterest')}
              </p>
            </div>
            <button
              type="button"
              aria-label={t('active.remove', { label: selectedBuilding.name })}
              onClick={() => setSelectedId(null)}
              className="ml-1 shrink-0 self-start rounded-full p-1.5 transition-colors duration-300 ease-fluid hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <img src={closeUrl} alt="" className="size-3 dark:invert" />
            </button>
          </div>
        )}
    </aside>
  );
}
