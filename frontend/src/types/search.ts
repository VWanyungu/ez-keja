// Mirrors backend/v1/modules/search/service.ts (BuildingCard, SearchPage).

export interface PhotoUrls {
  thumb: string;
  medium: string;
  full: string;
}

export interface RentRange {
  currencyId: string;
  currencyCode: string;
  min: number;
  max: number;
}

export type ManagementType = 'agent' | 'landlord';

export interface BuildingCard {
  id: string;
  name: string;
  area: { id: string; name: string };
  coverPhoto: PhotoUrls | null;
  /** One range per currency; `rentOnInterest` is true when no Vacant type shows a rent. */
  rent: { ranges: RentRange[]; rentOnInterest: boolean };
  management: { type: ManagementType; name: string | null; profileUserId: string | null };
  /** The lister's account and the building are separate indicators (FR-VER-005). */
  verification: { account: string; building: string };
  /** ISO-8601 with microseconds, or null. */
  latestUpdate: string | null;
  outdated: boolean;
}

export interface SearchPage {
  items: BuildingCard[];
  nextCursor: string | null;
}

/** What the search screens let a visitor pick. Kept in the URL, so a search can be shared. */
export interface SearchFilters {
  areaId?: string;
  categoryId?: string;
  /** In KES, the platform's default currency. */
  maxRent?: number;
  management?: ManagementType;
  verifiedOnly?: boolean;
}
