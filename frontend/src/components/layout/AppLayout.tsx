import { Outlet } from 'react-router-dom';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { SiteHeader } from '@/components/layout/SiteHeader';

/** The header floats over each page's top section, so pages leave room for it. */
export function AppLayout() {
  return (
    <div className="relative min-h-screen">
      <SiteHeader className="absolute inset-x-4 top-3 z-20 md:inset-x-10" />
      <main>
        <Outlet />
      </main>
      <SiteFooter />
    </div>
  );
}
