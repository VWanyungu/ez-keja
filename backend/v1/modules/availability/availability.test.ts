import { afterEach, describe, expect, it } from 'bun:test';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import type { Server } from 'node:http';
import { HttpError } from '../../lib/http-error.js';
import type { AuthContext } from '../../middlewares/auth.js';
import { createFollowUpsRouter, type FollowUpsRouterDeps } from '../follow-ups/routes.js';
import { parseRecordFollowUpBody } from '../follow-ups/schemas.js';
import { createAvailabilityRouter, type AvailabilityRouterDeps } from './routes.js';
import { parseBulkConfirmBody, parseConfirmBody, parseSetCountBody } from './schemas.js';

const SPACE_TYPE_ID = '019363c8-1234-7000-8000-0000000000c1';
const OTHER_ID = '019363c8-1234-7000-8000-0000000000c2';

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const status = typeof err?.status === 'number' ? err.status : 500;
  res.status(status).json({
    status: 'error',
    data: null,
    message: err?.expose ? err.message : 'Internal server error',
    ...(err?.expose && err?.code ? { code: err.code } : {}),
  });
};

let activeServer: Server | null = null;

afterEach(async () => {
  if (activeServer) {
    await new Promise<void>((resolve, reject) => {
      activeServer!.close((err) => (err ? reject(err) : resolve()));
    });
    activeServer = null;
  }
});

async function start(mount: (app: express.Express, requireAuth: RequestHandler) => void): Promise<string> {
  const requireAuth: RequestHandler = (req, _res, next) => {
    req.auth = { user: { id: 'u' }, roles: [] } as unknown as AuthContext;
    next();
  };
  const app = express();
  app.use(express.json());
  mount(app, requireAuth);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    activeServer = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = activeServer!.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return `http://127.0.0.1:${addr.port}`;
}

const startAvailability = (deps: AvailabilityRouterDeps) =>
  start((app, requireAuth) => app.use(createAvailabilityRouter({ requireAuth, ...deps })));

const startFollowUps = (deps: FollowUpsRouterDeps) =>
  start((app, requireAuth) => app.use(createFollowUpsRouter({ requireAuth, ...deps })));

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const rejects = (fn: () => unknown) => expect(fn).toThrow(HttpError);

const change = { id: SPACE_TYPE_ID, vacantCount: 2 } as never;

describe('count bodies (FR-AVL-001, FR-AVL-003, BR-028)', () => {
  it('accepts whole numbers of zero or more', () => {
    expect(parseSetCountBody({ vacantCount: 0 })).toEqual({ vacantCount: 0 });
    expect(parseSetCountBody({ vacantCount: 12 })).toEqual({ vacantCount: 12 });
    expect(parseConfirmBody(undefined)).toEqual({});
    expect(parseConfirmBody({})).toEqual({});
    expect(parseConfirmBody({ vacantCount: 4 })).toEqual({ vacantCount: 4 });
  });

  it('refuses negatives, decimals, strings, a missing count and unknown fields', () => {
    for (const bad of [-1, 1.5, '3', null, undefined, 1_000_001]) rejects(() => parseSetCountBody({ vacantCount: bad }));
    rejects(() => parseSetCountBody({}));
    rejects(() => parseSetCountBody([]));
    rejects(() => parseSetCountBody({ vacantCount: 1, version: 1 }));
    rejects(() => parseConfirmBody({ vacantCount: -1 }));
    rejects(() => parseConfirmBody({ vacantCount: 1, note: 'x' }));
  });
});

