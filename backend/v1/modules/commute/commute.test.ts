import { describe, expect, it } from 'bun:test';
import express, { type ErrorRequestHandler } from 'express';
import type { Server } from 'node:http';
import { HttpError } from '../../lib/http-error.js';
import { DailyQuota, TtlCache, type FetchFn } from './maps.js';
import { createCommuteRouter } from './routes.js';
import { nextOccurrenceMs, parseCommuteQuery, type CommuteQuery } from './schemas.js';
import { createCommuteService, REFINE_NOTICE, UNAVAILABLE_NOTICE, type CommuteDeps } from './service.js';

const BUILDING = '019363c8-1234-7000-8000-0000000000b1';
// Wednesday 25 Nov 2026, 10:00 UTC = 13:00 in Nairobi.
const WED_NOON_UTC = Date.UTC(2026, 10, 25, 10, 0, 0);

const refused = (query: Record<string, string>) => {
  try {
    parseCommuteQuery(query, WED_NOON_UTC);
  } catch (err) {
    return err as { status: number; code?: string };
  }
  return null;
};

describe('parseCommuteQuery (FR-CMT-001, FR-CMT-003)', () => {
  const base = { buildingId: BUILDING, destination: '  Westlands,   Nairobi ' };

  it('defaults to all three modes and departing now, and tidies the destination', () => {
    expect(parseCommuteQuery(base, WED_NOON_UTC)).toEqual({
      buildingId: BUILDING,
      destination: 'Westlands, Nairobi',
      modes: ['driving', 'transit', 'walking'],
      time: { basis: 'now' },
    });
  });

  it('takes one mode, or a day and time to depart or arrive', () => {
    expect(parseCommuteQuery({ ...base, mode: 'transit' }, WED_NOON_UTC).modes).toEqual(['transit']);
    const depart = parseCommuteQuery({ ...base, when: 'depart', time: 'Monday 07:30' }, WED_NOON_UTC);
    expect(depart.time).toEqual({ basis: 'depart', atMs: Date.UTC(2026, 10, 30, 4, 30) }); // Mon 07:30 Nairobi
    expect(parseCommuteQuery({ ...base, when: 'arrive', time: 'fri 18:05' }, WED_NOON_UTC).time).toMatchObject({ basis: 'arrive' });
  });

  it('refuses a missing, too short, too long or control-character destination', () => {
    for (const destination of ['x', 'x'.repeat(201), 'a\u0000b', 'bell\u0007']) {
      expect(refused({ buildingId: BUILDING, destination })?.code).toBe('INVALID_DESTINATION');
    }
    expect(refused({ buildingId: BUILDING, destination: '   ' })?.code).toBe('INVALID_DESTINATION');
    expect(refused({ buildingId: BUILDING, destination: '' })?.status).toBe(400);
    expect(refused({ buildingId: BUILDING })?.status).toBe(400);
    // Line breaks are whitespace and fold into a single space rather than being refused.
    expect(parseCommuteQuery({ buildingId: BUILDING, destination: 'Two\nlines' }, WED_NOON_UTC).destination).toBe('Two lines');
    expect(refused({ ...base, buildingId: 'nope' })?.status).toBe(400);
  });

  it('refuses a bad mode, time or a time without when', () => {
    expect(refused({ ...base, mode: 'flying' })?.status).toBe(400);
    expect(refused({ ...base, when: 'later' })?.status).toBe(400);
    expect(refused({ ...base, when: 'depart' })?.status).toBe(400);
    expect(refused({ ...base, time: 'Monday 07:30' })?.status).toBe(400);
    for (const time of ['Monday 25:00', 'Monday 07:60', 'Funday 07:30', '07:30', 'Monday']) {
      expect(refused({ ...base, when: 'depart', time })?.code).toBe('INVALID_TIME');
    }
    expect(refused({ ...base, extra: '1' })?.status).toBe(400);
  });
});

describe('nextOccurrenceMs', () => {
  it('finds the next occurrence of a weekday and time in Nairobi, strictly in the future', () => {
    expect(nextOccurrenceMs(1, 7, 30, WED_NOON_UTC)).toBe(Date.UTC(2026, 10, 30, 4, 30)); // coming Monday
    expect(nextOccurrenceMs(3, 18, 0, WED_NOON_UTC)).toBe(Date.UTC(2026, 10, 25, 15, 0)); // later today
    expect(nextOccurrenceMs(3, 8, 0, WED_NOON_UTC)).toBe(Date.UTC(2026, 11, 2, 5, 0)); // earlier today: next week
    expect(nextOccurrenceMs(3, 13, 0, WED_NOON_UTC)).toBe(Date.UTC(2026, 11, 2, 10, 0)); // right now: next week
  });
});

