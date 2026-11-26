import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/shared/EmptyState';
import { useLanguage } from '@/hooks/use-language';

interface ErrorStateProps {
  message?: string;
  onRetry?: () => void;
  className?: string;
}

export function ErrorState({ message, onRetry, className }: ErrorStateProps) {
  const { t } = useLanguage();
  return (
    <EmptyState
      className={className}
      title={t('error.title')}
      description={message ?? t('error.default')}
      action={
        onRetry && (
          <Button variant="outline" onClick={onRetry}>
            {t('error.retry')}
          </Button>
        )
      }
    />
  );
}
