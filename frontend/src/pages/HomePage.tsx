import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import arrowUpRightUrl from '@/assets/icons/arrow-up-right.svg';
import arrowUrl from '@/assets/icons/arrow.svg';
import heroUrl from '@/assets/hero.jpg';
import searchUrl from '@/assets/icons/search.svg';
import { BuildingCard } from '@/components/buildings/BuildingCard';
import { SearchPanel } from '@/components/search/SearchPanel';
import { ErrorState } from '@/components/shared/ErrorState';
import { LoadingState } from '@/components/shared/LoadingState';
import { EmptyState } from '@/components/shared/EmptyState';
import { Button } from '@/components/ui/button';
import { useBuildingSearch } from '@/hooks/queries/use-building-search';
import { useAreas, useCategories } from '@/hooks/queries/use-reference';
import { filtersToParams, PAGE_SIZE } from '@/lib/search-params';
import type { SearchFilters } from '@/types/search';

export default function HomePage() {
  const navigate = useNavigate();
  const [values, setValues] = useState<SearchFilters>({});
  const { data: areas = [] } = useAreas();
  const { data: categories = [] } = useCategories();
  const latest = useBuildingSearch({}, PAGE_SIZE);
  const buildings = latest.data?.pages[0]?.items ?? [];

  const search = (event: React.FormEvent) => {
    event.preventDefault();
    navigate({ pathname: '/search', search: filtersToParams(values).toString() });
  };

  return (
    <>
      <section className="relative flex min-h-[680px] flex-col gap-7 overflow-hidden px-4 pb-32 pt-40 md:px-10 md:pt-[168px] lg:px-20">
        <div aria-hidden className="absolute inset-0">
          <img src={heroUrl} alt="" className="size-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-r from-white/95 via-white/60 via-[42%] to-transparent to-[82%]" />
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
            <img src={arrowUpRightUrl} alt="" className="size-4" />
          </Link>
        </Button>
      </section>

      <form onSubmit={search} className="relative z-10 -mt-[69px] px-4 md:px-10 lg:px-20">
        <SearchPanel
          className="mx-auto max-w-[1280px]"
          values={values}
          onChange={setValues}
          areas={areas}
          categories={categories}
          action={
            <Button type="submit" className="gap-3 py-2 pl-[18px] pr-4 md:ml-2 md:shadow-[0_8px_16px_-6px_rgba(15,92,82,0.28),0_0_0_2.5px_rgba(15,92,82,0.22)]">
              Search
              <img src={searchUrl} alt="" className="size-4" />
            </Button>
          }
        />
      </form>

      <section className="px-4 pb-14 pt-[72px] md:px-10 lg:px-20">
        <div className="mx-auto flex max-w-[1280px] flex-col gap-6">
          <div className="flex items-end justify-between">
            <h2 className="text-[32px] font-semibold leading-10 tracking-[-0.02em]">Buildings with recent vacancy updates</h2>
            <Link to="/search" aria-label="See all buildings" className="pb-2">
              <img src={arrowUrl} alt="" className="size-4" />
            </Link>
          </div>

          {latest.isPending ? (
            <LoadingState />
          ) : latest.isError ? (
            <ErrorState message={latest.error.message} onRetry={() => latest.refetch()} />
          ) : buildings.length === 0 ? (
            <EmptyState title="No vacancies yet" description="Buildings appear here as soon as their managers publish them." />
          ) : (
            <div className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2 lg:grid-cols-4">
              {buildings.map((b) => (
                <BuildingCard key={b.id} building={b} />
              ))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
