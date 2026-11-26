import { describe, expect, it } from 'bun:test';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import type { Server } from 'node:http';
import { encodeCursor } from '../../lib/keyset.js';
import { createSearchRouter } from './routes.js';
import { encodeRentCursor, parseSearchQuery, type SearchFilters } from './schemas.js';
import { buildSearchCountQuery, buildSearchQuery, summariseRent } from './service.js';

const AREA = '019363c8-1234-7000-8000-0000000000a1';
const CURRENCY = '019363c8-1234-7000-8000-0000000000e1';
const BUILDING = '019363c8-1234-7000-8000-0000000000b1';

const refused = (query: Record<string, string>) => {
  try {
    parseSearchQuery(query);
  } catch (err) {
    return err as { status: number; code?: string };
  }
  return null;
};

describe('parseSearchQuery', () => {
  it('defaults to newest update first with 20 per page', () => {
    expect(parseSearchQuery({})).toMatchObject({ sort: 'updated', limit: 20, includeRentOnInterest: false, verifiedOnly: false, cursor: null });
  });

  it('reads every filter', () => {
    const f = parseSearchQuery({
      areaId: AREA, categoryId: AREA, currencyId: CURRENCY, rentMin: '7000', rentMax: '9500.50',
      includeRentOnInterest: 'true', management: 'agent', verifiedOnly: 'true', sort: 'rent_desc', limit: '5',
    });
    expect(f).toMatchObject({
      areaId: AREA, currencyId: CURRENCY, rentMin: 7000, rentMax: 9500.5, includeRentOnInterest: true,
      management: 'agent', verifiedOnly: true, sort: 'rent_desc', limit: 5,
    });
    expect(parseSearchQuery({ lat: '-1.28', lng: '36.8', radiusKm: '2.5' }).radius).toEqual({ lat: -1.28, lng: 36.8, radiusKm: 2.5 });
  });

  it('reads and trims the text query, and refuses a blank or over-long one', () => {
    expect(parseSearchQuery({}).q).toBeNull();
    expect(parseSearchQuery({ q: '  Ngong Hills ' }).q).toBe('Ngong Hills');
    expect(refused({ q: '   ' })?.status).toBe(400);
    expect(refused({ q: 'x'.repeat(101) })?.status).toBe(400);
  });

  it('refuses a rent sort without a currency (FR-SRC-006)', () => {
    expect(refused({ sort: 'rent_asc' })).toMatchObject({ status: 400, code: 'SORT_REQUIRES_CURRENCY' });
    expect(refused({ sort: 'rent_desc' })).toMatchObject({ status: 400, code: 'SORT_REQUIRES_CURRENCY' });
    expect(refused({ sort: 'rent_asc', currencyId: CURRENCY })).toBeNull();
  });

  it('refuses rent filters without a currency, area plus radius, and a partial radius', () => {
    expect(refused({ rentMin: '1' })?.code).toBe('CURRENCY_REQUIRED');
    expect(refused({ includeRentOnInterest: 'true' })?.code).toBe('CURRENCY_REQUIRED');
    expect(refused({ areaId: AREA, lat: '1', lng: '1', radiusKm: '1' })?.code).toBe('AREA_OR_RADIUS');
    expect(refused({ lat: '1', radiusKm: '1' })?.code).toBe('RADIUS_INCOMPLETE');
  });

  it('refuses unknown, repeated and malformed values', () => {
    const bad: Array<Record<string, string>> = [{ nope: '1' }, { areaId: 'x' }, { limit: '0' }, { limit: '51' }, { rentMin: 'abc' }, { currencyId: CURRENCY, rentMin: '5', rentMax: '1' }, { radiusKm: '51', lat: '1', lng: '1' }, { verifiedOnly: 'yes' }, { management: 'x' }, { sort: 'x' }, { cursor: '!!' }];
    for (const query of bad) {
      expect(refused(query)?.status).toBe(400);
    }
    expect(() => parseSearchQuery({ areaId: [AREA, AREA] } as never)).toThrow();
  });

  it('reads the cursor for the sort in use and refuses the other one', () => {
    const updated = encodeCursor({ t: '2026-11-20 10:00:00.123456+00', id: BUILDING });
    expect(parseSearchQuery({ cursor: updated }).cursor).toEqual({ kind: 'updated', t: '2026-11-20 10:00:00.123456+00', id: BUILDING });
    const rent = encodeRentCursor({ r: '7000.00', id: BUILDING });
    expect(parseSearchQuery({ currencyId: CURRENCY, sort: 'rent_asc', cursor: rent }).cursor).toEqual({ kind: 'rent', r: '7000.00', id: BUILDING });
    expect(parseSearchQuery({ currencyId: CURRENCY, sort: 'rent_asc', cursor: encodeRentCursor({ r: null, id: BUILDING }) }).cursor).toMatchObject({ r: null });
    expect(refused({ currencyId: CURRENCY, sort: 'rent_asc', cursor: updated })?.status).toBe(400);
    expect(refused({ cursor: rent })?.status).toBe(400);
  });
});

