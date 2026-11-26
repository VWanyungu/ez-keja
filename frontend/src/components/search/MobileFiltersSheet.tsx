import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useLanguage } from '@/hooks/use-language';
import { categoryName } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Area, SpaceCategory } from '@/types/reference';
import type { SearchFilters } from '@/types/search';
import { MoreFilters } from './MoreFilters';
import { ANY, countActiveFilters, formatKes, RENT_STEPS } from './options';
import { QuickFilters } from './QuickFilters';

interface MobileFiltersSheetProps {
  open: boolean;
  onClose: () => void;
  values: SearchFilters;
  onChange: (next: SearchFilters) => void;
  areas: Area[];
  categories: SpaceCategory[];
  total?: number;
}

const SectionLabel = ({ children }: { children: React.ReactNode }) => (
  <p className="text-xs font-medium text-muted-foreground">{children}</p>
);

export function MobileFiltersSheet({
  open,
  onClose,
  values,
  onChange,
  areas,
  categories,
  total,
}: MobileFiltersSheetProps) {
  const { language, t } = useLanguage();
  const activeCount = countActiveFilters(values);
  const set = (patch: Partial<SearchFilters>) => onChange({ ...values, ...patch });
  const orAny = (value: string) => (value === ANY ? undefined : value);
  const rentSteps =
    values.maxRent && !RENT_STEPS.includes(values.maxRent)
      ? [...RENT_STEPS, values.maxRent].sort((a, b) => a - b)
      : RENT_STEPS;

  // Lock background scroll only when open on mobile (< md).
  useEffect(() => {
    if (!open) return;
    const mql = window.matchMedia('(max-width: 767px)');
    const sync = () => {
      document.body.style.overflow = mql.matches ? 'hidden' : '';
    };
    sync();
    mql.addEventListener('change', sync);
    return () => {
      mql.removeEventListener('change', sync);
      document.body.style.overflow = '';
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const showLabel =
    total === undefined
      ? t('filters.apply')
      : total === 1
        ? t('filters.showOneResult')
        : t('filters.showResults', { total });

  const clearFilters = () =>
    onChange({
      q: values.q,
      sort: values.sort,
    });

  return (
    <div
      role="dialog"
      aria-modal={open || undefined}
      aria-hidden={!open}
      aria-label={t('filters.title')}
      className={cn(
        'fixed inset-0 z-50 flex flex-col bg-background transition-[opacity,transform,visibility] duration-500 ease-fluid motion-reduce:transition-none md:hidden',
        open ? 'visible translate-y-0 opacity-100' : 'invisible pointer-events-none translate-y-4 opacity-0',
      )}
    >
      <header className="flex items-center justify-between border-b border-border px-4 py-3.5">
        <div className="flex items-center gap-3">
          <button
            type="button"
            aria-label={t('filters.close')}
            onClick={onClose}
            className="flex size-9 items-center justify-center rounded-full hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden>
              <path d="M10.5 3.5L6 8l4.5 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <h2 className="text-base font-semibold tracking-tight text-foreground">{t('filters.title')}</h2>
        </div>
        {activeCount > 0 && (
          <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">
            {activeCount}
          </span>
        )}
      </header>

      <div className="flex-1 space-y-6 overflow-y-auto px-4 py-5">
        <div className="space-y-2">
          <SectionLabel>{t('field.area')}</SectionLabel>
          <div className="rounded-full border border-line bg-muted px-5 py-3">
            <Select value={values.areaId ?? ANY} onValueChange={(v) => set({ areaId: orAny(v) })}>
              <SelectTrigger aria-label={t('field.area')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>{t('option.anyArea')}</SelectItem>
                {areas.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-2.5">
          <SectionLabel>{t('field.houseType')}</SectionLabel>
          <div className="rounded-full border border-line bg-muted px-5 py-3">
            <Select value={values.categoryId ?? ANY} onValueChange={(v) => set({ categoryId: orAny(v) })}>
              <SelectTrigger aria-label={t('field.houseType')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>{t('option.anyType')}</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {categoryName(c, language)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <QuickFilters values={values} onChange={onChange} categories={categories} />
        </div>

        <div className="space-y-2">
          <SectionLabel>{t('field.maxRent')}</SectionLabel>
          <div className="rounded-full border border-line bg-muted px-5 py-3">
            <Select
              value={values.maxRent ? String(values.maxRent) : ANY}
              onValueChange={(v) => set({ maxRent: v === ANY ? undefined : Number(v) })}
            >
              <SelectTrigger aria-label={t('field.maxRent')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>{t('option.noLimit')}</SelectItem>
                {rentSteps.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {formatKes(n)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-muted/60">
          <MoreFilters values={values} onChange={onChange} />
        </div>
      </div>

      <footer className="grid grid-cols-2 gap-3 border-t border-border bg-card/95 px-4 py-3.5 backdrop-blur-md">
        <Button type="button" variant="outline" disabled={activeCount === 0} onClick={clearFilters}>
          {t('filters.clearAll')}
        </Button>
        <Button type="button" onClick={onClose}>
          {showLabel}
        </Button>
      </footer>
    </div>
  );
}
