import { badRequest } from '../../lib/http-error.js';
import { decodeCursor, encodeCursor } from '../../lib/keyset.js';
import { isUuid } from '../../lib/uuid.js';
import { MANAGEMENT_TYPES, type ManagementType } from '../buildings/schemas.js';

export const SEARCH_SORTS = ['updated', 'rent_asc', 'rent_desc'] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

export const MAX_RADIUS_KM = 50;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;
/** `numeric(14,2)` in `space_types.rent_amount`. */
const MAX_RENT = 999_999_999_999;

/** Default sort: `latest::text` (microseconds survive) and the building id. */
export interface UpdatedCursor {
  kind: 'updated';
  t: string;
  id: string;
}
/** Rent sort: the building's lowest Vacant rent as `numeric` text, or null when it has none. */
export interface RentCursor {
  kind: 'rent';
  r: string | null;
  id: string;
}
export type SearchCursor = UpdatedCursor | RentCursor;

export interface RadiusFilter {
  lat: number;
  lng: number;
  radiusKm: number;
}

export interface SearchFilters {
  areaId: string | null;
  radius: RadiusFilter | null;
  categoryId: string | null;
  currencyId: string | null;
  rentMin: number | null;
  rentMax: number | null;
  includeRentOnInterest: boolean;
  management: ManagementType | null;
  verifiedOnly: boolean;
  sort: SearchSort;
  limit: number;
  cursor: SearchCursor | null;
}

const ALLOWED_QUERY = [
  'areaId', 'lat', 'lng', 'radiusKm', 'categoryId', 'currencyId', 'rentMin', 'rentMax',
  'includeRentOnInterest', 'management', 'verifiedOnly', 'sort', 'limit', 'cursor',
] as const;

const NUMBER_TEXT = /^-?\d+(\.\d+)?$/;
const RENT_TEXT = /^\d+(\.\d{1,2})?$/;

function text(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '') throw badRequest(`Query "${name}" must be a single value.`);
  return value;
}

function uuid(value: unknown, name: string): string | null {
  const v = text(value, name);
  if (v === undefined) return null;
  if (!isUuid(v)) throw badRequest(`Query "${name}" must be a valid UUID.`);
  return v;
}

function number(value: unknown, name: string, min: number, max: number): number | null {
  const v = text(value, name);
  if (v === undefined) return null;
  const n = NUMBER_TEXT.test(v) ? Number(v) : Number.NaN;
  if (!Number.isFinite(n) || n < min || n > max) {
    throw badRequest(`Query "${name}" must be a number from ${min} to ${max}.`);
  }
  return n;
}

function flag(value: unknown, name: string): boolean {
  const v = text(value, name);
  if (v === undefined) return false;
  if (v !== 'true' && v !== 'false') throw badRequest(`Query "${name}" must be "true" or "false".`);
  return v === 'true';
}

export const encodeRentCursor = (cursor: Omit<RentCursor, 'kind'>): string =>
  Buffer.from(JSON.stringify(cursor)).toString('base64url');

function decodeRentCursor(value: string): RentCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { r?: unknown; id?: unknown };
    const rentOk = parsed.r === null || (typeof parsed.r === 'string' && RENT_TEXT.test(parsed.r));
    if (rentOk && typeof parsed.id === 'string' && isUuid(parsed.id)) {
      return { kind: 'rent', r: parsed.r as string | null, id: parsed.id };
    }
  } catch {
    // fall through to the 400 below
  }
  throw badRequest('Query "cursor" is not valid. Use the "nextCursor" of the previous page.');
}

export const encodeSearchCursor = (cursor: SearchCursor): string =>
  cursor.kind === 'updated' ? encodeCursor({ t: cursor.t, id: cursor.id }) : encodeRentCursor(cursor);

/** FR-SRC-001 to FR-SRC-006. Rejects what it does not know so a mistyped filter is not ignored. */
export function parseSearchQuery(query: Record<string, unknown>): SearchFilters {
  for (const key of Object.keys(query)) {
    if (!(ALLOWED_QUERY as readonly string[]).includes(key)) {
      throw badRequest(`Query "${key}" is not a search filter.`);
    }
  }

  const areaId = uuid(query.areaId, 'areaId');
  const lat = number(query.lat, 'lat', -90, 90);
  const lng = number(query.lng, 'lng', -180, 180);
  const radiusKm = number(query.radiusKm, 'radiusKm', 0.1, MAX_RADIUS_KM);
  const anyRadius = lat !== null || lng !== null || radiusKm !== null;
  if (anyRadius && (lat === null || lng === null || radiusKm === null)) {
    throw badRequest('A radius search needs "lat", "lng" and "radiusKm" together.', { code: 'RADIUS_INCOMPLETE' });
  }
  if (areaId && anyRadius) {
    throw badRequest('Search by "areaId" or by radius, not both.', { code: 'AREA_OR_RADIUS' });
  }

  const currencyId = uuid(query.currencyId, 'currencyId');
  const rentMin = number(query.rentMin, 'rentMin', 0, MAX_RENT);
  const rentMax = number(query.rentMax, 'rentMax', 0, MAX_RENT);
  const includeRentOnInterest = flag(query.includeRentOnInterest, 'includeRentOnInterest');
  if (!currencyId && (rentMin !== null || rentMax !== null || includeRentOnInterest)) {
    throw badRequest('Rent filters need "currencyId": rent is compared in one currency.', {
      code: 'CURRENCY_REQUIRED',
    });
  }
  if (rentMin !== null && rentMax !== null && rentMin > rentMax) {
    throw badRequest('Query "rentMin" must not be above "rentMax".');
  }

  const managementText = text(query.management, 'management');
  if (managementText !== undefined && !(MANAGEMENT_TYPES as readonly string[]).includes(managementText)) {
    throw badRequest('Query "management" must be "agent" or "landlord".');
  }

  const sortText = text(query.sort, 'sort') ?? 'updated';
  if (!(SEARCH_SORTS as readonly string[]).includes(sortText)) {
    throw badRequest('Query "sort" must be "updated", "rent_asc" or "rent_desc".');
  }
  const sort = sortText as SearchSort;
  // FR-SRC-006: a rent sort only makes sense inside one currency.
  if (sort !== 'updated' && !currencyId) {
    throw badRequest('Sorting by rent needs "currencyId".', { code: 'SORT_REQUIRES_CURRENCY' });
  }

  let limit = DEFAULT_PAGE_SIZE;
  const limitText = text(query.limit, 'limit');
  if (limitText !== undefined) {
    const n = /^\d+$/.test(limitText) ? Number(limitText) : Number.NaN;
    if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE_SIZE) {
      throw badRequest(`Query "limit" must be a whole number from 1 to ${MAX_PAGE_SIZE}.`);
    }
    limit = n;
  }

  const cursorText = text(query.cursor, 'cursor');
  let cursor: SearchCursor | null = null;
  if (cursorText !== undefined) {
    cursor = sort === 'updated' ? { kind: 'updated', ...decodeCursor(cursorText) } : decodeRentCursor(cursorText);
  }

  return {
    areaId,
    radius: anyRadius ? { lat: lat!, lng: lng!, radiusKm: radiusKm! } : null,
    categoryId: uuid(query.categoryId, 'categoryId'),
    currencyId,
    rentMin,
    rentMax,
    includeRentOnInterest,
    management: (managementText as ManagementType | undefined) ?? null,
    verifiedOnly: flag(query.verifiedOnly, 'verifiedOnly'),
    sort,
    limit,
    cursor,
  };
}
