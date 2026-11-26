export type PageItem = number | 'gap';

/**
 * Page numbers to show, 1-based. The API pages by cursor, so only the pages fetched so far are known:
 * `known` is how many, and `hasMore` adds a trailing gap for the ones not fetched yet.
 * Keeps the first and last known pages and the current one with its neighbours; the rest collapse to a gap.
 */
export function pageItems(current: number, known: number, hasMore: boolean): PageItem[] {
  const items: PageItem[] = [];
  let last = 0;
  for (let page = 1; page <= known; page++) {
    if (page !== 1 && page !== known && Math.abs(page - current) > 1) continue;
    if (page - last > 1) items.push('gap');
    items.push(page);
    last = page;
  }
  if (hasMore) items.push('gap');
  return items;
}

/** The results header's "1–9": a page's position among all results, from its 0-based index and item count. */
export function pageRange(pageIndex: number, pageSize: number, count: number): { from: number; to: number } {
  const from = pageIndex * pageSize + 1;
  return { from, to: from + count - 1 };
}