describe('TtlCache', () => {
  it('expires entries and drops the oldest when full', () => {
    let now = 0;
    const cache = new TtlCache<number>(1000, 2, () => now);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3); // evicts a
    expect([cache.get('a'), cache.get('b'), cache.get('c')]).toEqual([undefined, 2, 3]);
    now = 1000;
    expect(cache.get('b')).toBeUndefined();
  });
});

describe('DailyQuota (NFR-MON-01)', () => {
  const make = (limit: number, clock: { now: number }) => {
    const logs: string[] = [];
    const quota = new DailyQuota(() => limit, () => clock.now, { warn: (m) => logs.push(`warn ${m}`), error: (m) => logs.push(`error ${m}`) });
    return { quota, logs };
  };

  it('warns once at 80%, refuses past the limit and says so once', () => {
    const clock = { now: WED_NOON_UTC };
    const { quota, logs } = make(10, clock);
    expect(quota.reserve(7)).toBe(true);
    expect(logs).toEqual([]);
    expect(quota.reserve(1)).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('80%');
    expect(quota.reserve(1)).toBe(true); // 9 used: no second warning
    expect(logs).toHaveLength(1);
    expect(quota.reserve(2)).toBe(false); // would make 11
    expect(quota.reserve(2)).toBe(false);
    expect(logs.filter((l) => l.startsWith('error'))).toHaveLength(1);
    expect(quota.reserve(1)).toBe(true); // the tenth call is still allowed
  });

  it('starts again at midnight UTC', () => {
    const clock = { now: WED_NOON_UTC };
    const { quota } = make(2, clock);
    expect(quota.reserve(2)).toBe(true);
    expect(quota.reserve(1)).toBe(false);
    clock.now += 86_400_000;
    expect(quota.reserve(2)).toBe(true);
  });
});

// ---- the service with a fake Google ---------------------------------------------------------------

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const geocodeOk = () =>
  json({ status: 'OK', results: [{ formatted_address: 'Westlands, Nairobi, Kenya', geometry: { location: { lat: -1.2673, lng: 36.8112 } } }] });
const directionsOk = (secs: number) =>
  json({ status: 'OK', routes: [{ overview_polyline: { points: 'abc~' }, legs: [{ duration: { value: secs }, distance: { value: secs * 10 } }] }] });

interface Fake {
  urls: string[];
  fetch: FetchFn;
}

/** A fake Google: `respond` gets each URL and returns the response; the URL is recorded. */
function fakeGoogle(respond: (url: URL) => Response | Promise<Response>): Fake {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (input) => {
      urls.push(input);
      return respond(new URL(input));
    },
  };
}

const happy = (url: URL): Response => {
  if (url.pathname.endsWith('/geocode/json')) return geocodeOk();
  return directionsOk({ driving: 600, transit: 1500, walking: 3600 }[url.searchParams.get('mode') as 'driving'] ?? 1);
};