describe('bulk confirm body (FR-AVL-004, TX-02)', () => {
  const item = { spaceTypeId: SPACE_TYPE_ID, lastConfirmedAt: '2026-11-25T16:58:01.123456Z', vacantCount: 3 };

  it('keeps the timestamp as the text it was given', () => {
    expect(parseBulkConfirmBody({ items: [item] }).items).toEqual([item]);
    expect(parseBulkConfirmBody({ items: [{ ...item, lastConfirmedAt: '2026-11-25 16:58:01.123456+00' }] }).items).toHaveLength(1);
  });

  it('refuses empty or oversized lists, duplicates, Fully let counts and malformed items', () => {
    rejects(() => parseBulkConfirmBody({ items: [] }));
    rejects(() => parseBulkConfirmBody({}));
    rejects(() => parseBulkConfirmBody({ items: Array.from({ length: 201 }, () => item) }));
    rejects(() => parseBulkConfirmBody({ items: [item, item] }));
    rejects(() => parseBulkConfirmBody({ items: [{ ...item, vacantCount: 0 }] }));
    rejects(() => parseBulkConfirmBody({ items: [{ ...item, vacantCount: 1.5 }] }));
    rejects(() => parseBulkConfirmBody({ items: [{ ...item, lastConfirmedAt: 'yesterday' }] }));
    rejects(() => parseBulkConfirmBody({ items: [{ ...item, lastConfirmedAt: 1_700_000_000_000 }] }));
    rejects(() => parseBulkConfirmBody({ items: [{ ...item, spaceTypeId: 'nope' }] }));
    rejects(() => parseBulkConfirmBody({ items: [{ ...item, extra: 1 }] }));
  });
});

describe('follow-up body (FR-ADM-002)', () => {
  it('needs a count of 1 or more only for "confirmed"', () => {
    expect(parseRecordFollowUpBody({ outcome: 'confirmed', vacantCount: 2, note: ' called ' })).toEqual({
      outcome: 'confirmed',
      vacantCount: 2,
      note: 'called',
    });
    expect(parseRecordFollowUpBody({ outcome: 'fully_let' })).toEqual({ outcome: 'fully_let', vacantCount: null, note: null });
    expect(parseRecordFollowUpBody({ outcome: 'unreachable', note: '' })).toEqual({
      outcome: 'unreachable',
      vacantCount: null,
      note: null,
    });
    rejects(() => parseRecordFollowUpBody({ outcome: 'confirmed' }));
    rejects(() => parseRecordFollowUpBody({ outcome: 'confirmed', vacantCount: 0 }));
    rejects(() => parseRecordFollowUpBody({ outcome: 'fully_let', vacantCount: 1 }));
    rejects(() => parseRecordFollowUpBody({ outcome: 'now_fully_let' }));
    rejects(() => parseRecordFollowUpBody({ outcome: 'unreachable', note: 'x'.repeat(1001) }));
    rejects(() => parseRecordFollowUpBody({}));
  });
});

