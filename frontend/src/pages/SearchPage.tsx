import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BuildingCard } from '@/components/buildings/BuildingCard';
import { ActiveFilters } from '@/components/search/ActiveFilters';
import { SearchBar } from '@/components/search/SearchBar';
import { SearchPanel } from '@/components/search/SearchPanel';
import { EmptyState } from '@/components/shared/EmptyState';
import { ErrorState } from '@/components/shared/ErrorState';
import { LoadingState } from '@/components/shared/LoadingState';
import { Pagination } from '@/components/shared/Pagination';
import { Reveal } from '@/components/shared/Reveal';
import { Button } from '@/components/ui/button';
import { useBuildingSearch } from '@/hooks/queries/use-building-search';
import { useLanguage } from '@/hooks/use-language';
import { useAreas, useCategories } from '@/hooks/queries/use-reference';
import { pageRange } from '@/lib/pagination';
import { filtersFromParams, filtersToParams, RESULTS_PAGE_SIZE } from '@/lib/search-params';
import { cn } from '@/lib/utils';
import type { SearchFilters } from '@/types/search';

export default function SearchPage() {
  const { t } = useLanguage();
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState(0);
  const resultsRef = useRef<HTMLElement>(null);
  // The URL is the source of truth, so a search survives a refresh and can be shared.
  const filters = filtersFromParams(params);
  const setFilters = (next: SearchFilters) => {
    setPage(0);
    setParams(filtersToParams(next), { replace: true });
  };

  const { data: areas = [] } = useAreas();
  const { data: categories = [] } = useCategories();
  const search = useBuildingSearch(filters, RESULTS_PAGE_SIZE);

  // The API pages by cursor: each fetched page is kept, so going back is instant and only the next unfetched page is reachable.
  const pages = search.data?.pages ?? [];
  const current = Math.min(page, Math.max(pages.length - 1, 0));
  const buildings = pages[current]?.items ?? [];
  const { from, to } = pageRange(current, RESULTS_PAGE_SIZE, buildings.length);

  const goToPage = async (target: number) => {
    if (target >= pages.length) await search.fetchNextPage();
    setPage(target);
    resultsRef.current?.scrollIntoView({ block: 'start' });
  };

  return (
    <div className="px-4 pb-16 pt-[132px] md:px-10 lg:px-20">
      <div className="mx-auto flex max-w-[1280px] flex-col gap-8">
        <div className="flex flex-col gap-4">
          <SearchBar values={filters} onChange={setFilters} />
          <SearchPanel expandable values={filters} onChange={setFilters} areas={areas} categories={categories} />
        </div>

        <section ref={resultsRef} className="flex scroll-mt-28 flex-col gap-5" aria-live="polite">
          {search.isPending ? (
            <LoadingState />
          ) : search.isError ? (
            <ErrorState message={search.error.message} onRetry={() => search.refetch()} />
          ) : (
            <>
              {buildings.length > 0 && (
                <p className="text-lg font-medium leading-[26px]">
                  {from === to && current === 0 && !search.hasNextPage
                    ? t('results.showingOne')
                    : t('results.showingRange', { from, to })}
                </p>
              )}
              <ActiveFilters values={filters} onChange={setFilters} areas={areas} categories={categories} />

              {buildings.length === 0 ? (
                <EmptyState
                  title={t('results.emptyTitle')}
                  description={t('results.emptyBody')}
                  action={
                    <Button variant="outline" onClick={() => setFilters({})}>
                      {t('results.clear')}
                    </Button>
                  }
                />
              ) : (
                <div
                  className={cn(
                    'grid grid-cols-1 gap-x-5 gap-y-8 transition-opacity duration-300 sm:grid-cols-2 lg:grid-cols-3',
                    search.isFetchingNextPage && 'opacity-50',
                  )}
                >
                  {buildings.map((b, i) => (
                    <Reveal key={b.id} delay={(i % 3) * 90}>
                      <BuildingCard building={b} />
                    </Reveal>
                  ))}
                </div>
              )}

              {(pages.length > 1 || search.hasNextPage) && (
                <Pagination
                  className="pt-4"
                  page={current}
                  known={pages.length}
                  hasMore={search.hasNextPage}
                  busy={search.isFetchingNextPage}
                  onPageChange={goToPage}
                />
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
