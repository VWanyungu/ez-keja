import { afterEach, describe, expect, it } from 'bun:test';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import type { Server } from 'node:http';
import { forbidden, HttpError } from '../../lib/http-error.js';
import type { AuthContext } from '../../middlewares/auth.js';
import { createAuditRouter } from '../audit/routes.js';
import { parseAuditQuery } from '../audit/schemas.js';
import { createMetricsRouter, type MetricsRouterDeps } from './routes.js';
import { METRIC_CODES, parseExportQuery, parseMetricFilters } from './schemas.js';
import { percent } from './service.js';
import { isoWeekStart } from './snapshots.js';

const ID = '019363c8-1234-7000-8000-000000000001';
const ADMIN = '019363c8-1234-7000-8000-0000000000aa';

describe('metric filters (FR-RPT-001)', () => {
  it('reads area, category, management type, lister and date range', () => {
    const f = parseMetricFilters({ areaId: ID, categoryId: ID, managementType: 'agent', listerId: ID, from: '2026-11-01', to: '2026-11-30' });
    expect(f).toMatchObject({ areaId: ID, categoryId: ID, managementType: 'agent', listerId: ID });
    expect(f.toExclusive?.toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });
  it('defaults to no filters', () => {
    expect(parseMetricFilters({})).toEqual({ areaId: null, categoryId: null, managementType: null, listerId: null, from: null, toExclusive: null });
  });
  it('rejects bad ids, management types and ranges', () => {
    for (const bad of [{ areaId: 'x' }, { listerId: 5 }, { managementType: 'owner' }, { from: 'soon' }]) {
      expect(() => parseMetricFilters(bad as Record<string, unknown>)).toThrow(HttpError);
    }
  });
});

describe('metric codes', () => {
  it('cover RPT-M01 to M10 only: M11 is withdrawn and M12/M13 (ads) are on hold', () => {
    expect([...METRIC_CODES]).toEqual(['RPT-M01', 'RPT-M02', 'RPT-M03', 'RPT-M04', 'RPT-M05', 'RPT-M06', 'RPT-M07', 'RPT-M08', 'RPT-M09', 'RPT-M10']);
  });
  it('parses an export request, accepting "m06" and "RPT-M06"', () => {
    expect(parseExportQuery({ metric: 'RPT-M06' }).metric).toBe('RPT-M06');
    expect(parseExportQuery({ metric: 'm06' }).metric).toBe('RPT-M06');
    for (const bad of [{}, { metric: 'RPT-M11' }, { metric: 'RPT-M12' }, { metric: 'x' }]) {
      expect(() => parseExportQuery(bad)).toThrow(HttpError);
    }
  });
});

describe('percent', () => {
  it('is rounded to two decimals and null when there is nothing to divide by', () => {
    expect(percent(60, 100)).toBe(60);
    expect(percent(1, 3)).toBe(33.33);
    expect(percent(0, 0)).toBeNull();
    expect(percent(0, 5)).toBe(0);
  });
});

describe('isoWeekStart (weekly snapshot date)', () => {
  it('is the Monday of the UTC week', () => {
    expect(isoWeekStart(new Date('2026-11-26T09:00:00Z'))).toBe('2026-11-23'); // a Thursday
    expect(isoWeekStart(new Date('2026-11-23T00:00:00Z'))).toBe('2026-11-23'); // the Monday itself
    expect(isoWeekStart(new Date('2026-11-29T23:59:59Z'))).toBe('2026-11-23'); // Sunday night
    expect(isoWeekStart(new Date('2026-11-30T00:00:00Z'))).toBe('2026-11-30');
  });
});

describe('parseAuditQuery (FR-ADM-007)', () => {
  it('reads userId, buildingId, action, dates, format and paging', () => {
    const q = parseAuditQuery({ userId: ID, buildingId: ID, action: 'user.suspend', from: '2026-11-01', to: '2026-11-02', format: 'csv', limit: '10' });
    expect(q).toMatchObject({ format: 'csv', limit: 10, filters: { userId: ID, buildingId: ID, action: 'user.suspend' } });
    expect(q.filters.toExclusive?.toISOString()).toBe('2026-11-03T00:00:00.000Z');
  });
  it('defaults to JSON, 50 a page, no filters', () => {
    expect(parseAuditQuery({})).toMatchObject({ format: 'json', limit: 50, cursor: null, filters: { userId: null, buildingId: null, action: null } });
  });
  it('rejects bad input', () => {
    for (const bad of [{ userId: 'x' }, { buildingId: 'x' }, { action: 'DROP TABLE;' }, { format: 'xml' }, { limit: '500' }, { from: 'x' }]) {
      expect(() => parseAuditQuery(bad)).toThrow(HttpError);
    }
  });
});

// ---- router wiring with fake services ---------------------------------------------------------

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const status = typeof err?.status === 'number' ? err.status : 500;
  res.status(status).json({ status: 'fail', data: null, message: err.expose ? err.message : 'Internal server error', code: err.code });
};
const asRole = (...roles: string[]): RequestHandler => (req, _res, next) => {
  req.auth = { user: { id: ADMIN }, roles } as unknown as AuthContext;
  next();
};
const adminOnly: RequestHandler = (req, _res, next) =>
  next(req.auth?.roles.includes('admin') ? undefined : forbidden('Insufficient permissions', { code: 'FORBIDDEN_ROLE' }));

