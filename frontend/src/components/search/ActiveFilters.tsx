import closeUrl from '@/assets/icons/close.svg';
import { useLanguage } from '@/hooks/use-language';
import { categoryName } from '@/lib/format';
import type { Area, SpaceCategory } from '@/types/reference';
import type { SearchFilters } from '@/types/search';
import { formatKes } from './options';

interface ActiveFiltersProps {
  values: SearchFilters;
  onChange: (next: SearchFilters) => void;
  areas: Area[];
  categories: SpaceCategory[];
}

export function ActiveFilters({ values, onChange, areas, categories }: ActiveFiltersProps) {
  const { language, t } = useLanguage();
  const pills: { key: keyof SearchFilters; label: string }[] = [];
  const area = areas.find((a) => a.id === values.areaId);
  const category = categories.find((c) => c.id === values.categoryId);
  if (area) pills.push({ key: 'areaId', label: area.name });
  if (category) pills.push({ key: 'categoryId', label: categoryName(category, language) });
  if (values.maxRent) pills.push({ key: 'maxRent', label: t('active.under', { amount: formatKes(values.maxRent) }) });
  if (values.management) pills.push({ key: 'management', label: t(values.management === 'agent' ? 'active.agents' : 'active.landlords') });
  if (values.verifiedOnly) pills.push({ key: 'verifiedOnly', label: t('more.verified') });

  if (pills.length === 0) return null;
  return (
    <ul className="flex flex-wrap items-center gap-2" aria-label={t('active.label')}>
      {pills.map(({ key, label }) => (
        <li key={key} className="flex items-center gap-1.5 rounded-full border border-line bg-muted px-3 py-1.5 text-xs font-medium tracking-[0.01em]">
          {label}
          <button type="button" aria-label={t('active.remove', { label })} onClick={() => onChange({ ...values, [key]: undefined })}>
            <img src={closeUrl} alt="" className="size-3 dark:invert" />
          </button>
        </li>
      ))}
    </ul>
  );
}
