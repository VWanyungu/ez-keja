import { cn } from '@/lib/utils';

interface LoadingStateProps {
  fullPage?: boolean;
  className?: string;
}

export function LoadingState({ fullPage = false, className }: LoadingStateProps) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className={cn('flex items-center justify-center py-12', fullPage && 'min-h-screen', className)}
    >
      <div className="size-6 animate-spin rounded-full border-2 border-border border-t-primary" />
    </div>
  );
}
