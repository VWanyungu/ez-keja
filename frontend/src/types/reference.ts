// Mirrors backend/v1/modules/reference/service.ts (public items only).

export interface Area {
  id: string;
  name: string;
  slug: string;
  centreLat: number;
  centreLng: number;
}

export interface Currency {
  id: string;
  code: string;
  name: string;
}

export interface SpaceCategory {
  id: string;
  code: string;
  nameEn: string;
  nameSw: string;
  kind: 'residential' | 'commercial';
}
