import { useInfiniteQuery } from '@tanstack/react-query';
import { queryKeys } from '@/api/query-keys';
import { searchBuildings } from '@/api/search';
import { useCurrencies } from '@/hooks/queries/use-reference';
import { toApiQuery } from '@/lib/search-params';
import type { SearchFilters } from '@/types/search';

const DEFAULT_CURRENCY = 'KES';

/** Pages of buildings, newest vacancy update first. Follows the API's cursor for "Load more". */
export function useBuildingSearch(filters: SearchFilters, pageSize: number) {
  const { data: currencies } = useCurrencies();
  const currencyId = currencies?.find((c) => c.code === DEFAULT_CURRENCY)?.id;
  const needsCurrency = filters.maxRent !== undefined || (filters.sort !== undefined && filters.sort !== 'updated');
  // Rent filters and rent sorting are compared in one currency, so wait until we know which one KES is.
  const ready = !needsCurrency || currencyId !== undefined;

  return useInfiniteQuery({
    queryKey: queryKeys.search.buildings(toApiQuery(filters, { currencyId, limit: pageSize })),
    queryFn: ({ pageParam }) => searchBuildings(toApiQuery(filters, { currencyId, limit: pageSize, cursor: pageParam })),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: ready,
  });
}
