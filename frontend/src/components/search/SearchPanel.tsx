import { useState } from 'react';
import chevronUpUrl from '@/assets/icons/chevron-up.svg';
import { useLanguage } from '@/hooks/use-language';
import { cn } from '@/lib/utils';
import type { Area, SpaceCategory } from '@/types/reference';
import type { SearchFilters } from '@/types/search';
import { MoreFilters } from './MoreFilters';
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

const Rule = () => <div className="h-px bg-border" />;

/** One surface with a single hairline; the soft ambient shadow does the lifting. */
export function SearchPanel({ values, onChange, areas, categories, expandable = false, className }: SearchPanelProps) {
  const { t } = useLanguage();
  const moreCount = (values.management ? 1 : 0) + (values.verifiedOnly ? 1 : 0);
  const [open, setOpen] = useState(moreCount > 0);

  return (
    <div className={cn('overflow-hidden rounded-3xl bg-card shadow-float ring-1 ring-foreground/10', className)}>
      <div>
        <SearchFields values={values} onChange={onChange} areas={areas} categories={categories} />
        {expandable && (
          <>
            <Rule />
            <div className="flex justify-end px-5 py-2.5">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((o) => !o)}
                className="flex items-center gap-2 rounded-full py-1 pl-3 pr-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t('more.toggle')}
                {moreCount > 0 && (
                  <span className="rounded-md bg-primary px-1.5 text-xs font-medium leading-4 text-primary-foreground">{moreCount}</span>
                )}
                <img src={chevronUpUrl} alt="" className={cn('size-4 transition-transform duration-500 ease-fluid dark:invert', !open && 'rotate-180')} />
              </button>
            </div>
            {open && (
              <>
                <Rule />
                <MoreFilters values={values} onChange={onChange} />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