describe('availability router', () => {
  it('routes set, confirm, fully-let and bulk confirm to the service with the parsed input', async () => {
    const calls: unknown[][] = [];
    const base = await startAvailability({
      setVacantCount: async (_a, id, n) => (calls.push(['set', id, n]), change),
      confirmVacantCount: async (_a, id, n) => (calls.push(['confirm', id, n]), change),
      markFullyLet: async (_a, id) => (calls.push(['fully-let', id]), change),
      bulkConfirm: async (_a, items) => (calls.push(['bulk', items.length]), { confirmed: [], skipped: [] }),
    });

    expect((await fetch(`${base}/space-types/${SPACE_TYPE_ID}/vacant-count`, json('PUT', { vacantCount: 4 }))).status).toBe(200);
    expect((await fetch(`${base}/space-types/${SPACE_TYPE_ID}/confirm`, { method: 'POST' })).status).toBe(200);
    expect((await fetch(`${base}/space-types/${OTHER_ID}/confirm`, json('POST', { vacantCount: 1 }))).status).toBe(200);
    expect((await fetch(`${base}/space-types/${SPACE_TYPE_ID}/fully-let`, { method: 'POST' })).status).toBe(200);
    const item = { spaceTypeId: SPACE_TYPE_ID, lastConfirmedAt: '2026-11-25T16:58:01.123456Z', vacantCount: 1 };
    expect((await fetch(`${base}/availability/bulk-confirm`, json('POST', { items: [item] }))).status).toBe(200);

    expect(calls).toEqual([
      ['set', SPACE_TYPE_ID, 4],
      ['confirm', SPACE_TYPE_ID, undefined],
      ['confirm', OTHER_ID, 1],
      ['fully-let', SPACE_TYPE_ID],
      ['bulk', 1],
    ]);
  });

  it('answers 400 before touching the service for bad ids, bodies and query', async () => {
    let touched = 0;
    const touch = async () => {
      touched += 1;
      return change;
    };
    const base = await startAvailability({
      setVacantCount: touch,
      confirmVacantCount: touch,
      listAvailabilityEvents: async () => {
        touched += 1;
        return { items: [], nextCursor: null };
      },
    });
    expect((await fetch(`${base}/space-types/nope/vacant-count`, json('PUT', { vacantCount: 1 }))).status).toBe(400);
    expect((await fetch(`${base}/space-types/${SPACE_TYPE_ID}/vacant-count`, json('PUT', { vacantCount: -1 }))).status).toBe(400);
    expect((await fetch(`${base}/space-types/${SPACE_TYPE_ID}/confirm`, json('POST', { vacantCount: 'many' }))).status).toBe(400);
    expect((await fetch(`${base}/space-types/${SPACE_TYPE_ID}/availability-events?cursor=bad`)).status).toBe(400);
    expect((await fetch(`${base}/space-types/${SPACE_TYPE_ID}/availability-events?limit=500`)).status).toBe(400);
    expect(touched).toBe(0);
  });

  it('passes the keyset query to the history service and wraps the page in the envelope', async () => {
    let seen: unknown;
    const base = await startAvailability({
      listAvailabilityEvents: async (_a, id, query) => {
        seen = [id, query];
        return { items: [], nextCursor: null };
      },
    });
    const res = await fetch(`${base}/space-types/${SPACE_TYPE_ID}/availability-events?limit=5`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'success', data: { items: [], nextCursor: null }, message: 'Availability history' });
    expect(seen).toEqual([SPACE_TYPE_ID, { limit: 5, cursor: null }]);
  });

  it('lets a service refusal reach the client unchanged', async () => {
    const base = await startAvailability({
      setVacantCount: async () => {
        throw new HttpError(403, 'You do not maintain this building.', { code: 'NOT_A_MAINTAINER' });
      },
    });
    const res = await fetch(`${base}/space-types/${SPACE_TYPE_ID}/vacant-count`, json('PUT', { vacantCount: 1 }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('NOT_A_MAINTAINER');
  });
});

describe('follow-ups router', () => {
  it('gates both routes behind the admin check', async () => {
    let served = 0;
    const requireAdmin: RequestHandler = (_req, res) => {
      res.status(403).json({ status: 'fail', data: null, message: 'Forbidden' });
    };
    const base = await startFollowUps({
      requireAdmin,
      listFollowUpQueue: async () => (served++, []),
      recordFollowUp: async () => (served++, {} as never),
    });
    expect((await fetch(`${base}/admin/follow-ups`)).status).toBe(403);
    expect((await fetch(`${base}/admin/space-types/${SPACE_TYPE_ID}/follow-ups`, json('POST', { outcome: 'unreachable' }))).status).toBe(403);
    expect(served).toBe(0);
  });

  it('lists the queue and records an outcome with the parsed body', async () => {
    let recorded: unknown;
    const requireAdmin: RequestHandler = (_req, _res, next) => next();
    const base = await startFollowUps({
      requireAdmin,
      listFollowUpQueue: async () => [],
      recordFollowUp: async (_a, id, input) => {
        recorded = [id, input];
        return { id: 'f', spaceTypeId: id, outcome: input.outcome, note: input.note, change: null };
      },
    });
    expect((await fetch(`${base}/admin/follow-ups`)).status).toBe(200);
    const res = await fetch(`${base}/admin/space-types/${SPACE_TYPE_ID}/follow-ups`, json('POST', { outcome: 'confirmed', vacantCount: 3, note: 'ok' }));
    expect(res.status).toBe(201);
    expect(recorded).toEqual([SPACE_TYPE_ID, { outcome: 'confirmed', vacantCount: 3, note: 'ok' }]);
    expect((await fetch(`${base}/admin/space-types/${SPACE_TYPE_ID}/follow-ups`, json('POST', { outcome: 'confirmed' }))).status).toBe(400);
  });
});
