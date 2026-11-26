import { Link, useLocation } from 'react-router-dom';
import globeUrl from '@/assets/icons/globe.svg';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface SiteHeaderProps {
  className?: string;
}

const LINKS = [
  { label: 'Find a rental', to: '/search' },
  { label: 'Commercial', to: '/commercial' },
  { label: 'Services', to: '/services' },
  { label: 'How it works', to: '/how-it-works' },
];

export function SiteHeader({ className }: SiteHeaderProps) {
  const { pathname } = useLocation();
  // "Find a rental" is the section both the home page and the search results belong to.
  const isActive = (to: string) => (to === '/search' ? pathname === '/' || pathname.startsWith('/search') : pathname.startsWith(to));

  return (
    <header className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex items-center justify-between px-4 py-2 text-xs font-medium tracking-[0.01em] md:px-7">
        <div className="flex gap-6">
          <span>For renters</span>
          <span className="text-muted-foreground">For listers</span>
        </div>
        <div className="flex items-center gap-2">
          <img src={globeUrl} alt="" className="size-3.5" />
          <span>EN</span>
          <span className="text-subtle">·</span>
          <span className="text-muted-foreground">SW</span>
        </div>
      </div>

      <div className="flex items-center justify-between rounded-2xl border border-white/70 bg-white/20 px-4 py-3 shadow-panel backdrop-blur-xl md:px-7">
        <div className="flex items-center gap-10">
          <Link to="/" className="text-lg font-semibold tracking-tight">
            KHunt
          </Link>
          <nav aria-label="Main" className="hidden items-center gap-7 text-sm font-medium md:flex">
            {LINKS.map(({ label, to }) => (
              <Link key={to} to={to} className={cn(isActive(to) ? 'text-primary' : 'text-foreground')}>
                {label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-5">
          <Link to="/login" className="text-sm font-medium">
            Log in
          </Link>
          <Button asChild>
            <Link to="/register">Register</Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
