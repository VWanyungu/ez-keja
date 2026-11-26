import type { MessageKey } from '@/i18n/messages';
import type { SearchFilters } from '@/types/search';

/** Sentinel for "no filter": Radix Select cannot hold an empty-string value. */
export const ANY = 'any';

/** Number of active panel filters (matches ActiveFilters pills; excludes text query and sort). */
export function countActiveFilters(filters: SearchFilters): number {
  let count = 0;
  if (filters.areaId) count += 1;
  if (filters.categoryId) count += 1;
  if (filters.maxRent) count += 1;
  if (filters.management) count += 1;
  if (filters.verifiedOnly) count += 1;
  return count;
}

/** The bedroom field narrows to one space category; `code` is that category's code. */
export const BEDROOM_FILTERS: { code: string; label: MessageKey }[] = [
  { code: 'bedsitter', label: 'bed.bedsitter' },
  { code: 'one_bedroom', label: 'bed.one' },
  { code: 'two_bedroom', label: 'bed.two' },
  { code: 'three_bedroom', label: 'bed.three' },
];

/** The results page's one-tap house types, in the Figma order. A chip without a `label` shows the category's own name. */
export const QUICK_FILTERS: { code: string; label?: MessageKey }[] = [
  ...BEDROOM_FILTERS,
  { code: 'office' },
  { code: 'shop' },
  { code: 'warehouse' },
];

/** Max rent steps in KES. */
export const RENT_STEPS = [5_000, 10_000, 20_000, 30_000, 50_000, 100_000];

export const formatKes = (amount: number) => `KES ${amount.toLocaleString('en-US')}`;
