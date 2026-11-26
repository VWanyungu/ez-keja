import { useLanguage } from '@/hooks/use-language';
import { cn } from '@/lib/utils';

interface LoadingStateProps {
  fullPage?: boolean;
  className?: string;
}

export function LoadingState({ fullPage = false, className }: LoadingStateProps) {
  const { t } = useLanguage();
  return (
    <div
      role="status"
      aria-label={t('common.loading')}
      className={cn('flex items-center justify-center py-12', fullPage && 'min-h-screen', className)}
    >
      <div className="size-6 animate-spin rounded-full border-2 border-border border-t-primary" />
    </div>
  );
}
