import { Suspense } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from 'react-error-boundary';
import { BrowserRouter } from 'react-router-dom';
import { ApiError } from '@/api/client';
import { LanguageProvider } from '@/components/i18n/LanguageProvider';
import { LoadingState } from '@/components/shared/LoadingState';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
import { useLanguage } from '@/hooks/use-language';
import { AppRoutes } from '@/routes';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});

function ErrorFallback() {
  const { t } = useLanguage();
  return <div className="p-8 text-center">{t('error.boundary')}</div>;
}

export default function App() {
  return (
    <ThemeProvider>
      <LanguageProvider>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <ErrorBoundary fallback={<ErrorFallback />}>
              <Suspense fallback={<LoadingState fullPage />}>
                <AppRoutes />
              </Suspense>
            </ErrorBoundary>
          </BrowserRouter>
        </QueryClientProvider>
      </LanguageProvider>
    </ThemeProvider>
  );
}
