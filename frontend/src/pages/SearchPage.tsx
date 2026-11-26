import { useId, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BuildingCard } from '@/components/buildings/BuildingCard';
import { ActiveFilters } from '@/components/search/ActiveFilters';
import { MobileFiltersSheet } from '@/components/search/MobileFiltersSheet';
import { countActiveFilters } from '@/components/search/options';
import { ResultsMap } from '@/components/search/ResultsMap';
import { ResultsToolbar } from '@/components/search/ResultsToolbar';
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
import { filtersFromParams, filtersToParams, RESULTS_PAGE_SIZE } from '@/lib/search-params';
import { cn } from '@/lib/utils';
import type { SearchFilters, SearchSort } from '@/types/search';

export default function SearchPage() {
  const { t } = useLanguage();
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState(0);
  const [showMap, setShowMap] = useState(true);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [hoveredBuildingId, setHoveredBuildingId] = useState<string | null>(null);
  const filterPanelId = useId();
  const resultsRef = useRef<HTMLElement>(null);
  // The URL is the source of truth, so a search survives a refresh and can be shared.
  const filters = filtersFromParams(params);
  const activeFilterCount = countActiveFilters(filters);
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
  const total = pages[current]?.total ?? pages[0]?.total;
  const selectedArea = areas.find((a) => a.id === filters.areaId);

  const handleSortChange = (sort: SearchSort) => {
    setFilters({ ...filters, sort: sort === 'updated' ? undefined : sort });
  };

  const goToPage = async (target: number) => {
    if (target >= pages.length) await search.fetchNextPage();
    setPage(target);
    resultsRef.current?.scrollIntoView({ block: 'start' });
  };

  return (
    <div className="px-4 pb-16 pt-[132px] md:px-10 lg:px-20">
      <div className="mx-auto flex max-w-[1280px] flex-col gap-6">
        <div className="flex flex-col">
          <div className="flex items-center gap-3">
            <SearchBar className="min-w-0 flex-1" values={filters} onChange={setFilters} />
            <button
              type="button"
              aria-expanded={filtersOpen}
              aria-controls={filterPanelId}
              aria-label={
                activeFilterCount > 0
                  ? t('filters.buttonWithCount', { count: activeFilterCount })
                  : t('filters.button')
              }
              onClick={() => setFiltersOpen((open) => !open)}
              className={cn(
                'relative flex size-[58px] shrink-0 items-center justify-center gap-2 rounded-full border text-sm font-medium transition-colors duration-300 ease-fluid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-auto sm:px-5',
                filtersOpen || activeFilterCount > 0
                  ? 'border-transparent bg-accent text-accent-foreground hover:bg-tint'
                  : 'border-line bg-muted text-foreground hover:bg-card',
              )}
            >
              <svg viewBox="0 0 18 18" fill="none" className="size-[18px] shrink-0" aria-hidden>
                <path
                  d="M2.5 4.5h13M5.5 9h7M7.5 13.5h3"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
              <span className="hidden sm:inline">{t('filters.button')}</span>
              {activeFilterCount > 0 && (
                <span className="pointer-events-none absolute -right-1 -top-1 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold leading-none text-primary-foreground ring-2 ring-background">
                  {activeFilterCount}
                </span>
              )}
            </button>
          </div>

          <div
            id={filterPanelId}
            className={cn(
              'hidden transition-[grid-template-rows,opacity,visibility,margin] duration-500 ease-fluid motion-reduce:transition-none md:grid',
              filtersOpen
                ? 'mt-4 grid-rows-[1fr] opacity-100'
                : 'invisible pointer-events-none mt-0 grid-rows-[0fr] opacity-0',
            )}
          >
            <div className="min-h-0 overflow-hidden">
              <SearchPanel expandable values={filters} onChange={setFilters} areas={areas} categories={categories} />
            </div>
          </div>
        </div>

        <MobileFiltersSheet
          open={filtersOpen}
          onClose={() => setFiltersOpen(false)}
          values={filters}
          onChange={setFilters}
          areas={areas}
          categories={categories}
          total={total}
        />

        <ResultsToolbar
          sort={filters.sort ?? 'updated'}
          onSortChange={handleSortChange}
          total={total}
          showMap={showMap}
          onToggleMap={setShowMap}
        />

        <div
          className={cn(
            'grid grid-cols-1 gap-0 transition-[grid-template-columns,gap] duration-500 ease-fluid motion-reduce:transition-none',
            showMap
              ? 'lg:gap-5 lg:grid-cols-[2fr_1fr]'
              : 'lg:gap-0 lg:grid-cols-[1fr_0fr]',
          )}
        >
          <section ref={resultsRef} className="flex min-w-0 scroll-mt-28 flex-col gap-5" aria-live="polite">
            {search.isPending ? (
              <LoadingState />
            ) : search.isError ? (
              <ErrorState message={search.error.message} onRetry={() => search.refetch()} />
            ) : (
              <>
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
                      'grid grid-cols-1 gap-x-5 gap-y-8 transition-opacity duration-300 sm:grid-cols-2',
                      !showMap && 'lg:grid-cols-3',
                      search.isFetchingNextPage && 'opacity-50',
                    )}
                  >
                    {buildings.map((b, i) => (
                      <Reveal key={b.id} delay={(i % (showMap ? 2 : 3)) * 90}>
                        <div
                          onMouseEnter={() => setHoveredBuildingId(b.id)}
                          onMouseLeave={() => setHoveredBuildingId((prev) => (prev === b.id ? null : prev))}
                        >
                          <BuildingCard
                            building={b}
                            className={cn(hoveredBuildingId === b.id && 'ring-primary dark:ring-white')}
                          />
                        </div>
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

          <div
            aria-hidden={!showMap}
            className={cn(
              'hidden min-w-0 overflow-hidden transition-[opacity,transform,visibility] duration-500 ease-fluid motion-reduce:transition-none lg:sticky lg:top-[88px] lg:block lg:h-[calc(100vh-112px)] lg:max-h-[848px]',
              showMap
                ? 'visible translate-x-0 opacity-100 lg:overflow-visible'
                : 'invisible pointer-events-none translate-x-4 opacity-0',
            )}
          >
            <ResultsMap
              buildings={buildings}
              selectedArea={selectedArea}
              hoveredBuildingId={hoveredBuildingId}
              onHoverBuilding={setHoveredBuildingId}
              className="size-full"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
