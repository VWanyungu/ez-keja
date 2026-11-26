import { lazy } from 'react';
import { Route, Routes } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';

const HomePage = lazy(() => import('@/pages/HomePage'));
const SearchPage = lazy(() => import('@/pages/SearchPage'));
const NotFoundPage = lazy(() => import('@/pages/NotFoundPage'));

// Home and search are public (Guests can browse), so nothing here sits behind ProtectedRoute yet.
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
