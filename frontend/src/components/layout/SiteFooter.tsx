import { Link } from 'react-router-dom';
import facebookUrl from '@/assets/icons/facebook.svg';
import instagramUrl from '@/assets/icons/instagram.svg';
import linkedinUrl from '@/assets/icons/linkedin.svg';
import { useLanguage } from '@/hooks/use-language';
import type { MessageKey } from '@/i18n/messages';

interface FooterColumn {
  title: MessageKey;
  /** Only the search page exists so far; links without `to` are placeholders until their screens are built. */
  links: { label: MessageKey; to?: string }[];
}

const COLUMNS: FooterColumn[] = [
  {
    title: 'nav.forRenters',
    links: [
      { label: 'nav.findRental', to: '/search' },
      { label: 'footer.commercialUnits' },
      { label: 'footer.servicesDirectory' },
      { label: 'footer.savedListings' },
    ],
  },
  {
    title: 'nav.forListers',
    links: [{ label: 'footer.list' }, { label: 'footer.verification' }, { label: 'footer.updateReminders' }, { label: 'footer.agentProfiles' }],
  },
  { title: 'footer.company', links: [{ label: 'footer.about' }, { label: 'footer.contact' }] },
];

export function SiteFooter() {
  const { t } = useLanguage();

  return (
    <footer>
      <div className="flex flex-col items-center justify-center gap-6 bg-primary px-4 py-16 text-white md:h-[262px] md:flex-row md:gap-10 md:py-0">
        <p className="text-center text-4xl font-light tracking-tight md:text-[56px]">
          {t('footer.ctaLead')}
          <span className="font-bold">{t('footer.ctaBold')}</span>
          {t('footer.ctaTail')}
        </p>
        <div className="flex items-center gap-6 text-base font-medium underline decoration-2 underline-offset-4">
          <Link to="/search">{t('footer.browse')}</Link>
          <span>{t('footer.list')}</span>
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
                <span>{t('footer.terms')}</span>
                <span>{t('footer.privacy')}</span>
                <span>{t('footer.cookies')}</span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-x-14 gap-y-8 text-[13px] leading-5">
            {COLUMNS.map(({ title, links }) => (
              <div key={title} className="flex min-w-[150px] flex-col gap-0.5">
                <p className="font-semibold">{t(title)}</p>
                {links.map(({ label, to }) =>
                  to ? (
                    <Link key={label} to={to} className="text-muted-foreground hover:text-foreground">
                      {t(label)}
                    </Link>
                  ) : (
                    <span key={label} className="text-muted-foreground">
                      {t(label)}
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
