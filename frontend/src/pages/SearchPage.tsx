import { useSearchParams } from 'react-router-dom';
import { BuildingCard } from '@/components/buildings/BuildingCard';
import { ActiveFilters } from '@/components/search/ActiveFilters';
import { SearchPanel } from '@/components/search/SearchPanel';
import { EmptyState } from '@/components/shared/EmptyState';
import { ErrorState } from '@/components/shared/ErrorState';
import { LoadingState } from '@/components/shared/LoadingState';
import { Reveal } from '@/components/shared/Reveal';
import { Button } from '@/components/ui/button';
import { useBuildingSearch } from '@/hooks/queries/use-building-search';
import { useAreas, useCategories } from '@/hooks/queries/use-reference';
import { filtersFromParams, filtersToParams, PAGE_SIZE } from '@/lib/search-params';
import type { SearchFilters } from '@/types/search';

export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  // The URL is the source of truth, so a search survives a refresh and can be shared.
  const filters = filtersFromParams(params);
  const setFilters = (next: SearchFilters) => setParams(filtersToParams(next), { replace: true });

  const { data: areas = [] } = useAreas();
  const { data: categories = [] } = useCategories();
  const search = useBuildingSearch(filters, PAGE_SIZE);
  const buildings = search.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="px-4 pb-16 pt-[132px] md:px-10 lg:px-20">
      <div className="mx-auto flex max-w-[1280px] flex-col gap-8">
        <SearchPanel expandable values={filters} onChange={setFilters} areas={areas} categories={categories} />

        <section className="flex flex-col gap-5" aria-live="polite">
          {search.isPending ? (
            <LoadingState />
          ) : search.isError ? (
            <ErrorState message={search.error.message} onRetry={() => search.refetch()} />
          ) : (
            <>
              {buildings.length > 0 && (
                <p className="text-lg font-medium leading-[26px]">
                  {`Showing ${buildings.length} building${buildings.length === 1 ? '' : 's'}${search.hasNextPage ? ' so far' : ''}`}
                </p>
              )}
              <ActiveFilters values={filters} onChange={setFilters} areas={areas} categories={categories} />

              {buildings.length === 0 ? (
                <EmptyState
                  title="No buildings match these filters"
                  description="Try a different area or house type, or raise the maximum rent."
                  action={
                    <Button variant="outline" onClick={() => setFilters({})}>
                      Clear filters
                    </Button>
                  }
                />
              ) : (
                <div className="grid grid-cols-1 gap-x-5 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
                  {buildings.map((b, i) => (
                    <Reveal key={b.id} delay={(i % 3) * 90}>
                      <BuildingCard building={b} />
                    </Reveal>
                  ))}
                </div>
              )}

              {search.hasNextPage && (
                <div className="flex justify-center pt-4">
                  <Button variant="outline" disabled={search.isFetchingNextPage} onClick={() => search.fetchNextPage()}>
                    {search.isFetchingNextPage ? 'Loading…' : 'Load more'}
                  </Button>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
