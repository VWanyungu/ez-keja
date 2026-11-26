import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/shared/EmptyState';

interface ErrorStateProps {
  message?: string;
  onRetry?: () => void;
  className?: string;
}

export function ErrorState({ message = 'Something went wrong. Please try again.', onRetry, className }: ErrorStateProps) {
  return (
    <EmptyState
      className={className}
      title="We couldn't load this"
      description={message}
      action={
        onRetry && (
          <Button variant="outline" onClick={onRetry}>
            Try again
          </Button>
        )
      }
    />
  );
}
