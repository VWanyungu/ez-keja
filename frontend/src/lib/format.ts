import type { BuildingCard } from '@/types/search';

const MS_PER_DAY = 86_400_000;
const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

/** "KES 7,000 – 9,500", one range per currency. Empty when the building shows no rent. */
export function formatRent(rent: BuildingCard['rent']): string {
  return rent.ranges
    .map((r) =>
      r.min === r.max
        ? `${r.currencyCode} ${number.format(r.min)}`
        : `${r.currencyCode} ${number.format(r.min)} – ${number.format(r.max)}`,
    )
    .join(' · ');
}

/** "Updated today", "Updated 1 day ago", "Updated 16 days ago". Empty when there is no update. */
export function formatUpdated(latestUpdate: string | null, now: Date = new Date()): string {
  if (!latestUpdate) return '';
  // The API sends microseconds; Date only reliably parses milliseconds.
  const updated = new Date(latestUpdate.replace(/(\.\d{3})\d+/, '$1'));
  if (Number.isNaN(updated.getTime())) return '';
  const days = Math.floor((now.getTime() - updated.getTime()) / MS_PER_DAY);
  if (days <= 0) return 'Updated today';
  return days === 1 ? 'Updated 1 day ago' : `Updated ${days} days ago`;
}
