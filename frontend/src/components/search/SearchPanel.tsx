import { useState } from 'react';
import chevronUpUrl from '@/assets/icons/chevron-up.svg';
import { cn } from '@/lib/utils';
import type { Area, SpaceCategory } from '@/types/reference';
import type { SearchFilters } from '@/types/search';
import { MoreFilters } from './MoreFilters';
import { QuickFilters } from './QuickFilters';
import { SearchFields } from './SearchFields';

interface SearchPanelProps {
  values: SearchFilters;
  onChange: (next: SearchFilters) => void;
  areas: Area[];
  categories: SpaceCategory[];
  /** Home page: a Search button after the fields. */
  action?: React.ReactNode;
  /** Results page: adds the "More filters" group (who manages it, trust). */
  expandable?: boolean;
  className?: string;
}

const Rule = () => <div className="h-px bg-border" />;

export function SearchPanel({ values, onChange, areas, categories, action, expandable = false, className }: SearchPanelProps) {
  const moreCount = (values.management ? 1 : 0) + (values.verifiedOnly ? 1 : 0);
  const [open, setOpen] = useState(moreCount > 0);

  const toggle = (
    <button
      type="button"
      aria-expanded={open}
      onClick={() => setOpen((o) => !o)}
      className="flex items-center gap-2 rounded-lg py-1 pl-2 pr-1 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      More filters
      {moreCount > 0 && <span className="rounded-md bg-primary px-1.5 text-xs font-medium leading-4 text-primary-foreground">{moreCount}</span>}
      <img src={chevronUpUrl} alt="" className={cn('size-4 transition-transform', !open && 'rotate-180')} />
    </button>
  );

  return (
    <div className={cn('overflow-hidden rounded-2xl border bg-card shadow-panel', className)}>
      <SearchFields values={values} onChange={onChange} areas={areas} categories={categories} action={action} />
      <Rule />
      <QuickFilters values={values} onChange={onChange} categories={categories} trailing={expandable ? toggle : undefined} />
      {expandable && open && (
        <>
          <Rule />
          <MoreFilters values={values} onChange={onChange} />
        </>
      )}
    </div>
  );
}
