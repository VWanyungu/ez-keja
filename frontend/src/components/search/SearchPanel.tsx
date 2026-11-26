import { useState } from 'react';
import chevronUpUrl from '@/assets/icons/chevron-up.svg';
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

/** A shell and a core, so the panel reads as a glass plate seated in a tray. */
export function SearchPanel({ values, onChange, areas, categories, expandable = false, className }: SearchPanelProps) {
  const moreCount = (values.management ? 1 : 0) + (values.verifiedOnly ? 1 : 0);
  const [open, setOpen] = useState(moreCount > 0);

  return (
    <div className={cn('rounded-[1.75rem] bg-foreground/[0.04] p-1.5 shadow-float ring-1 ring-foreground/5', className)}>
      <div className="overflow-hidden rounded-[calc(1.75rem-0.375rem)] bg-card shadow-[inset_0_1px_1px_hsl(0_0%_100%/0.6)] dark:shadow-[inset_0_1px_1px_hsl(0_0%_100%/0.06)]">
        <SearchFields values={values} onChange={onChange} areas={areas} categories={categories} />
        {expandable && (
          <>
            <Rule />
            <div className="flex justify-end px-5 py-2.5">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((o) => !o)}
                className="flex items-center gap-2 rounded-full py-1 pl-3 pr-2 text-sm font-medium transition-colors duration-500 ease-fluid hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                More filters
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
