import { Link, useLocation } from 'react-router-dom';
import globeUrl from '@/assets/icons/globe.svg';
import { ThemeToggle } from '@/components/layout/ThemeToggle';
import { Button } from '@/components/ui/button';
import { useScrolled } from '@/hooks/use-scrolled';
import { cn } from '@/lib/utils';

const LINKS = [
  { label: 'Find a rental', to: '/search' },
  { label: 'Commercial', to: '/commercial' },
  { label: 'Services', to: '/services' },
  { label: 'How it works', to: '/how-it-works' },
];

/**
 * Two parts: a utility strip that scrolls away with the page, and a floating glass bar that
 * sticks. The bar takes 50px (strip) of top margin plus its own 58px of height in the flow, which
 * AppLayout pulls back with a negative margin so each page can start at the very top.
 */
export function SiteHeader() {
  const { pathname } = useLocation();
  const scrolled = useScrolled();
  // "Find a rental" is the section both the home page and the search results belong to.
  const isActive = (to: string) => (to === '/search' ? pathname === '/' || pathname.startsWith('/search') : pathname.startsWith(to));

  return (
    <>
      <div className="absolute inset-x-4 top-3 z-20 flex items-center justify-between px-4 py-1 text-xs font-medium tracking-[0.01em] md:inset-x-10 md:px-7">
        <div className="flex gap-6">
          <span>For renters</span>
          <span className="text-muted-foreground">For listers</span>
        </div>
        <div className="flex items-center gap-2">
          <img src={globeUrl} alt="" className="size-3.5 dark:invert" />
          <span>EN</span>
          <span className="text-subtle">·</span>
          <span className="text-muted-foreground">SW</span>
          <ThemeToggle />
        </div>
      </div>

      <header
        className={cn(
          'sticky top-3 z-30 mx-4 mt-[50px] flex h-[58px] items-center justify-between rounded-full border px-5 backdrop-blur-xl transition-[background-color,box-shadow] duration-700 ease-fluid md:mx-10 md:px-7',
          scrolled
            ? 'border-white/70 bg-background/80 shadow-float dark:border-white/10'
            : 'border-white/70 bg-white/20 shadow-panel dark:border-white/10 dark:bg-black/20',
        )}
      >
        <div className="flex items-center gap-10">
          <Link to="/" className="text-lg font-semibold tracking-tight">
            KHunt
          </Link>
          <nav aria-label="Main" className="hidden items-center gap-7 text-sm font-medium md:flex">
            {LINKS.map(({ label, to }) => (
              <Link
                key={to}
                to={to}
                className={cn('transition-colors duration-500 ease-fluid hover:text-primary', isActive(to) ? 'text-primary' : 'text-foreground')}
              >
                {label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-5">
          <Link to="/login" className="text-sm font-medium transition-colors duration-500 ease-fluid hover:text-primary">
            Log in
          </Link>
          <Button asChild>
            <Link to="/register">Register</Link>
          </Button>
        </div>
      </header>
    </>
  );
}
