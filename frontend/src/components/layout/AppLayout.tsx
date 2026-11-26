import { Outlet } from 'react-router-dom';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { SiteHeader } from '@/components/layout/SiteHeader';

/** The sticky header floats over each page's top section; -mt-[108px] is its 50px offset plus 58px height. */
export function AppLayout() {
  return (
    // flow-root stops the header's top margin from collapsing through this wrapper and shifting the page.
    <div className="relative flow-root min-h-screen">
      <SiteHeader />
      <main className="-mt-[108px]">
        <Outlet />
      </main>
      <SiteFooter />
    </div>
  );
}
