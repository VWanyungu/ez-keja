import { Link } from 'react-router-dom';
import { EmptyState } from '@/components/shared/EmptyState';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/hooks/use-language';

export default function NotFoundPage() {
  const { t } = useLanguage();
  return (
    <EmptyState
      className="min-h-[60vh] justify-center pt-40"
      title={t('notFound.title')}
      description={t('notFound.body')}
      action={
        <Button asChild>
          <Link to="/">{t('notFound.back')}</Link>
        </Button>
      }
    />
  );
}
