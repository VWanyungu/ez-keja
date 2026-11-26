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

export function BuildingCard({ building, className }: BuildingCardProps) {
  const { id, name, area, coverPhoto, rent, verification, outdated, latestUpdate } = building;
  const price = formatRent(rent);
  const updated = formatUpdated(latestUpdate);

  return (
    <Link
      to={`/buildings/${id}`}
      className={cn(
        'block rounded-[28px] border border-foreground/[0.07] bg-card p-1.5 drop-shadow-[0_24px_24px_rgba(13,31,28,0.1)] transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      <div className="relative flex h-[400px] flex-col justify-between overflow-hidden rounded-[22px] bg-foreground px-4 pb-6 pt-4 text-white">
        {coverPhoto && (
          <img
            src={coverPhoto.medium}
            srcSet={`${coverPhoto.thumb} 320w, ${coverPhoto.medium} 800w`}
            sizes="(min-width: 1024px) 308px, 50vw"
            alt={`${name}, cover photo`}
            loading="lazy"
            className="absolute inset-0 size-full object-cover"
          />
        )}
        <div aria-hidden className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent via-[40%] to-black/80" />

        <div className="relative flex items-center gap-1.5">
          {verification.building === 'verified' && (
            <span className="flex size-8 items-center justify-center rounded-full bg-accent">
              <img src={sealUrl} alt="" className="size-[18px]" />
              <span className="sr-only">Verified building</span>
            </span>
          )}
          {outdated && (
            <span className="flex size-8 items-center justify-center rounded-full bg-warning">
              <img src={clockUrl} alt="" className="size-[18px]" />
              <span className="sr-only">Availability may be outdated</span>
            </span>
          )}
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
