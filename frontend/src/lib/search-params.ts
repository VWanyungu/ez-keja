import type { ManagementType, SearchFilters } from '@/types/search';

export const PAGE_SIZE = 8;
/** The results page shows a full three-column grid per page. */
export const RESULTS_PAGE_SIZE = 9;

/** The API refuses a longer `q`. */
export const MAX_QUERY_LENGTH = 100;

const MANAGEMENT: readonly string[] = ['agent', 'landlord'];

/** URL to filters. Anything that does not parse is dropped rather than sent to the API. */
export function filtersFromParams(params: URLSearchParams): SearchFilters {
  const filters: SearchFilters = {};

  const q = params.get('q')?.trim().slice(0, MAX_QUERY_LENGTH);
  if (q) filters.q = q;

  const areaId = params.get('areaId');
  if (areaId) filters.areaId = areaId;

  const categoryId = params.get('categoryId');
  if (categoryId) filters.categoryId = categoryId;

  const maxRent = Number(params.get('maxRent'));
  if (params.get('maxRent') && Number.isFinite(maxRent) && maxRent > 0) filters.maxRent = maxRent;

  const management = params.get('management');
  if (management && MANAGEMENT.includes(management)) filters.management = management as ManagementType;

  if (params.get('verifiedOnly') === 'true') filters.verifiedOnly = true;

  return filters;
}

/** Filters to URL, leaving out every filter that is not set so the default search has a clean URL. */
export function filtersToParams(filters: SearchFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.q) params.set('q', filters.q);
  if (filters.areaId) params.set('areaId', filters.areaId);
  if (filters.categoryId) params.set('categoryId', filters.categoryId);
  if (filters.maxRent) params.set('maxRent', String(filters.maxRent));
  if (filters.management) params.set('management', filters.management);
  if (filters.verifiedOnly) params.set('verifiedOnly', 'true');
  return params;
}

interface ApiQueryOptions {
  /** Rent is compared in one currency, so a max rent without it is not sent. */
  currencyId?: string;
  limit: number;
  cursor?: string | null;
}

/** Filters to the query string of GET /search/buildings. */
export function toApiQuery(filters: SearchFilters, { currencyId, limit, cursor }: ApiQueryOptions): string {
  const params = filtersToParams(filters);
  params.delete('maxRent');
  if (filters.maxRent && currencyId) {
    params.set('currencyId', currencyId);
    params.set('rentMax', String(filters.maxRent));
  }
  params.set('limit', String(limit));
  if (cursor) params.set('cursor', cursor);
  return params.toString();
}
