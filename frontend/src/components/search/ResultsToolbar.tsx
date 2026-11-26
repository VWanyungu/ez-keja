import { useId } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useLanguage } from '@/hooks/use-language';
import { cn } from '@/lib/utils';
import type { SearchSort } from '@/types/search';

interface ResultsToolbarProps {
  sort: SearchSort;
  onSortChange: (sort: SearchSort) => void;
  total?: number;
  showMap: boolean;
  onToggleMap: (show: boolean) => void;
  className?: string;
}

export function ResultsToolbar({
  sort,
  onSortChange,
  total,
  showMap,
  onToggleMap,
  className,
}: ResultsToolbarProps) {
  const { t } = useLanguage();
  const mapSwitchId = useId();
  const sortLabelId = useId();

  const countLabel =
    total === undefined ? null : total === 1 ? t('results.countOne') : t('results.countMany', { total });

  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-4', className)}>
      <div className="flex items-center gap-2">
        <span id={sortLabelId} className="text-sm text-muted-foreground">
          {t('sort.label')}
        </span>
        <Select value={sort} onValueChange={(value) => onSortChange(value as SearchSort)}>
          <SelectTrigger aria-labelledby={sortLabelId} className="w-auto gap-1.5 text-sm font-medium text-foreground">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start" className="min-w-[11rem]">
            <SelectItem value="updated">{t('sort.updated')}</SelectItem>
            <SelectItem value="rent_asc">{t('sort.rentAsc')}</SelectItem>
            <SelectItem value="rent_desc">{t('sort.rentDesc')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-5">
        {countLabel && <span className="text-sm font-medium tabular-nums text-muted-foreground">{countLabel}</span>}
        <div className="hidden items-center gap-2.5 lg:flex">
          <label htmlFor={mapSwitchId} className="cursor-pointer select-none text-sm font-medium text-foreground">
            {t('map.toggle')}
          </label>
          <Switch id={mapSwitchId} checked={showMap} onCheckedChange={onToggleMap} />
        </div>
      </div>
    </div>
  );
}