function setup(fake: Fake, extra: CommuteDeps = {}) {
  const logs: string[] = [];
  const clock = { now: WED_NOON_UTC };
  const service = createCommuteService({
    loadPin: async () => ({ lat: -1.3, lng: 36.8 }),
    fetch: fake.fetch,
    apiKey: () => 'test-key',
    dailyLimit: () => 1000,
    now: () => clock.now,
    log: { warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    ...extra,
  });
  return { service, logs, clock };
}

const query = (extra: Partial<CommuteQuery> = {}): CommuteQuery => ({
  buildingId: BUILDING,
  destination: 'Westlands, Nairobi',
  modes: ['driving', 'transit', 'walking'],
  time: { basis: 'now' },
  ...extra,
});

describe('commute service (FR-CMT-002, FR-CMT-005)', () => {
  it('returns duration, distance and polyline per mode, and a clean destination label', async () => {
    const fake = fakeGoogle(happy);
    const res = await setup(fake).service(query());
    expect(res).toEqual({
      available: true,
      destination: { label: 'Westlands, Nairobi, Kenya', lat: -1.2673, lng: 36.8112 },
      departure: { basis: 'now', at: null },
      modes: {
        driving: { available: true, durationSeconds: 600, distanceMeters: 6000, polyline: 'abc~', timeBasis: 'now' },
        transit: { available: true, durationSeconds: 1500, distanceMeters: 15000, polyline: 'abc~', timeBasis: 'now' },
        walking: { available: true, durationSeconds: 3600, distanceMeters: 36000, polyline: 'abc~', timeBasis: null },
      },
    });
    expect(fake.urls).toHaveLength(4); // one geocode, three routes
    expect(fake.urls[1]).toContain('origin=-1.3%2C36.8');
  });

  it('answers "unavailable" with no Google call when no key is configured', async () => {
    const fake = fakeGoogle(happy);
    const res = await setup(fake, { apiKey: () => undefined }).service(query());
    expect(res).toEqual({ available: false, notice: UNAVAILABLE_NOTICE });
    expect(fake.urls).toHaveLength(0);
  });

  it('still refuses a building that is not on display, key or no key', async () => {
    const gone = () => Promise.reject(new HttpError(410, 'gone', { code: 'BUILDING_UNAVAILABLE' }));
    await expect(setup(fakeGoogle(happy), { loadPin: gone, apiKey: () => undefined }).service(query())).rejects.toMatchObject({ status: 410 });
  });

  it('asks the user to refine a destination Google does not recognise, with no estimates and no route calls', async () => {
    const fake = fakeGoogle(() => json({ status: 'ZERO_RESULTS', results: [] }));
    const res = await setup(fake).service(query({ destination: 'qqqqzzzz' }));
    expect(res).toEqual({ available: false, destinationFound: false, notice: REFINE_NOTICE });
    expect(fake.urls).toHaveLength(1);
  });

  it('marks only the mode with no route as not available', async () => {
    const fake = fakeGoogle((url) => (url.searchParams.get('mode') === 'transit' ? json({ status: 'ZERO_RESULTS' }) : happy(url)));
    const res = await setup(fake).service(query());
    expect(res).toMatchObject({
      available: true,
      modes: { driving: { available: true }, transit: { available: false }, walking: { available: true } },
    });
  });

  it('keeps going when one mode errors, and does not cache the error', async () => {
    let flaky = true;
    const fake = fakeGoogle((url) => (url.searchParams.get('mode') === 'walking' && flaky ? json({ status: 'UNKNOWN_ERROR' }) : happy(url)));
    const { service } = setup(fake);
    const first = await service(query());
    expect(first).toMatchObject({ available: true, modes: { driving: { available: true }, walking: { available: false } } });
    flaky = false;
    const second = await service(query());
    expect(second).toMatchObject({ modes: { walking: { available: true } } });
    expect(fake.urls).toHaveLength(4 + 1); // only walking was asked again
  });

  it('fails soft, never throws, when Google errors, times out or is unreachable', async () => {
    for (const respond of [
      () => json({ status: 'REQUEST_DENIED' }),
      () => json({ status: 'OVER_QUERY_LIMIT' }),
      () => new Response('boom', { status: 500 }),
      () => {
        throw new TypeError('connect ECONNREFUSED https://maps.googleapis.com/?key=secret-key');
      },
    ]) {
      const { service, logs } = setup(fakeGoogle(respond));
      expect(await service(query())).toEqual({ available: false, notice: UNAVAILABLE_NOTICE });
      expect(logs.join('\n')).not.toContain('secret-key'); // an error message may carry the URL and so the key
    }
    const directionsFail = fakeGoogle((url) => (url.pathname.endsWith('/geocode/json') ? geocodeOk() : json({ status: 'REQUEST_DENIED' })));
    expect(await setup(directionsFail).service(query())).toEqual({ available: false, notice: UNAVAILABLE_NOTICE });
  });

  it('answers from the cache for the same building, place, mode and 10-minute time bucket', async () => {
    const fake = fakeGoogle(happy);
    const { service, clock } = setup(fake);
    await service(query());
    clock.now += 4 * 60_000;
    await service(query({ destination: 'westlands, nairobi' })); // case folded
    expect(fake.urls).toHaveLength(4);

    await service(query({ destination: 'Karen' })); // another place
    expect(fake.urls).toHaveLength(8);

    clock.now += 11 * 60_000; // past the TTL and into the next bucket
    await service(query());
    expect(fake.urls.length).toBeGreaterThan(8);
  });

  it('caches a place lookup across modes and times, so a new time costs only the routes', async () => {
    const fake = fakeGoogle(happy);
    const { service } = setup(fake);
    await service(query({ modes: ['walking'] }));
    await service(query({ modes: ['walking'], time: { basis: 'depart', atMs: Date.UTC(2026, 10, 30, 4, 30) } }));
    expect(fake.urls.filter((u) => u.includes('/geocode/'))).toHaveLength(1);
    expect(fake.urls.filter((u) => u.includes('/directions/'))).toHaveLength(2);
  });

  it('applies a chosen time per mode: transit can arrive by, driving departs, walking ignores time', async () => {
    const fake = fakeGoogle(happy);
    const atMs = Date.UTC(2026, 10, 30, 4, 30);
    const res = await setup(fake).service(query({ time: { basis: 'arrive', atMs } }));
    const route = (mode: string) => new URL(fake.urls.find((u) => u.includes(`mode=${mode}`))!).searchParams;
    expect(route('transit').get('arrival_time')).toBe(String(atMs / 1000));
    expect(route('driving').get('departure_time')).toBe(String(atMs / 1000));
    expect(route('driving').has('arrival_time')).toBe(false);
    expect(route('walking').has('departure_time') || route('walking').has('arrival_time')).toBe(false);
    expect(res).toMatchObject({
      departure: { basis: 'arrive', at: '2026-11-30T04:30:00.000Z' },
      modes: { transit: { timeBasis: 'arrive' }, driving: { timeBasis: 'depart' }, walking: { timeBasis: null } },
    });
    const now = await setup(fakeGoogle(happy)).service(query({ modes: ['driving'] }));
    expect(now).toMatchObject({ modes: { driving: { timeBasis: 'now' } } });
  });

  it('prefers the in-traffic duration for driving', async () => {
    const fake = fakeGoogle((url) =>
      url.pathname.endsWith('/geocode/json')
        ? geocodeOk()
        : json({ status: 'OK', routes: [{ overview_polyline: { points: 'p' }, legs: [{ duration: { value: 600 }, duration_in_traffic: { value: 900 }, distance: { value: 5000 } }] }] }),
    );
    const res = await setup(fake).service(query({ modes: ['driving'] }));
    expect(res).toMatchObject({ modes: { driving: { durationSeconds: 900 } } });
  });

  it('stops calling Google once the daily limit would be passed (fail-soft, FR-CMT-005)', async () => {
    const fake = fakeGoogle(happy);
    const { service, logs } = setup(fake, { dailyLimit: () => 5 });
    expect(await service(query())).toMatchObject({ available: true }); // 4 calls: 80% warning
    expect(logs.some((m) => m.includes('80%'))).toBe(true);
    expect(await service(query({ destination: 'Karen' }))).toEqual({ available: false, notice: UNAVAILABLE_NOTICE }); // would need 4 more
    expect(fake.urls).toHaveLength(4);
    expect(logs.filter((m) => m.includes('daily limit'))).toHaveLength(1);
    expect(await service(query())).toMatchObject({ available: true }); // cached: costs nothing
  });

  it('never logs the destination', async () => {
    const fake = fakeGoogle(() => json({ status: 'REQUEST_DENIED' }));
    const { service, logs } = setup(fake, { dailyLimit: () => 1 });
    await service(query({ destination: 'My Secret Workplace Ltd' }));
    await service(query({ destination: 'My Secret Workplace Ltd', modes: ['walking'] }));
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('\n')).not.toContain('Secret');
  });

  it('asks for only the requested mode', async () => {
    const fake = fakeGoogle(happy);
    const res = await setup(fake).service(query({ modes: ['walking'] }));
    expect(Object.keys((res as { modes: object }).modes)).toEqual(['walking']);
    expect(fake.urls).toHaveLength(2);
  });
});

describe('commute router', () => {
  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    res.status(typeof err?.status === 'number' ? err.status : 500).json({ code: err?.code });
  };

  it('wraps the answer in the envelope and validates the query', async () => {
    let seen: CommuteQuery | null = null;
    const app = express();
    app.use(
      createCommuteRouter({
        optionalAuth: (_req, _res, next) => next(),
        getCommute: (async (q: CommuteQuery) => {
          seen = q;
          return { available: false, notice: UNAVAILABLE_NOTICE };
        }) as never,
      }),
    );
    app.use(errorHandler);
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const res = await fetch(`${url}/commute?buildingId=${BUILDING}&destination=CBD&mode=walking`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'success', data: { available: false, notice: UNAVAILABLE_NOTICE }, message: 'Commute' });
    expect(seen).toMatchObject({ destination: 'CBD', modes: ['walking'] });
    expect((await fetch(`${url}/commute?buildingId=${BUILDING}`)).status).toBe(400);
    server.close();
  });
});
