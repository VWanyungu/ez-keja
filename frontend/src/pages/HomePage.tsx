import { Link, useNavigate } from 'react-router-dom';
import arrowUpRightUrl from '@/assets/icons/arrow-up-right.svg';
import arrowUrl from '@/assets/icons/arrow.svg';
import heroUrl from '@/assets/hero.jpg';
import { BuildingCard } from '@/components/buildings/BuildingCard';
import { SearchPanel } from '@/components/search/SearchPanel';
import { EmptyState } from '@/components/shared/EmptyState';
import { ErrorState } from '@/components/shared/ErrorState';
import { LoadingState } from '@/components/shared/LoadingState';
import { Reveal } from '@/components/shared/Reveal';
import { Button, ButtonIcon } from '@/components/ui/button';
import { useBuildingSearch } from '@/hooks/queries/use-building-search';
import { useAreas, useCategories } from '@/hooks/queries/use-reference';
import { filtersToParams, PAGE_SIZE } from '@/lib/search-params';
import type { SearchFilters } from '@/types/search';

export default function HomePage() {
  const navigate = useNavigate();
  const { data: areas = [] } = useAreas();
  const { data: categories = [] } = useCategories();
  const latest = useBuildingSearch({}, PAGE_SIZE);
  const buildings = latest.data?.pages[0]?.items ?? [];

  // Picking any filter here is the search: it opens the results with that filter applied.
  const goToResults = (filters: SearchFilters) =>
    navigate({ pathname: '/search', search: filtersToParams(filters).toString() });

  return (
    <>
      <section className="relative flex min-h-[680px] flex-col gap-7 overflow-hidden px-4 pb-32 pt-40 md:px-10 md:pt-[168px] lg:px-20">
        <div aria-hidden className="absolute inset-0">
          <img src={heroUrl} alt="" className="size-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-r from-background/95 via-background/60 via-[42%] to-transparent to-[82%]" />
          {/* In dark mode the header text is light, so the bright sky needs a scrim behind it. */}
          <div className="absolute inset-x-0 top-0 hidden h-48 bg-gradient-to-b from-background/80 to-transparent dark:block" />
        </div>
        <h1 className="relative max-w-[680px] text-5xl font-semibold leading-[1.04] tracking-[-0.03em] md:text-[64px]">
          House hunting in Ngong just got a lot easier
        </h1>
        <p className="relative max-w-[500px] text-[17px] leading-[26px] text-muted-foreground">
          Pick the house type you want, see which buildings in Ngong still have it vacant, and compare each type’s photos and price.
        </p>
        <Button asChild size="lg" className="relative w-fit">
          <Link to="/search">
            Explore rentals
            <ButtonIcon>
              <img src={arrowUpRightUrl} alt="" className="size-4" />
            </ButtonIcon>
          </Link>
        </Button>
      </section>

      <div className="relative z-10 -mt-[69px] px-4 md:px-10 lg:px-20">
        <SearchPanel className="mx-auto max-w-[1280px]" values={{}} onChange={goToResults} areas={areas} categories={categories} />
      </div>

      <section className="px-4 pb-24 pt-16 md:px-10 lg:px-20">
        <div className="mx-auto flex max-w-[1280px] flex-col gap-8">
          <div className="flex justify-end">
            <Link to="/search" className="group flex items-center gap-3 text-sm font-medium">
              See more
              <span className="flex size-8 items-center justify-center rounded-full bg-foreground/5 transition-transform duration-500 ease-fluid group-hover:-translate-y-px group-hover:translate-x-1 group-hover:scale-105">
                <img src={arrowUrl} alt="" className="size-4" />
              </span>
            </Link>
          </div>

          {latest.isPending ? (
            <LoadingState />
          ) : latest.isError ? (
            <ErrorState message={latest.error.message} onRetry={() => latest.refetch()} />
          ) : buildings.length === 0 ? (
            <EmptyState title="No vacancies yet" description="Buildings appear here as soon as their managers publish them." />
          ) : (
            <div className="grid grid-cols-1 gap-x-5 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
              {buildings.map((b, i) => (
                <Reveal key={b.id} delay={(i % 3) * 90}>
                  <BuildingCard building={b} />
                </Reveal>
              ))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
