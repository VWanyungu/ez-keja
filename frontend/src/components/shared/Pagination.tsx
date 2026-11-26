import chevronUpUrl from '@/assets/icons/chevron-up.svg';
import { useLanguage } from '@/hooks/use-language';
import { pageItems } from '@/lib/pagination';
import { cn } from '@/lib/utils';

interface PaginationProps {
  /** 0-based index of the page on screen. */
  page: number;
  /** Pages fetched so far. */
  known: number;
  /** More pages exist beyond the fetched ones. */
  hasMore: boolean;
  /** Disables the controls while a page is on its way. */
  busy?: boolean;
  onPageChange: (page: number) => void;
  className?: string;
}

const control =
  'relative flex size-8 items-center justify-center rounded-full text-sm transition-colors duration-300 ease-fluid hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40';

export function Pagination({ page, known, hasMore, busy = false, onPageChange, className }: PaginationProps) {
  const { t } = useLanguage();
  const hasPrev = page > 0;
  const hasNext = page + 1 < known || hasMore;

  return (
    <nav aria-label={t('page.label')} className={cn('flex items-center justify-center gap-1', className)}>
      <button type="button" className={control} disabled={!hasPrev || busy} aria-label={t('page.prev')} onClick={() => onPageChange(page - 1)}>
        <img src={chevronUpUrl} alt="" className="size-4 -rotate-90 dark:invert" />
      </button>
      {pageItems(page + 1, known, hasMore).map((item, i) =>
        item === 'gap' ? (
          <span key={`gap-${i}`} aria-hidden className="flex size-8 items-center justify-center text-sm text-muted-foreground">
            …
          </span>
        ) : (
          <button
            key={item}
            type="button"
            disabled={busy}
            aria-label={t('page.goTo', { page: item })}
            aria-current={item === page + 1 ? 'page' : undefined}
            className={cn(
              control,
              'text-muted-foreground',
              // The current page is bold with a short teal bar under it (Figma "Page 1" indicator).
              item === page + 1 &&
                'font-semibold text-foreground after:absolute after:inset-x-[9px] after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary',
            )}
            onClick={() => onPageChange(item - 1)}
          >
            {item}
          </button>
        ),
      )}
      <button type="button" className={control} disabled={!hasNext || busy} aria-label={t('page.next')} onClick={() => onPageChange(page + 1)}>
        <img src={chevronUpUrl} alt="" className="size-4 rotate-90 dark:invert" />
      </button>
    </nav>
  );
}
