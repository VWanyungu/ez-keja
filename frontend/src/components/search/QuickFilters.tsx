import { useLanguage } from '@/hooks/use-language';
import { categoryName } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { SpaceCategory } from '@/types/reference';
import type { SearchFilters } from '@/types/search';
import { QUICK_FILTERS } from './options';

interface QuickFiltersProps {
  values: SearchFilters;
  onChange: (next: SearchFilters) => void;
  categories: SpaceCategory[];
}

/** One-tap house types. A chip is the house-type filter, so picking one replaces the other and picking it again clears it. */
export function QuickFilters({ values, onChange, categories }: QuickFiltersProps) {
  const { language, t } = useLanguage();

  return (
    <ul className="flex items-center gap-2 overflow-x-auto py-1 [scrollbar-width:none]" aria-label={t('quick.label')}>
      {QUICK_FILTERS.flatMap(({ code, label }) => {
        const category = categories.find((c) => c.code === code);
        if (!category) return [];
        const selected = values.categoryId === category.id;
        return (
          <li key={code} className="shrink-0">
            <button
              type="button"
              aria-pressed={selected}
              onClick={() => onChange({ ...values, categoryId: selected ? undefined : category.id })}
              className={cn(
                'rounded-lg border px-3.5 py-1.5 text-[13px] font-medium leading-5 transition-colors duration-300 ease-fluid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                selected ? 'border-primary bg-accent text-accent-foreground' : 'border-border bg-card hover:bg-muted',
              )}
            >
              {label ? t(label) : categoryName(category, language)}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
