import type { BuildingCard } from '@/types/search';

export interface MapCluster {
  kind: 'cluster';
  id: string;
  lat: number;
  lng: number;
  buildings: BuildingCard[];
}

export interface MapPin {
  kind: 'pin';
  id: string;
  lat: number;
  lng: number;
  building: BuildingCard;
}

export type MapMarkerItem = MapCluster | MapPin;

const CLUSTER_MAX_ZOOM = 11;

/**
 * Grid-based spatial clustering for low zoom levels. At street/neighbourhood zoom (`>= 12`),
 * every building keeps its exact coordinates so price pins can be inspected individually.
 */
export function clusterBuildings(buildings: readonly BuildingCard[], zoom: number): MapMarkerItem[] {
  if (buildings.length === 0) return [];
  if (zoom > CLUSTER_MAX_ZOOM) {
    return buildings.map((b) => ({
      kind: 'pin',
      id: b.id,
      lat: b.location.latitude,
      lng: b.location.longitude,
      building: b,
    }));
  }

  // Cell size scales inversely with zoom (~0.25° at z=10, ~0.125° at z=11).
  const cellSize = 180 / Math.pow(2, Math.max(zoom, 1) - 1);
  const buckets = new Map<string, BuildingCard[]>();

  for (const b of buildings) {
    const gx = Math.floor(b.location.longitude / cellSize);
    const gy = Math.floor(b.location.latitude / cellSize);
    const key = `${gx}:${gy}`;
    const list = buckets.get(key);
    if (list) list.push(b);
    else buckets.set(key, [b]);
  }

  const result: MapMarkerItem[] = [];
  for (const [key, group] of buckets) {
    if (group.length === 1) {
      const b = group[0]!;
      result.push({
        kind: 'pin',
        id: b.id,
        lat: b.location.latitude,
        lng: b.location.longitude,
        building: b,
      });
    } else {
      const lat = group.reduce((sum, b) => sum + b.location.latitude, 0) / group.length;
      const lng = group.reduce((sum, b) => sum + b.location.longitude, 0) / group.length;
      result.push({
        kind: 'cluster',
        id: `cluster-${key}`,
        lat,
        lng,
        buildings: group,
      });
    }
  }
  return result;
}

const compactNumber = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** Compact pill label for a map pin, e.g. "KES 7,000" or "Rent on interest". */
export function formatPinPrice(building: BuildingCard, rentOnInterestLabel: string): string {
  const ranges = building.rent.ranges;
  if (ranges.length === 0) return rentOnInterestLabel;
  const primary = ranges.find((r) => r.currencyCode === 'KES') ?? ranges[0]!;
  return `${primary.currencyCode} ${compactNumber.format(primary.min)}`;
}