let active: Server | null = null;
afterEach(async () => {
  if (active) await new Promise<void>((resolve) => active!.close(() => resolve()));
  active = null;
});

async function serve(router: express.Router): Promise<string> {
  const app = express();
  app.use(router);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    active = app.listen(0, '127.0.0.1', () => resolve());
  });
  return `http://127.0.0.1:${(active!.address() as { port: number }).port}`;
}

describe('metrics and audit routers', () => {
  it('keep every route behind the Admin role', async () => {
    const base = await serve(createMetricsRouter({ requireAuth: asRole('landlord'), requireAdmin: adminOnly }));
    expect((await fetch(`${base}/admin/metrics`)).status).toBe(403);
    expect((await fetch(`${base}/admin/metrics/export?metric=RPT-M01`)).status).toBe(403);
    await new Promise<void>((resolve) => active!.close(() => resolve()));
    const audit = await serve(createAuditRouter({ requireAuth: asRole('landlord'), requireAdmin: adminOnly }));
    expect((await fetch(`${audit}/admin/audit`)).status).toBe(403);
  });

  it('serves the metrics inside the envelope and the export as text/csv with a download name', async () => {
    const deps: MetricsRouterDeps = {
      requireAuth: asRole('admin'),
      requireAdmin: adminOnly,
      getMetrics: async () => ({ generatedAt: 'now' }) as never,
      exportMetric: async (_auth, code) => ({ csv: 'a,b\r\n', rowCount: 0, filename: `${code.toLowerCase()}.csv` }),
    };
    const base = await serve(createMetricsRouter(deps));
    expect(await (await fetch(`${base}/admin/metrics`)).json()).toMatchObject({ status: 'success', data: { generatedAt: 'now' } });
    const csv = await fetch(`${base}/admin/metrics/export?metric=RPT-M02`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(csv.headers.get('content-disposition')).toContain('rpt-m02.csv');
    expect(await csv.text()).toBe('a,b\r\n');
    expect((await fetch(`${base}/admin/metrics/export?metric=RPT-M12`)).status).toBe(400);
  });

  it('serves the audit search as JSON, and as CSV with format=csv', async () => {
    const base = await serve(
      createAuditRouter({
        requireAuth: asRole('admin'),
        requireAdmin: adminOnly,
        search: async () => ({ items: [], nextCursor: null }),
        exportCsv: async () => ({ csv: 'occurred_at\r\n', rowCount: 0, truncated: true }),
      }),
    );
    expect(await (await fetch(`${base}/admin/audit`)).json()).toMatchObject({ status: 'success', data: { items: [], nextCursor: null } });
    const csv = await fetch(`${base}/admin/audit?format=csv`);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(csv.headers.get('x-export-truncated')).toBe('true');
  });
});
