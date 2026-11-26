import db from '../../db/knex.js';
import { assertPubliclyAvailable, availabilitySelectSql, type AvailabilityRow } from '../../lib/public-catalogue.js';
import { DailyQuota, directions, geocode, TtlCache, type DirectionsTime, type FetchFn, type GeocodeOutcome } from './maps.js';
import type { CommuteMode, CommuteQuery } from './schemas.js';

/** FR-CMT-005: the same words whether Maps is down, over quota, unconfigured or timed out. */
export const UNAVAILABLE_NOTICE = 'Commute information unavailable';
export const REFINE_NOTICE =
  'We could not find that place. Refine your destination, for example add the estate, street or a landmark.';

export const DEFAULT_MAPS_DAILY_LIMIT = 1000;
const MODE_CACHE_TTL_MS = 10 * 60_000;
const GEOCODE_CACHE_TTL_MS = 60 * 60_000;
const CACHE_MAX_ENTRIES = 500;
const TIME_BUCKET_MS = 10 * 60_000;

export type ModeResult =
  | { available: false }
  | {
      available: true;
      durationSeconds: number;
      distanceMeters: number;
      /** Encoded polyline (Google's algorithm) of the route from the building's pin to the destination. */
      polyline: string;
      /** The time basis really applied: driving cannot "arrive by", so it is estimated as a departure. */
      timeBasis: 'now' | 'depart' | 'arrive' | null;
    };

export type CommuteResponse =
  | { available: false; notice: string; destinationFound?: false }
  | {
      available: true;
      destination: { label: string; lat: number; lng: number };
      departure: { basis: 'now' | 'depart' | 'arrive'; at: string | null };
      modes: Partial<Record<CommuteMode, ModeResult>>;
    };

export interface CommuteDeps {
  /** The building's pin; throws 404/410 when it is not on public display. */
  loadPin?: (buildingId: string) => Promise<{ lat: number; lng: number }>;
  fetch?: FetchFn;
  apiKey?: () => string | undefined;
  dailyLimit?: () => number;
  now?: () => number;
  log?: { warn: (m: string) => void; error: (m: string) => void };
}

async function loadPublicPin(buildingId: string): Promise<{ lat: number; lng: number }> {
  const result = await db.raw(
    `SELECT b.latitude, b.longitude, ${availabilitySelectSql('b')} FROM buildings b WHERE b.id = ?`,
    [buildingId],
  );
  const row = result.rows[0] as (AvailabilityRow & { latitude: string; longitude: string }) | undefined;
  assertPubliclyAvailable(row);
  return { lat: Number(row!.latitude), lng: Number(row!.longitude) };
}

interface CachedMode {
  destination: { label: string; lat: number; lng: number };
  result: ModeResult;
}

const unavailable = (): CommuteResponse => ({ available: false, notice: UNAVAILABLE_NOTICE });

/**
 * FR-CMT-001 to FR-CMT-005. Built from injectable parts so the fail-soft paths are tested with a
 * fake `fetch`. Order of work: the building must be on public display (404/410), then no key means
 * "unavailable" at no cost, then cache, then the daily quota, then Google.
 *
 * shortcut: both caches live in this process and are capped at 500 entries (oldest out first);
 * with several PM2 instances each warms its own, so cost scales with the instance count. Move them
 * to a shared store together with the daily counter (see `DailyQuota`).
 */
export function createCommuteService(deps: CommuteDeps = {}) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? { warn: (m: string) => console.warn(m), error: (m: string) => console.error(m) };
  const loadPin = deps.loadPin ?? loadPublicPin;
  const fetchFn: FetchFn = deps.fetch ?? ((url, init) => fetch(url, init));
  const apiKey = deps.apiKey ?? (() => process.env.GOOGLE_MAPS_API_KEY?.trim() || undefined);
  const dailyLimit =
    deps.dailyLimit ??
    (() => {
      const n = Number(process.env.MAPS_DAILY_LIMIT);
      return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAPS_DAILY_LIMIT;
    });
  const quota = new DailyQuota(dailyLimit, now, log);
  const modeCache = new TtlCache<CachedMode>(MODE_CACHE_TTL_MS, CACHE_MAX_ENTRIES, now);
  const geocodeCache = new TtlCache<GeocodeOutcome>(GEOCODE_CACHE_TTL_MS, CACHE_MAX_ENTRIES, now);

  return async function getCommute(query: CommuteQuery): Promise<CommuteResponse> {
    const pin = await loadPin(query.buildingId);
    const key = apiKey();
    if (!key) return unavailable();

    // Cache key: building, destination (case and spacing folded), mode, and the time in 10-minute buckets.
    const placeKey = query.destination.toLowerCase();
    const timeMs = query.time.basis === 'now' ? now() : query.time.atMs;
    const modeKey = (mode: CommuteMode) =>
      `${query.buildingId}|${placeKey}|${mode}|${query.time.basis}:${Math.floor(timeMs / TIME_BUCKET_MS)}`;

    const results = new Map<CommuteMode, CachedMode>();
    for (const mode of query.modes) {
      const hit = modeCache.get(modeKey(mode));
      if (hit) results.set(mode, hit);
    }
    const missing = query.modes.filter((m) => !results.has(m));

    if (missing.length > 0) {
      const cachedPlace = geocodeCache.get(placeKey);
      if (!quota.reserve((cachedPlace ? 0 : 1) + missing.length)) return unavailable();
      let place: Exclude<GeocodeOutcome, { kind: 'error' }>;
      if (cachedPlace) {
        place = cachedPlace as typeof place;
      } else {
        const fresh = await geocode(fetchFn, key, query.destination, log.warn);
        if (fresh.kind === 'error') return unavailable();
        geocodeCache.set(placeKey, fresh);
        place = fresh;
      }
      if (place.kind === 'not_found') {
        return { available: false, destinationFound: false, notice: REFINE_NOTICE };
      }
      const destination = { label: place.label, lat: place.lat, lng: place.lng };
      const time: DirectionsTime = query.time;

      const outcomes = await Promise.all(
        missing.map((mode) => directions(fetchFn, key, pin, destination, mode, time, log.warn)),
      );
      let errored = 0;
      missing.forEach((mode, i) => {
        const outcome = outcomes[i]!;
        if (outcome.kind === 'error') {
          errored += 1; // a hiccup is not cached: the next request tries again
          return;
        }
        const result: ModeResult =
          outcome.kind === 'no_route'
            ? { available: false }
            : {
                available: true,
                durationSeconds: outcome.durationSeconds,
                distanceMeters: outcome.distanceMeters,
                polyline: outcome.polyline,
                timeBasis:
                  mode === 'walking' ? null : query.time.basis === 'arrive' && mode === 'driving' ? 'depart' : query.time.basis,
              };
        const entry = { destination, result };
        modeCache.set(modeKey(mode), entry);
        results.set(mode, entry);
      });
      if (errored === missing.length && results.size === 0) return unavailable();
    }

    const first = results.values().next().value as CachedMode;
    const modes: Partial<Record<CommuteMode, ModeResult>> = {};
    for (const mode of query.modes) modes[mode] = results.get(mode)?.result ?? { available: false };
    return {
      available: true,
      destination: first.destination,
      departure: {
        basis: query.time.basis,
        at: query.time.basis === 'now' ? null : new Date(query.time.atMs).toISOString(),
      },
      modes,
    };
  };
}

export const getCommute = createCommuteService();
