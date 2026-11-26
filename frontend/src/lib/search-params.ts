import type { ManagementType, SearchFilters, SearchSort } from '@/types/search';

export const PAGE_SIZE = 8;
/** Divides evenly across both 2-column (map open) and 3-column (map closed) grids. */
export const RESULTS_PAGE_SIZE = 12;

/** The API refuses a longer `q`. */
export const MAX_QUERY_LENGTH = 100;

const MANAGEMENT: readonly string[] = ['agent', 'landlord'];
export const SEARCH_SORTS: readonly SearchSort[] = ['updated', 'rent_asc', 'rent_desc'];

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

  const sort = params.get('sort');
  if (sort && sort !== 'updated' && (SEARCH_SORTS as readonly string[]).includes(sort)) {
    filters.sort = sort as SearchSort;
  }

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
  if (filters.sort && filters.sort !== 'updated') params.set('sort', filters.sort);
  return params;
}

interface ApiQueryOptions {
  /** Rent filters and rent sorting are compared in one currency, so neither is sent without it. */
  currencyId?: string;
  limit: number;
  cursor?: string | null;
}

/** Filters to the query string of GET /search/buildings. */
export function toApiQuery(filters: SearchFilters, { currencyId, limit, cursor }: ApiQueryOptions): string {
  const params = filtersToParams(filters);
  params.delete('maxRent');
  const needsCurrency = Boolean(filters.maxRent) || (Boolean(filters.sort) && filters.sort !== 'updated');
  if (needsCurrency && currencyId) {
    params.set('currencyId', currencyId);
    if (filters.maxRent) params.set('rentMax', String(filters.maxRent));
  } else {
    params.delete('sort');
  }
  params.set('limit', String(limit));
  if (cursor) params.set('cursor', cursor);
  return params.toString();
}
