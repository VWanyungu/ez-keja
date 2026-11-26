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
    <span title={label} className={cn('drop-shadow-[0_2px_6px_rgba(0,0,0,0.45)]', wrapperClassName)}>
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
        // One surface, one edge. The only hover effect is a thin border: teal in light, white in dark.
        'relative flex h-[460px] flex-col justify-end overflow-hidden rounded-2xl bg-foreground px-5 pb-6 pt-5 text-white shadow-float ring-1 ring-transparent transition-shadow duration-500 ease-fluid hover:ring-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:ring-white',
        className,
      )}
    >
      {coverPhoto && (
        <img
          src={coverPhoto.medium}
          srcSet={`${coverPhoto.thumb} 320w, ${coverPhoto.medium} 800w`}
          sizes="(min-width: 1024px) 414px, (min-width: 640px) 50vw, 100vw"
          alt={t('card.coverAlt', { name })}
          loading="lazy"
          className="absolute inset-0 size-full object-cover"
        />
      )}
      <div aria-hidden className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent via-[60%] to-transparent" />

      <div className="relative flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          {/* The seal is inline so it stays attached to the last word if a long name wraps. */}
          <h3 className="text-lg font-semibold leading-[26px] tracking-tight">
            {name}
            {verification.building === 'verified' && (
              <Glyph
                src={sealUrl}
                label={t('card.verified')}
                className="size-[18px] bg-primary-bright"
                wrapperClassName="ml-1.5 inline-block align-[-3px]"
              />
            )}
          </h3>
          <span className="flex items-center gap-1.5 text-[13px] leading-5">
            <img src={pinUrl} alt="" className="size-3.5" />
            {area.name}
          </span>
        </div>

        <p className="flex items-center gap-2 leading-5">
          {price ? (
            <span className="flex items-baseline gap-1">
              <span className="text-base font-semibold tracking-tight">{price}</span>
              <span className="text-xs">{t('card.perMonth')}</span>
            </span>
          ) : (
            <span className="text-base font-semibold tracking-tight">{t('card.rentOnInterest')}</span>
          )}
          {outdated && <Glyph src={clockUrl} label={t('card.outdated')} className="size-4 bg-orange" wrapperClassName="flex" />}
        </p>
      </div>
    </Link>
  );
}
