import { cn } from '@/lib/utils';
import type { SpaceCategory } from '@/types/reference';
import type { SearchFilters } from '@/types/search';
import { QUICK_FILTERS } from './options';

interface QuickFiltersProps {
  values: SearchFilters;
  onChange: (next: SearchFilters) => void;
  categories: SpaceCategory[];
  /** Pushed to the far end of the row, e.g. the "More filters" toggle. */
  trailing?: React.ReactNode;
}

export function QuickFilters({ values, onChange, categories, trailing }: QuickFiltersProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 px-5 py-3">
      <span className="text-xs font-medium tracking-[0.01em] text-muted-foreground">Quick filters</span>
      {QUICK_FILTERS.map(({ code, label }) => {
        const category = categories.find((c) => c.code === code);
        if (!category) return null;
        const selected = values.categoryId === category.id;
        return (
          <button
            key={code}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange({ ...values, categoryId: selected ? undefined : category.id })}
            className={cn(
              'rounded-lg border px-3.5 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              selected ? 'border-primary bg-accent text-accent-foreground' : 'bg-card text-foreground hover:bg-muted',
            )}
          >
            {label}
          </button>
        );
      })}
      {trailing && <div className="ml-auto">{trailing}</div>}
    </div>
  );
}
