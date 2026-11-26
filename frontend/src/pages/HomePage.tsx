import { Link, useNavigate } from 'react-router-dom';
import arrowUpRightUrl from '@/assets/icons/arrow-up-right.svg';
import heroUrl from '@/assets/hero.jpg';
import { BuildingCard } from '@/components/buildings/BuildingCard';
import { SearchPanel } from '@/components/search/SearchPanel';
import { EmptyState } from '@/components/shared/EmptyState';
import { ErrorState } from '@/components/shared/ErrorState';
import { LoadingState } from '@/components/shared/LoadingState';
import { Reveal } from '@/components/shared/Reveal';
import { Button, ButtonIcon } from '@/components/ui/button';
import { useBuildingSearch } from '@/hooks/queries/use-building-search';
import { useLanguage } from '@/hooks/use-language';
import { useAreas, useCategories } from '@/hooks/queries/use-reference';
import { filtersToParams, PAGE_SIZE } from '@/lib/search-params';
import type { SearchFilters } from '@/types/search';

export default function HomePage() {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const { data: areas = [] } = useAreas();
  const { data: categories = [] } = useCategories();
  const latest = useBuildingSearch({}, PAGE_SIZE);
  const buildings = latest.data?.pages[0]?.items ?? [];

  // Picking any filter here is the search: it opens the results with that filter applied.
  const goToResults = (filters: SearchFilters) =>
    navigate({ pathname: '/search', search: filtersToParams(filters).toString() });

  return (
    <>
      <section className="relative flex min-h-[640px] flex-col gap-7 overflow-hidden px-4 pb-24 pt-40 md:px-10 md:pt-[168px] lg:px-20">
        <div aria-hidden className="absolute inset-0">
          <img src={heroUrl} alt="" className="size-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-r from-background/95 via-background/60 via-[42%] to-transparent to-[82%]" />
          {/* In dark mode the header text is light, so the bright sky needs a scrim behind it. */}
          <div className="absolute inset-x-0 top-0 hidden h-48 bg-gradient-to-b from-background/80 to-transparent dark:block" />
        </div>
        <h1 className="relative max-w-[680px] text-5xl font-semibold leading-[1.04] tracking-[-0.03em] md:text-[64px]">
          {t('hero.title')}
        </h1>
        <p className="relative max-w-[500px] text-[17px] leading-[26px] text-muted-foreground">{t('hero.body')}</p>
        <Button asChild size="lg" className="relative w-fit">
          <Link to="/search">
            {t('hero.cta')}
            <ButtonIcon>
              <img src={arrowUpRightUrl} alt="" className="size-4" />
            </ButtonIcon>
          </Link>
        </Button>
      </section>

      {/* Zero height, with the panel pulled up by half of its own height: centred on the seam whatever its size. */}
      <div className="relative z-10 hidden h-0 px-4 md:block md:px-10 lg:px-20">
        <SearchPanel
          className="mx-auto max-w-[1280px] -translate-y-1/2"
          values={{}}
          onChange={goToResults}
          areas={areas}
          categories={categories}
        />
      </div>

      <section className="px-4 pb-24 pt-8 md:px-10 md:pt-[72px] lg:px-20">
        <div className="mx-auto flex max-w-[1280px] flex-col gap-6">
          <div className="flex justify-end">
            <Link
              to="/search"
              className="text-xs font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-primary-bright"
            >
              {t('home.seeMore')}
            </Link>
          </div>

          {latest.isPending ? (
            <LoadingState />
          ) : latest.isError ? (
            <ErrorState message={latest.error.message} onRetry={() => latest.refetch()} />
          ) : buildings.length === 0 ? (
            <EmptyState title={t('home.emptyTitle')} description={t('home.emptyBody')} />
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
