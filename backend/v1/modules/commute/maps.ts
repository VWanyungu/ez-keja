/**
 * Google Maps over plain `fetch` (no SDK), plus the two cost guards (NFR-MON-01, OQ-18): a small
 * TTL cache and a daily call counter. Nothing here throws for a Maps problem: every failure is an
 * `error` outcome, so the commute panel degrades and the page keeps working (FR-CMT-005).
 *
 * Never log the destination text, the key or a request URL: they hold a user's place of work or a
 * secret. Log the Google status code only.
 */
import type { CommuteMode } from './schemas.js';

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const DIRECTIONS_URL = 'https://maps.googleapis.com/maps/api/directions/json';
const REQUEST_TIMEOUT_MS = 5_000;

export type FetchFn = (input: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export type GeocodeOutcome =
  | { kind: 'found'; lat: number; lng: number; label: string }
  | { kind: 'not_found' }
  | { kind: 'error' };

export type RouteOutcome =
  | { kind: 'route'; durationSeconds: number; distanceMeters: number; polyline: string }
  | { kind: 'no_route' }
  | { kind: 'error' };

/** What the caller wants as the Directions time. `basis` says what was really applied (see below). */
export type DirectionsTime = { basis: 'now' } | { basis: 'depart' | 'arrive'; atMs: number };

interface GoogleJson {
  status?: string;
  results?: Array<{ formatted_address?: string; geometry?: { location?: { lat: number; lng: number } } }>;
  routes?: Array<{
    overview_polyline?: { points?: string };
    legs?: Array<{ duration?: { value: number }; duration_in_traffic?: { value: number }; distance?: { value: number } }>;
  }>;
}

async function getJson(fetchFn: FetchFn, url: string, what: string, warn: (m: string) => void): Promise<GoogleJson | null> {
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) {
      warn(`[maps] ${what} failed: HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as GoogleJson;
  } catch (err) {
    // The name only (TimeoutError, TypeError...): the message can carry the URL and so the key.
    warn(`[maps] ${what} failed: ${(err as { name?: string } | null)?.name ?? 'error'}`);
    return null;
  }
}

export async function geocode(
  fetchFn: FetchFn,
  apiKey: string,
  destination: string,
  warn: (m: string) => void,
): Promise<GeocodeOutcome> {
  const params = new URLSearchParams({ address: destination, region: 'ke', key: apiKey });
  const json = await getJson(fetchFn, `${GEOCODE_URL}?${params}`, 'geocode', warn);
  if (!json) return { kind: 'error' };
  if (json.status === 'ZERO_RESULTS') return { kind: 'not_found' };
  const first = json.results?.[0];
  const location = first?.geometry?.location;
  if (json.status !== 'OK' || !location) {
    warn(`[maps] geocode returned status ${json.status ?? 'unknown'}`);
    return { kind: 'error' };
  }
  return { kind: 'found', lat: location.lat, lng: location.lng, label: first?.formatted_address ?? '' };
}

/**
 * Directions API. Walking ignores the time. Transit supports both departure and arrival times.
 * Driving has no arrival time in this API, so an "arrive" request is estimated as a departure at
 * that time (the service reports the basis it actually applied).
 */
export async function directions(
  fetchFn: FetchFn,
  apiKey: string,
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  mode: CommuteMode,
  time: DirectionsTime,
  warn: (m: string) => void,
): Promise<RouteOutcome> {
  const params = new URLSearchParams({
    origin: `${origin.lat},${origin.lng}`,
    destination: `${destination.lat},${destination.lng}`,
    mode,
    key: apiKey,
  });
  if (mode !== 'walking') {
    if (time.basis === 'now') params.set('departure_time', 'now');
    else if (time.basis === 'arrive' && mode === 'transit') params.set('arrival_time', String(Math.floor(time.atMs / 1000)));
    else params.set('departure_time', String(Math.floor(time.atMs / 1000)));
  }
  const json = await getJson(fetchFn, `${DIRECTIONS_URL}?${params}`, `directions(${mode})`, warn);
  if (!json) return { kind: 'error' };
  if (json.status === 'ZERO_RESULTS' || json.status === 'NOT_FOUND') return { kind: 'no_route' };
  const route = json.routes?.[0];
  const leg = route?.legs?.[0];
  const duration = leg?.duration_in_traffic?.value ?? leg?.duration?.value;
  const distance = leg?.distance?.value;
  const polyline = route?.overview_polyline?.points;
  if (json.status !== 'OK' || duration === undefined || distance === undefined || !polyline) {
    warn(`[maps] directions(${mode}) returned status ${json.status ?? 'unknown'}`);
    return { kind: 'error' };
  }
  return { kind: 'route', durationSeconds: duration, distanceMeters: distance, polyline };
}

/** Insertion-ordered map with a TTL and a size cap: the oldest entry goes when it is full. */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }
}

/**
 * NFR-MON-01: Google calls made today against `MAPS_DAILY_LIMIT`. A warning is logged at 80% and
 * again when the limit is hit; the Admin alert email (N-11) arrives in Phase 9 and will hang off
 * these two moments.
 * shortcut: the count lives in this process and resets at 00:00 UTC. With several PM2 instances
 * each has its own count, so real usage can reach instances x limit; move it to a shared store
 * (a database row or Redis) before running more than one instance.
 */
export class DailyQuota {
  private day = '';
  private used = 0;
  private warned = false;
  private exhausted = false;

  constructor(
    private readonly limit: () => number,
    private readonly now: () => number,
    private readonly log: { warn: (m: string) => void; error: (m: string) => void },
  ) {}

  /** Reserves `calls` Google calls, or refuses the whole batch when it would pass the limit. */
  reserve(calls: number): boolean {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.used = 0;
      this.warned = false;
      this.exhausted = false;
    }
    const limit = this.limit();
    if (this.used + calls > limit) {
      if (!this.exhausted) {
        this.exhausted = true;
        this.log.error(`[maps] daily limit of ${limit} calls reached: commute answers "unavailable" until 00:00 UTC`);
      }
      return false;
    }
    this.used += calls;
    if (!this.warned && this.used >= limit * 0.8) {
      this.warned = true;
      this.log.warn(`[maps] daily usage at ${this.used} of ${limit} calls (80% reached)`);
    }
    return true;
  }
}
