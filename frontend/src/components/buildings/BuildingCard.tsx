import { Link } from 'react-router-dom';
import clockUrl from '@/assets/icons/clock.svg';
import pinUrl from '@/assets/icons/pin.svg';
import sealUrl from '@/assets/icons/seal.svg';
import { useLanguage } from '@/hooks/use-language';
import { formatRent } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { BuildingCard as BuildingCardData } from '@/types/search';

interface BuildingCardProps {
  building: BuildingCardData;
  className?: string;
}

interface GlyphProps {
  src: string;
  label: string;
  /** Fill colour and size of the icon shape. */
  className: string;
  /** Layout of the icon inside its line of text. */
  wrapperClassName?: string;
}

/**
 * An icon with no background, drawn from the SVG's shape as a mask so it can take a bright fill
 * that stays legible on any photo. The soft shadow sits on a wrapper because a mask would clip it.
 */
function Glyph({ src, label, className, wrapperClassName }: GlyphProps) {
  // Quoted: Vite inlines small SVGs as data URIs, and an unquoted url() with parentheses is dropped.
  const mask = `url("${src}")`;
  return (
    <span title={label} className={wrapperClassName}>
      <span
        aria-hidden
        className={cn('block', className)}
        style={{
          WebkitMaskImage: mask,
          maskImage: mask,
          WebkitMaskSize: 'contain',
          maskSize: 'contain',
          WebkitMaskRepeat: 'no-repeat',
          maskRepeat: 'no-repeat',
          WebkitMaskPosition: 'center',
          maskPosition: 'center',
        }}
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function BuildingCard({ building, className }: BuildingCardProps) {
  const { id, name, area, coverPhoto, rent, verification, outdated } = building;
  const { t } = useLanguage();
  const price = formatRent(rent);

  return (
    <Link
      to={`/buildings/${id}`}
      className={cn(
        // Mobile: edge-to-edge flat card (no border/radius) with full-bleed image above text; sm+ switches to the rounded photo overlay card.
        'relative -mx-4 flex flex-col overflow-hidden bg-card text-foreground transition-shadow duration-500 ease-fluid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:mx-0 sm:h-[460px] sm:justify-end sm:rounded-2xl sm:bg-foreground sm:px-5 sm:pb-6 sm:pt-5 sm:text-white sm:shadow-float sm:ring-1 sm:ring-transparent sm:hover:ring-primary sm:dark:hover:ring-white',
        className,
      )}
    >
      <div className="relative h-60 w-full shrink-0 overflow-hidden bg-muted sm:absolute sm:inset-0 sm:h-full">
        {coverPhoto && (
          <img
            src={coverPhoto.medium}
            srcSet={`${coverPhoto.thumb} 320w, ${coverPhoto.medium} 800w`}
            sizes="(min-width: 1024px) 414px, (min-width: 640px) 50vw, 100vw"
            alt={t('card.coverAlt', { name })}
            loading="lazy"
            className="size-full object-cover"
          />
        )}
        <div
          aria-hidden
          className="hidden sm:absolute sm:inset-0 sm:block sm:bg-gradient-to-t sm:from-black/80 sm:via-transparent sm:via-[60%] sm:to-transparent"
        />
      </div>

      {/* Mobile hierarchy: Primary price (20px bold) → Secondary title (15px medium) → Tertiary area (13px muted). */}
      <div className="relative flex flex-col gap-2 px-4 pb-5 pt-3.5 sm:gap-3 sm:p-0">
        <p className="flex items-baseline justify-between gap-2 leading-6 sm:order-2 sm:items-center sm:justify-start sm:leading-5">
          {price ? (
            <span className="flex items-baseline gap-1.5 sm:gap-1">
              <span className="text-xl font-bold tracking-tight tabular-nums sm:text-base sm:font-semibold">{price}</span>
              <span className="text-[13px] font-normal text-muted-foreground sm:text-xs sm:text-white/90">
                {t('card.perMonth')}
              </span>
            </span>
          ) : (
            <span className="text-lg font-bold tracking-tight sm:text-base sm:font-semibold">
              {t('card.rentOnInterest')}
            </span>
          )}
          {outdated && (
            <Glyph
              src={clockUrl}
              label={t('card.outdated')}
              className="size-4 bg-orange"
              wrapperClassName="flex self-center sm:drop-shadow-[0_2px_6px_rgba(0,0,0,0.45)]"
            />
          )}
        </p>

        <div className="flex flex-col gap-1 sm:order-1">
          {/* The seal is inline so it stays attached to the last word if a long name wraps. */}
          <h3 className="text-[15px] font-medium leading-snug tracking-tight text-foreground/95 sm:text-lg sm:font-semibold sm:leading-[26px] sm:text-white">
            {name}
            {verification.building === 'verified' && (
              <Glyph
                src={sealUrl}
                label={t('card.verified')}
                className="size-4 bg-primary dark:bg-primary-bright sm:size-[18px] sm:bg-primary-bright"
                wrapperClassName="ml-1.5 inline-block align-[-2px] sm:align-[-3px] sm:drop-shadow-[0_2px_6px_rgba(0,0,0,0.45)]"
              />
            )}
          </h3>
          <span className="flex items-center gap-1.5 text-[13px] leading-5 text-muted-foreground sm:text-white">
            <img src={pinUrl} alt="" className="size-3.5 opacity-75 invert dark:invert-0 sm:opacity-100 sm:invert-0" />
            {area.name}
          </span>
        </div>
      </div>
    </Link>
  );
}
