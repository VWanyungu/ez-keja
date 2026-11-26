import { Link } from 'react-router-dom';
import facebookUrl from '@/assets/icons/facebook.svg';
import instagramUrl from '@/assets/icons/instagram.svg';
import linkedinUrl from '@/assets/icons/linkedin.svg';

const COLUMNS = [
  { title: 'For renters', links: ['Find a rental', 'Commercial units', 'Services directory', 'Saved listings'] },
  { title: 'For listers', links: ['List a unit', 'Verification', 'Update reminders', 'Agent profiles'] },
  { title: 'Company', links: ['About', 'Contact'] },
];

// Only the search page exists so far; the rest are placeholders until their screens are built.
const DESTINATIONS: Record<string, string> = { 'Find a rental': '/search' };

export function SiteFooter() {
  return (
    <footer>
      <div className="flex flex-col items-center justify-center gap-6 bg-primary px-4 py-16 text-white md:h-[262px] md:flex-row md:gap-10 md:py-0">
        <p className="text-center text-4xl font-light tracking-tight md:text-[56px]">
          Let’s find your next <span className="font-bold">home</span>
        </p>
        <div className="flex items-center gap-6 text-base font-medium underline decoration-2 underline-offset-4">
          <Link to="/search">Browse rentals</Link>
          <span>List a unit</span>
        </div>
      </div>

      <div className="overflow-hidden bg-accent px-4 pt-16 md:px-10">
        <div className="flex flex-col justify-between gap-10 md:flex-row">
          <div className="flex flex-col gap-7">
            <div className="flex gap-5">
              <img src={linkedinUrl} alt="LinkedIn" className="size-5 dark:invert" />
              <img src={instagramUrl} alt="Instagram" className="size-5 dark:invert" />
              <img src={facebookUrl} alt="Facebook" className="size-5 dark:invert" />
            </div>
            <div className="flex flex-wrap items-center gap-x-10 gap-y-2 text-[13px]">
              <span className="text-muted-foreground">©2026 KHunt</span>
              <div className="flex gap-5">
                <span>Terms of Use</span>
                <span>Privacy Policy</span>
                <span>Cookies</span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-x-14 gap-y-8 text-[13px] leading-5">
            {COLUMNS.map(({ title, links }) => (
              <div key={title} className="flex min-w-[150px] flex-col gap-0.5">
                <p className="font-semibold">{title}</p>
                {links.map((label) =>
                  DESTINATIONS[label] ? (
                    <Link key={label} to={DESTINATIONS[label]} className="text-muted-foreground hover:text-foreground">
                      {label}
                    </Link>
                  ) : (
                    <span key={label} className="text-muted-foreground">
                      {label}
                    </span>
                  ),
                )}
              </div>
            ))}
          </div>
        </div>

        {/* The oversized wordmark is cropped by the footer's bottom edge; sizes follow the viewport. */}
        <div aria-hidden className="relative mt-16 h-[19vw] overflow-hidden">
          <p className="absolute -left-[0.8vw] -top-[9vw] select-none whitespace-nowrap text-[33vw] font-bold leading-normal tracking-[-0.04em] text-tint">
            KHunt
          </p>
        </div>
      </div>
    </footer>
  );
}