describe('buildSearchQuery (QP-01)', () => {
  const filters = (extra: Partial<SearchFilters> = {}): SearchFilters => ({ ...parseSearchQuery({}), ...extra });

  it('is a lateral join keyed on Vacant, non-removed space types, with no OFFSET', () => {
    const { sql, bindings } = buildSearchQuery(filters({ areaId: AREA }));
    expect(sql).toContain('CROSS JOIN LATERAL');
    expect(sql).toContain('s.vacant_count > 0 AND s.removed_at IS NULL');
    expect(sql).toContain('u.latest IS NOT NULL');
    expect(sql).toContain('ORDER BY u.latest DESC, b.id DESC');
    expect(sql).not.toMatch(/offset/i);
    expect(bindings).toEqual([AREA, 21]);
  });

  it('binds in the order the placeholders appear, whatever filters are on', () => {
    const { sql, bindings } = buildSearchQuery(
      filters({ areaId: AREA, categoryId: 'cat', currencyId: 'cur', rentMin: 1, rentMax: 2, includeRentOnInterest: true, management: 'agent', limit: 7, cursor: { kind: 'updated', t: 'T', id: 'I' } }),
    );
    expect(sql.match(/\?/g)!.length).toBe(bindings.length);
    expect(bindings).toEqual(['cat', 'cur', 1, 2, AREA, 'agent', 'T', 'I', 8]);
    expect(sql).toContain(`s.rent_mode = 'on_interest'`);
  });

  it('matches the text on building or area name, escaped, between the other filters and the cursor', () => {
    const { sql, bindings } = buildSearchQuery(filters({ areaId: AREA, q: '50%_off', cursor: { kind: 'updated', t: 'T', id: 'I' } }));
    expect(sql).toContain(`b.name ILIKE ? ESCAPE '\\' OR a.name ILIKE ? ESCAPE '\\'`);
    expect(sql.match(/\?/g)!.length).toBe(bindings.length);
    expect(bindings).toEqual([AREA, '%50\\%\\_off%', '%50\\%\\_off%', 'T', 'I', 21]);
  });

  it('counts an on-interest type only when included, and always repeats the literal fixed mode', () => {
    const base = { currencyId: CURRENCY, rentMin: 1, rentMax: 2 };
    expect(buildSearchQuery(filters(base)).sql).not.toContain('on_interest');
    expect(buildSearchQuery(filters({ ...base, includeRentOnInterest: true })).sql).toContain('on_interest');
    expect(buildSearchQuery(filters(base)).sql).toContain(`s.rent_mode = 'fixed' AND s.rent_amount >= ?`);
  });

  it('uses a bounding box and then the exact haversine for a radius', () => {
    const { sql, bindings } = buildSearchQuery(filters({ radius: { lat: -1.3, lng: 36.8, radiusKm: 2 } }));
    expect(sql).toContain('b.latitude BETWEEN');
    expect(sql).toContain('asin(sqrt(');
    expect(sql.match(/\?/g)!.length).toBe(bindings.length);
    const [latLow, latHigh] = bindings as number[];
    expect(latHigh! - latLow!).toBeCloseTo((2 * 2) / 111.32, 5);
  });

  it('orders by lowest rent with the id as tie-break and Rent on interest last', () => {
    const asc = buildSearchQuery(filters({ currencyId: CURRENCY, sort: 'rent_asc' })).sql;
    const desc = buildSearchQuery(filters({ currencyId: CURRENCY, sort: 'rent_desc' })).sql;
    expect(asc).toContain('ORDER BY u.min_rent ASC NULLS LAST, b.id DESC');
    expect(desc).toContain('ORDER BY u.min_rent DESC NULLS LAST, b.id DESC');
  });

  it('builds a count query with all filter bindings and no cursor, order or limit', () => {
    const { sql, bindings } = buildSearchCountQuery(
      filters({ areaId: AREA, categoryId: 'cat', limit: 7, cursor: { kind: 'updated', t: 'T', id: 'I' } }),
    );
    expect(sql).toContain('SELECT count(*)::int AS total');
    expect(sql).not.toMatch(/order by|limit/i);
    expect(sql.match(/\?/g)!.length).toBe(bindings.length);
    expect(bindings).toEqual(['cat', AREA]);
  });
});

describe('summariseRent (FR-SRC-005, OQ-53)', () => {
  const group = (code: string, min: string | null, max: string | null) => ({ currency_id: code, currency_code: code, min_rent: min, max_rent: max });

  it('gives one range per currency', () => {
    expect(summariseRent([group('USD', '50.00', '50.00'), group('KES', '7000.00', '9500.00')])).toEqual({
      ranges: [
        { currencyId: 'KES', currencyCode: 'KES', min: 7000, max: 9500 },
        { currencyId: 'USD', currencyCode: 'USD', min: 50, max: 50 },
      ],
      rentOnInterest: false,
    });
  });

  it('says "Rent on interest" when no Vacant space type shows a rent, and ignores an on-interest-only currency otherwise', () => {
    expect(summariseRent([group('KES', null, null)])).toEqual({ ranges: [], rentOnInterest: true });
    expect(summariseRent([group('KES', '1.00', '2.00'), group('USD', null, null)]).ranges).toHaveLength(1);
  });
});

describe('search router', () => {
  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    res.status(typeof err?.status === 'number' ? err.status : 500).json({ code: err?.code });
  };

  async function start(searchBuildings: (filters: SearchFilters) => Promise<unknown>, optionalAuth?: RequestHandler) {
    const app = express();
    app.use(createSearchRouter({ optionalAuth: optionalAuth ?? ((_req, _res, next) => next()), searchBuildings: searchBuildings as never }));
    app.use(errorHandler);
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
  }

  it('passes parsed filters to the service and wraps the page in the envelope', async () => {
    let seen: SearchFilters | null = null;
    const { server, url } = await start(async (filters) => {
      seen = filters;
      return { items: [], nextCursor: null };
    });
    const res = await fetch(`${url}/search/buildings?areaId=${AREA}&limit=3`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'success', data: { items: [], nextCursor: null }, message: 'Search results' });
    expect(seen).toMatchObject({ areaId: AREA, limit: 3 });
    expect((await fetch(`${url}/search/buildings?sort=rent_asc`)).status).toBe(400);
    server.close();
  });
});
