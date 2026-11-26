import { Link } from 'react-router-dom';
import { EmptyState } from '@/components/shared/EmptyState';
import { Button } from '@/components/ui/button';

export default function NotFoundPage() {
  return (
    <EmptyState
      className="min-h-[60vh] justify-center pt-40"
      title="Page not found"
      description="This page does not exist yet, or the link is wrong."
      action={
        <Button asChild>
          <Link to="/">Back to home</Link>
        </Button>
      }
    />
  );
}
