import { useId, useState } from 'react';
import chevronUpUrl from '@/assets/icons/chevron-up.svg';
import { useLanguage } from '@/hooks/use-language';
import { cn } from '@/lib/utils';
import type { Area, SpaceCategory } from '@/types/reference';
import type { SearchFilters } from '@/types/search';
import { MoreFilters } from './MoreFilters';
import { QuickFilters } from './QuickFilters';
import { SearchFields } from './SearchFields';

interface SearchPanelProps {
  values: SearchFilters;
  /** Called on every change: the panel has no submit button. */
  onChange: (next: SearchFilters) => void;
  areas: Area[];
  categories: SpaceCategory[];
  /** Results page: adds the "More filters" group (who manages it, trust). */
  expandable?: boolean;
  className?: string;
}

const Rule = () => <div className="h-px bg-line" />;

/** One surface in the same grey as the search bar; the soft ambient shadow does the lifting. */
export function SearchPanel({ values, onChange, areas, categories, expandable = false, className }: SearchPanelProps) {
  const { t } = useLanguage();
  const moreCount = (values.management ? 1 : 0) + (values.verifiedOnly ? 1 : 0);
  const [open, setOpen] = useState(moreCount > 0);
  const moreId = useId();

  return (
    <div className={cn('overflow-hidden rounded-3xl bg-muted shadow-float', className)}>
      <div>
        <SearchFields values={values} onChange={onChange} areas={areas} categories={categories} />
        {expandable && (
          <>
            <Rule />
            <div className="flex flex-col gap-1 px-5 py-2.5 sm:flex-row sm:items-center sm:gap-3">
              <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{t('quick.label')}</span>
              <div className="min-w-0 flex-1">
                <QuickFilters values={values} onChange={onChange} categories={categories} />
              </div>
              <button
                type="button"
                aria-expanded={open}
                aria-controls={moreId}
                onClick={() => setOpen((o) => !o)}
                className="flex shrink-0 items-center gap-2 self-end rounded-full sm:self-auto py-1 pl-3 pr-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t('more.toggle')}
                {moreCount > 0 && (
                  <span className="rounded-md bg-primary px-1.5 text-xs font-medium leading-4 text-primary-foreground">{moreCount}</span>
                )}
                <img src={chevronUpUrl} alt="" className={cn('size-4 transition-transform duration-500 ease-fluid motion-reduce:transition-none dark:invert', !open && 'rotate-180')} />
              </button>
            </div>
            {/* Grid rows animate the height without measuring it; `invisible` takes the closed content out of the tab order once it has faded. */}
            <div
              id={moreId}
              className={cn(
                'grid transition-[grid-template-rows,opacity,visibility] duration-500 ease-fluid motion-reduce:transition-none',
                open ? 'grid-rows-[1fr] opacity-100' : 'invisible grid-rows-[0fr] opacity-0',
              )}
            >
              <div className="min-h-0 overflow-hidden">
                <Rule />
                <MoreFilters values={values} onChange={onChange} />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
