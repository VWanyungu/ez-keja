import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useLanguage } from '@/hooks/use-language';
import { categoryName } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Area, SpaceCategory } from '@/types/reference';
import type { SearchFilters } from '@/types/search';
import { ANY, BEDROOM_FILTERS, formatKes, RENT_STEPS } from './options';

interface SearchFieldsProps {
  values: SearchFilters;
  onChange: (next: SearchFilters) => void;
  areas: Area[];
  categories: SpaceCategory[];
  className?: string;
}

interface FieldProps {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  children: React.ReactNode;
}

function Field({ label, value, onValueChange, children }: FieldProps) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5 px-5 py-2">
      <span className="text-xs font-medium leading-4 text-muted-foreground">{label}</span>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger aria-label={label} className="h-5">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>{children}</SelectContent>
      </Select>
    </div>
  );
}

const Divider = () => <div aria-hidden className="hidden h-9 w-px shrink-0 bg-line md:block" />;

export function SearchFields({ values, onChange, areas, categories, className }: SearchFieldsProps) {
  const { language, t } = useLanguage();
  const set = (patch: Partial<SearchFilters>) => onChange({ ...values, ...patch });
  const orAny = (value: string) => (value === ANY ? undefined : value);

  const bedroomCategories: { label: string; category: SpaceCategory }[] = [];
  for (const { code, label } of BEDROOM_FILTERS) {
    const category = categories.find((c) => c.code === code);
    if (category) bedroomCategories.push({ label: t(label), category });
  }
  const bedroomValue = bedroomCategories.some((b) => b.category.id === values.categoryId) ? values.categoryId! : ANY;

  // A max rent from a shared link may not be one of the steps; keep it selectable.
  const rentSteps = values.maxRent && !RENT_STEPS.includes(values.maxRent) ? [...RENT_STEPS, values.maxRent].sort((a, b) => a - b) : RENT_STEPS;

  return (
    <div className={cn('flex flex-col gap-1 p-3 md:flex-row md:items-center md:gap-0', className)}>
      <Field label={t('field.area')} value={values.areaId ?? ANY} onValueChange={(v) => set({ areaId: orAny(v) })}>
        <SelectItem value={ANY}>{t('option.anyArea')}</SelectItem>
        {areas.map((a) => (
          <SelectItem key={a.id} value={a.id}>
            {a.name}
          </SelectItem>
        ))}
      </Field>
      <Divider />
      <Field label={t('field.houseType')} value={values.categoryId ?? ANY} onValueChange={(v) => set({ categoryId: orAny(v) })}>
        <SelectItem value={ANY}>{t('option.anyType')}</SelectItem>
        {categories.map((c) => (
          <SelectItem key={c.id} value={c.id}>
            {categoryName(c, language)}
          </SelectItem>
        ))}
      </Field>
      <Divider />
      <Field label={t('field.bedrooms')} value={bedroomValue} onValueChange={(v) => set({ categoryId: orAny(v) })}>
        <SelectItem value={ANY}>{t('option.any')}</SelectItem>
        {bedroomCategories.map(({ label, category }) => (
          <SelectItem key={category.id} value={category.id}>
            {label}
          </SelectItem>
        ))}
      </Field>
      <Divider />
      <Field
        label={t('field.maxRent')}
        value={values.maxRent ? String(values.maxRent) : ANY}
        onValueChange={(v) => set({ maxRent: v === ANY ? undefined : Number(v) })}
      >
        <SelectItem value={ANY}>{t('option.noLimit')}</SelectItem>
        {rentSteps.map((n) => (
          <SelectItem key={n} value={String(n)}>
            {formatKes(n)}
          </SelectItem>
        ))}
      </Field>
    </div>
  );
}
