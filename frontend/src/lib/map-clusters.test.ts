import { describe, expect, it } from 'vitest';
import { clusterBuildings, formatPinPrice } from './map-clusters';
import type { BuildingCard } from '@/types/search';

function makeBuilding(id: string, lat: number, lng: number, minRent?: number): BuildingCard {
  return {
    id,
    name: `Building ${id}`,
    area: { id: 'area-1', name: 'Ngong Town' },
    location: { latitude: lat, longitude: lng },
    coverPhoto: null,
    rent: minRent
      ? { ranges: [{ currencyId: 'kes', currencyCode: 'KES', min: minRent, max: minRent + 2000 }], rentOnInterest: false }
      : { ranges: [], rentOnInterest: true },
    management: { type: 'landlord', name: 'Grace', profileUserId: null },
    verification: { account: 'verified', building: 'verified' },
    latestUpdate: null,
    outdated: false,
  };
}

describe('clusterBuildings', () => {
  const sample = [
    makeBuilding('b1', -1.361, 36.656, 7000),
    makeBuilding('b2', -1.362, 36.657, 9500),
    makeBuilding('b3', -1.8, 37.2, 12000),
  ];

  it('groups nearby buildings into a cluster at low zoom', () => {
    const markers = clusterBuildings(sample, 10);
    const cluster = markers.find((m) => m.kind === 'cluster');
    const pin = markers.find((m) => m.kind === 'pin');
    expect(cluster?.kind).toBe('cluster');
    if (cluster?.kind === 'cluster') {
      expect(cluster.buildings).toHaveLength(2);
      expect(cluster.lat).toBeCloseTo(-1.3615, 4);
    }
    expect(pin?.kind).toBe('pin');
    if (pin?.kind === 'pin') {
      expect(pin.id).toBe('b3');
    }
  });

  it('renders every building as an individual pin at street/neighbourhood zoom', () => {
    const markers = clusterBuildings(sample, 12);
    expect(markers).toHaveLength(3);
    expect(markers.every((m) => m.kind === 'pin')).toBe(true);
  });
});

describe('formatPinPrice', () => {
  it('formats the lowest KES rent and falls back when rent is on interest', () => {
    expect(formatPinPrice(makeBuilding('b1', -1.36, 36.65, 7000), 'Rent on interest')).toBe('KES 7,000');
    expect(formatPinPrice(makeBuilding('b2', -1.36, 36.65), 'Rent on interest')).toBe('Rent on interest');
  });
});
