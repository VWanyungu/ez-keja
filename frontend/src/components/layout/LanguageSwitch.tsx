import { Fragment } from 'react';
import globeUrl from '@/assets/icons/globe.svg';
import { useLanguage } from '@/hooks/use-language';
import { LANGUAGES } from '@/i18n/messages';
import { cn } from '@/lib/utils';

/** EN · SW. The current language is the full-strength one; the other is a quiet button. */
export function LanguageSwitch() {
  const { language, setLanguage, t } = useLanguage();

  return (
    <div role="group" aria-label={t('language.label')} className="flex items-center gap-2">
      <img src={globeUrl} alt="" className="size-3.5 dark:invert" />
      {LANGUAGES.map((code, index) => (
        <Fragment key={code}>
          {index > 0 && <span aria-hidden className="text-subtle">·</span>}
          <button
            type="button"
            lang={code}
            aria-pressed={language === code}
            onClick={() => setLanguage(code)}
            className={cn(
              'rounded-sm uppercase transition-colors duration-500 ease-fluid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              language === code ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {code}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
