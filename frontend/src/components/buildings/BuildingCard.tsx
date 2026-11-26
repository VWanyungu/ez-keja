import { Link } from 'react-router-dom';
import clockUrl from '@/assets/icons/clock.svg';
import pinUrl from '@/assets/icons/pin.svg';
import sealUrl from '@/assets/icons/seal.svg';
import { formatRent, formatUpdated } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { BuildingCard as BuildingCardData } from '@/types/search';

interface BuildingCardProps {
  building: BuildingCardData;
  className?: string;
}

interface GlyphProps {
  src: string;
  label: string;
  /** Fill colour for the icon shape. */
  className: string;
}

/**
 * A badge that is only its icon, drawn from the SVG's shape as a mask so it can take a bright fill
 * that stays legible on any photo. The soft shadow sits on a wrapper because a mask would clip it.
 */
function Glyph({ src, label, className }: GlyphProps) {
  // Quoted: Vite inlines small SVGs as data URIs, and an unquoted url() with parentheses is dropped.
  const mask = `url("${src}")`;
  return (
    <span className="drop-shadow-[0_2px_6px_rgba(0,0,0,0.45)]">
      <span
        aria-hidden
        className={cn('block size-5', className)}
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
  const { id, name, area, coverPhoto, rent, verification, outdated, latestUpdate } = building;
  const price = formatRent(rent);
  const updated = formatUpdated(latestUpdate);

  return (
    <Link
      to={`/buildings/${id}`}
      className={cn(
        // Outer shell of the bezel; the photo below is the inner core with a concentric radius.
        'group block rounded-[28px] bg-card p-1.5 shadow-float ring-1 ring-foreground/[0.07] transition-transform duration-700 ease-fluid hover:-translate-y-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.99]',
        className,
      )}
    >
      <div className="relative flex h-[460px] flex-col justify-between overflow-hidden rounded-[22px] bg-foreground px-5 pb-6 pt-5 text-white">
        {coverPhoto && (
          <img
            src={coverPhoto.medium}
            srcSet={`${coverPhoto.thumb} 320w, ${coverPhoto.medium} 800w`}
            sizes="(min-width: 1024px) 414px, (min-width: 640px) 50vw, 100vw"
            alt={`${name}, cover photo`}
            loading="lazy"
            className="absolute inset-0 size-full object-cover transition-transform duration-[1200ms] ease-fluid group-hover:scale-105"
          />
        )}
        <div aria-hidden className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent via-[40%] to-black/80" />

        <div className="relative flex items-center gap-2.5">
          {verification.building === 'verified' && <Glyph src={sealUrl} label="Verified building" className="bg-white" />}
          {outdated && <Glyph src={clockUrl} label="Availability may be outdated" className="bg-alert" />}
        </div>

        <div className="relative flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h3 className="text-lg font-semibold leading-[26px] tracking-tight">{name}</h3>
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-[13px] leading-5">
                <img src={pinUrl} alt="" className="size-3.5" />
                {area.name}
              </span>
              {updated && <span className="font-mono text-[11px] font-medium leading-4">{updated}</span>}
            </div>
          </div>
          {price ? (
            <p className="flex items-end gap-1 leading-5">
              <span className="text-base font-semibold tracking-tight">{price}</span>
              <span className="text-xs">/ mo</span>
            </p>
          ) : (
            <p className="text-base font-semibold leading-5 tracking-tight">Rent on interest</p>
          )}
        </div>
      </div>
    </Link>
  );
}
