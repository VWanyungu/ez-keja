import { describe, expect, it } from 'bun:test';
import express, { type ErrorRequestHandler, type RequestHandler, type Router } from 'express';
import type { Server } from 'node:http';
import { HttpError } from '../../lib/http-error.js';
import { decodeCursor, keysetPage, keysetWhere } from '../../lib/keyset.js';
import { DailyQuota } from '../commute/maps.js';
import { createEnquiriesRouter } from '../enquiries/routes.js';
import { parseListEnquiriesQuery, parseMessageBody } from '../enquiries/schemas.js';
import { createReportsRouter } from '../reports/routes.js';
import { parseCreateReportBody, parseListReportsQuery, parseResolveReportBody } from '../reports/schemas.js';
import { createViewingsRouter } from '../viewings/routes.js';
import { parseCounterBody, parseFutureTime, parseListViewingsQuery, parseRequestViewingBody } from '../viewings/schemas.js';
import { hasDeliverableEmail, safeErrorReason } from './deliver.js';
import { createNotificationsRouter } from './routes.js';
import { parseListNotificationsQuery } from './schemas.js';
import { formatEat, renderEmail, renderNotification } from './templates.js';

const UUID = '019363c8-1234-7000-8000-000000000001';
const NOW = Date.UTC(2026, 10, 26, 9, 0, 0);

describe('notification text (FR-LOC-001)', () => {
  const codes = Array.from({ length: 14 }, (_, i) => `N-${String(i + 1).padStart(2, '0')}`);
  const payloads: unknown[] = [
    {},
    { buildingName: 'Acacia Court', spaceTypeName: 'Shop A', reason: 'fully_let', kind: 'accepted', decision: 'approved', threshold: 80, used: 8, limit: 10 },
    { count: 'many', spaceTypes: 'nope', decision: 5, proposedFor: 'not a date' },
    null,
    'text',
    [1, 2],
  ];

  it('never shows a raw key, "undefined" or "null", in either language, whatever the payload', () => {
    for (const code of codes) {
      for (const language of ['en', 'sw', 'fr', null, undefined]) {
        for (const payload of payloads) {
          const { title, body } = renderNotification(code, payload, language);
          expect(title.length).toBeGreaterThan(0);
          expect(body.length).toBeGreaterThan(0);
          expect(`${title} ${body}`).not.toMatch(/N-\d\d|undefined|null|\[object/);
        }
      }
    }
  });

  it('writes the engagement events in English and in Kiswahili', () => {
    const p = { buildingName: 'Acacia Court', spaceTypeName: 'Shop A' };
    expect(renderNotification('N-05', p, 'en').title).toBe('New message about Shop A at Acacia Court');
    expect(renderNotification('N-05', p, 'sw').title).toBe('Ujumbe mpya kuhusu Shop A katika Acacia Court');
    expect(renderNotification('N-06', p, 'en').title).toBe('New reply about Shop A at Acacia Court');
    expect(renderNotification('N-08', { ...p, reason: 'space_type_removed' }, 'en').title).toBe('Shop A at Acacia Court is no longer listed');
    expect(renderNotification('N-08', { ...p, reason: 'fully_let' }, 'sw').title).toBe('Shop A katika Acacia Court imejaa');
    expect(renderNotification('N-09', { ...p, reason: 'suspicious' }, 'en').body).toBe('Shop A at Acacia Court was reported as suspicious.');
    expect(renderNotification('N-11', { threshold: 100, used: 10, limit: 10 }, 'en').title).toBe('Daily Maps limit reached');
    for (const code of ['N-05', 'N-06', 'N-07', 'N-08', 'N-09', 'N-11', 'N-13']) {
      const payload = { ...p, kind: 'accepted', reason: 'unavailable' };
      expect(renderNotification(code, payload, 'sw').title).not.toBe(renderNotification(code, payload, 'en').title);
    }
  });

  it('keeps the comment out of N-09 and shows viewing times in Nairobi time', () => {
    const text = JSON.stringify(renderNotification('N-09', { buildingName: 'B', reason: 'unavailable', comment: 'secret words' }, 'en'));
    expect(text).not.toContain('secret');
    expect(formatEat('2026-12-01T07:00:00.000Z')).toBe('2026-12-01 10:00 (EAT)');
    expect(formatEat('garbage')).toBeNull();
    expect(renderNotification('N-07', { kind: 'counter_proposed', proposedFor: '2026-12-01T07:00:00.000Z', spaceTypeName: 'S', buildingName: 'B' }, 'en').title).toBe(
      'A different viewing time was proposed for S at B: 2026-12-01 10:00 (EAT)',
    );
  });

  it('escapes user-supplied text in the HTML email only', () => {
    const mail = renderEmail({ title: 'Hi <script>', body: 'a & b\n- "quoted"' });
    expect(mail.subject).toBe('Hi <script>');
    expect(mail.text).toBe('a & b\n- "quoted"');
    expect(mail.html).toBe('<p><strong>Hi &lt;script&gt;</strong></p><p>a &amp; b</p><p>- &quot;quoted&quot;</p>');
  });
});

describe('delivery helpers (FR-NTF-001)', () => {
  it('stores only a short code as the error, never a message or an address', () => {
    expect(safeErrorReason(Object.assign(new Error('550 user@example.com rejected'), { code: 'EENVELOPE' }))).toBe('send_failed:EENVELOPE');
    expect(safeErrorReason(Object.assign(new Error('x'), { responseCode: 550 }))).toBe('send_failed:550');
    expect(safeErrorReason(new Error('Sendy email delivery failed (500): user@example.com'))).toBe('send_failed');
    expect(safeErrorReason(Object.assign(new Error('x'), { code: 'bad code with spaces and user@example.com' }))).toBe('send_failed');
    expect(safeErrorReason('plain string')).toBe('send_failed');
    expect(safeErrorReason(null)).toBe('send_failed');
  });

  it('refuses the placeholder address of an erased account and anything malformed', () => {
    expect(hasDeliverableEmail('person@example.com', null)).toBe(true);
    expect(hasDeliverableEmail('erased+019363c8@invalid', null)).toBe(false);
    expect(hasDeliverableEmail('person@example.com', new Date())).toBe(false);
    expect(hasDeliverableEmail('not an address', null)).toBe(false);
    expect(hasDeliverableEmail(null, null)).toBe(false);
  });
});

describe('request parsing', () => {
  it('enquiry messages are 1 to 4000 characters and nothing else is allowed', () => {
    expect(parseMessageBody({ body: '  hello ' })).toEqual({ body: 'hello' });
    for (const bad of [null, [], {}, { body: '' }, { body: '   ' }, { body: 'x'.repeat(4001) }, { body: 1 }, { body: 'hi', extra: true }]) {
      expect(() => parseMessageBody(bad)).toThrow(HttpError);
    }
    expect(parseMessageBody({ body: 'x'.repeat(4000) }).body).toHaveLength(4000);
  });

  it('viewing times must be zoned, in the future and within a year', () => {
    const now = () => NOW;
    expect(parseFutureTime('2026-12-01T10:00:00+03:00', 't', now)).toBe('2026-12-01T07:00:00.000Z');
    expect(parseFutureTime('2026-12-01T10:00Z', 't', now)).toBe('2026-12-01T10:00:00.000Z');
    for (const bad of ['2026-12-01 10:00', '2026-12-01T10:00:00', '2026-11-26T08:59:59Z', '2026-11-26T09:00:00Z', 'tomorrow', 5, null, '2028-01-01T10:00:00Z', '2026-13-45T10:00:00Z']) {
      expect(() => parseFutureTime(bad, 't', now)).toThrow(HttpError);
    }
    expect(() => parseRequestViewingBody({ requestedFor: '2026-12-01T10:00:00Z', other: 1 }, now)).toThrow(HttpError);
    expect(parseCounterBody({ proposedFor: '2026-12-01T10:00:00Z' }, now)).toEqual({ proposedFor: '2026-12-01T10:00:00.000Z' });
  });

  it('report bodies and queries', () => {
    expect(parseCreateReportBody({ reason: 'unavailable' })).toEqual({ reason: 'unavailable', comment: null });
    expect(parseCreateReportBody({ reason: 'suspicious', comment: '  odd  ' })).toEqual({ reason: 'suspicious', comment: 'odd' });
    for (const bad of [{}, { reason: 'rude' }, { reason: 'inaccurate', comment: 'x'.repeat(2001) }, { reason: 'inaccurate', comment: 5 }, { reason: 'inaccurate', x: 1 }]) {
      expect(() => parseCreateReportBody(bad)).toThrow(HttpError);
    }
    expect(parseResolveReportBody({ resolution: 'dismissed' })).toEqual({ resolution: 'dismissed', note: null });
    expect(() => parseResolveReportBody({ resolution: 'open' })).toThrow(HttpError);
    expect(parseListReportsQuery({}).status).toBe('open');
    expect(parseListReportsQuery({ status: 'dismissed', limit: '5' })).toMatchObject({ status: 'dismissed', limit: 5 });
    expect(() => parseListReportsQuery({ status: 'all' })).toThrow(HttpError);
  });

  it('list queries', () => {
    expect(parseListEnquiriesQuery({})).toMatchObject({ status: null, as: null, limit: 25, cursor: null });
    expect(parseListEnquiriesQuery({ status: 'new', as: 'maintainer' })).toMatchObject({ status: 'new', as: 'maintainer' });
    expect(() => parseListEnquiriesQuery({ status: 'open' })).toThrow(HttpError);
    expect(() => parseListEnquiriesQuery({ as: 'admin' })).toThrow(HttpError);
    expect(parseListViewingsQuery({ status: 'counter_proposed' }).status).toBe('counter_proposed');
    expect(() => parseListViewingsQuery({ status: 'new' })).toThrow(HttpError);
    expect(parseListNotificationsQuery({ unread: 'true' }).unreadOnly).toBe(true);
    expect(parseListNotificationsQuery({ unread: 'false' }).unreadOnly).toBe(false);
    expect(parseListNotificationsQuery({}).unreadOnly).toBe(false);
    expect(() => parseListNotificationsQuery({ unread: 'yes' })).toThrow(HttpError);
  });
});

describe('keyset helpers', () => {
  const t = '2026-11-26 09:00:00.123456+00';
  it('build the comparison for either direction and no clause for the first page', () => {
    expect(keysetWhere('e.created_at', 'e.id', null)).toBeNull();
    expect(keysetWhere('e.created_at', 'e.id', { t, id: UUID })).toEqual(['(e.created_at, e.id) < (?::timestamptz, ?::uuid)', [t, UUID]]);
    expect(keysetWhere('r.created_at', 'r.id', { t, id: UUID }, 'asc')?.[0]).toContain(') > (');
  });

  it('cut a page from limit + 1 rows and hand back a cursor only when there is more', () => {
    const rows = [1, 2, 3].map((n) => ({ id: `${UUID.slice(0, -1)}${n}`, cursor_t: `2026-11-26 09:00:0${n}.5+00` }));
    const first = keysetPage(rows, 2);
    expect(first.items).toHaveLength(2);
    expect(decodeCursor(first.nextCursor!)).toEqual({ t: rows[1]!.cursor_t, id: rows[1]!.id });
    expect(keysetPage(rows.slice(0, 2), 2).nextCursor).toBeNull();
    expect(keysetPage([], 2)).toEqual({ items: [], nextCursor: null });
  });
});

describe('Maps quota thresholds (N-11)', () => {
  const quietLog = { warn: () => {}, error: () => {} };
  const make = (limit: number, clock: { now: number }) => {
    const calls: Array<[number, number, number]> = [];
    const quota = new DailyQuota(() => limit, () => clock.now, quietLog, (threshold, used, lim) => calls.push([threshold, used, lim]));
    return { quota, calls };
  };

  it('reports 80% once and 100% once per day', () => {
    const clock = { now: NOW };
    const { quota, calls } = make(10, clock);
    quota.reserve(7);
    expect(calls).toEqual([]);
    quota.reserve(1);
    expect(calls).toEqual([[80, 8, 10]]);
    quota.reserve(1); // 9: nothing new
    expect(calls).toHaveLength(1);
    quota.reserve(1); // 10: the limit
    expect(calls).toEqual([[80, 8, 10], [100, 10, 10]]);
    expect(quota.reserve(1)).toBe(false); // refused: still only once
    expect(quota.reserve(1)).toBe(false);
    expect(calls).toHaveLength(2);
    clock.now += 86_400_000; // next UTC day: both can fire again
    quota.reserve(8);
    quota.reserve(2);
    expect(calls.slice(2)).toEqual([[80, 8, 10], [100, 10, 10]]);
  });

  it('reports 100% when a refused batch is the first to hit the limit, and both together on a jump', () => {
    const jump = make(10, { now: NOW });
    jump.quota.reserve(10); // straight from 0 to 100%
    expect(jump.calls).toEqual([[80, 10, 10], [100, 10, 10]]);
    const refused = make(10, { now: NOW });
    refused.quota.reserve(9);
    expect(refused.quota.reserve(4)).toBe(false);
    expect(refused.calls.map((c) => c[0])).toEqual([80, 100]);
  });

  it('still works with no listener', () => {
    const quota = new DailyQuota(() => 2, () => NOW, quietLog);
    expect(quota.reserve(2)).toBe(true);
    expect(quota.reserve(1)).toBe(false);
  });
});

describe('routers (fake services)', () => {
  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    res.status(typeof err?.status === 'number' ? err.status : 500).json({ code: err?.code });
  };
  const signedIn: RequestHandler = (req, _res, next) => {
    req.auth = { user: { id: 'u1' }, roles: [], profile: { language: 'en' } } as never;
    next();
  };
  const guest: RequestHandler = (_req, res) => {
    res.status(401).json({ code: 'UNAUTHORIZED' });
  };
  const serve = async (router: Router) => {
    const app = express();
    app.use(express.json());
    app.use(router);
    app.use(errorHandler);
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const send = (method: string, path: string, body?: unknown) =>
      fetch(`${url}${path}`, {
        method,
        ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
    return { send, close: () => server.close() };
  };

  it('enquiries: a Guest is refused before anything runs; a user starts a thread and gets 201', async () => {
    let called = 0;
    const deps = {
      startOrContinueEnquiry: (async (_auth: unknown, id: string, input: { body: string }) => {
        called += 1;
        return { enquiryId: 'e1', newThread: true, status: 'new', message: { id: 'm1', body: input.body, createdAt: new Date(0) }, id };
      }) as never,
    };
    const asGuest = await serve(createEnquiriesRouter({ ...deps, requireAuth: guest }));
    expect((await asGuest.send('POST', `/space-types/${UUID}/enquiries`, { body: 'hi' })).status).toBe(401);
    expect((await asGuest.send('GET', '/enquiries')).status).toBe(401);
    expect(called).toBe(0);
    asGuest.close();

    const asUser = await serve(createEnquiriesRouter({ ...deps, requireAuth: signedIn }));
    const ok = await asUser.send('POST', `/space-types/${UUID}/enquiries`, { body: ' hi ' });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { data: { message: { body: string } } }).data.message.body).toBe('hi');
    expect((await asUser.send('POST', `/space-types/${UUID}/enquiries`, { body: '' })).status).toBe(400);
    expect((await asUser.send('POST', '/space-types/not-a-uuid/enquiries', { body: 'hi' })).status).toBe(400);
    expect((await asUser.send('GET', '/enquiries?status=bogus')).status).toBe(400);
    expect(called).toBe(1);
    asUser.close();
  });

  it('viewings: every action path is wired to its transition, and the counter carries the new time', async () => {
    const seen: Array<{ action: string; input: unknown }> = [];
    const app = await serve(
      createViewingsRouter({
        requireAuth: signedIn,
        transitionViewing: (async (_auth: unknown, _id: string, action: string, input: unknown) => {
          seen.push({ action, input });
          return { id: UUID, status: 'x' };
        }) as never,
      }),
    );
    for (const action of ['accept', 'decline', 'accept-counter', 'decline-counter', 'cancel']) {
      expect((await app.send('POST', `/viewings/${UUID}/${action}`)).status).toBe(200);
    }
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString();
    expect((await app.send('POST', `/viewings/${UUID}/counter`, { proposedFor: future })).status).toBe(200);
    expect((await app.send('POST', `/viewings/${UUID}/counter`, { proposedFor: '2020-01-01T10:00:00Z' })).status).toBe(400);
    expect((await app.send('POST', `/viewings/${UUID}/counter`, {})).status).toBe(400);
    expect(seen.map((s) => s.action)).toEqual(['accept', 'decline', 'accept-counter', 'decline-counter', 'cancel', 'counter']);
    expect(seen[5]!.input).toEqual({ proposedFor: future });
    app.close();
  });

  it('reports: 201 for a new report, 200 for a repeat; the Admin queue is guarded by the admin middleware', async () => {
    let duplicate = false;
    const adminOnly: RequestHandler = (_req, res) => {
      res.status(403).json({ code: 'FORBIDDEN' });
    };
    const app = await serve(
      createReportsRouter({
        requireAuth: signedIn,
        requireAdmin: adminOnly,
        createReport: (async () => ({ id: 'r1', status: 'open', reason: 'unavailable', duplicate })) as never,
      }),
    );
    expect((await app.send('POST', `/buildings/${UUID}/reports`, { reason: 'unavailable' })).status).toBe(201);
    duplicate = true;
    expect((await app.send('POST', `/space-types/${UUID}/reports`, { reason: 'unavailable' })).status).toBe(200);
    expect((await app.send('POST', `/buildings/${UUID}/reports`, { reason: 'rude' })).status).toBe(400);
    expect((await app.send('GET', '/admin/reports')).status).toBe(403);
    expect((await app.send('POST', `/admin/reports/${UUID}/resolve`, { resolution: 'actioned' })).status).toBe(403);
    app.close();
  });

  it('notifications: read-all is not mistaken for an id, and unread is validated', async () => {
    const calls: string[] = [];
    const app = await serve(
      createNotificationsRouter({
        requireAuth: signedIn,
        listNotifications: (async (_a: unknown, q: { unreadOnly: boolean }) => {
          calls.push(`list:${q.unreadOnly}`);
          return { items: [], nextCursor: null };
        }) as never,
        unreadCount: (async () => ({ count: 3 })) as never,
        markRead: (async (_a: unknown, id: string) => {
          calls.push(`read:${id}`);
          return { id, readAt: new Date(0) };
        }) as never,
        markAllRead: (async () => {
          calls.push('read-all');
          return { updated: 2 };
        }) as never,
      }),
    );
    expect((await app.send('GET', '/notifications?unread=true')).status).toBe(200);
    expect((await app.send('GET', '/notifications?unread=1')).status).toBe(400);
    expect(((await (await app.send('GET', '/notifications/unread-count')).json()) as { data: { count: number } }).data.count).toBe(3);
    expect((await app.send('POST', '/notifications/read-all')).status).toBe(200);
    expect((await app.send('POST', `/notifications/${UUID}/read`)).status).toBe(200);
    expect((await app.send('POST', '/notifications/nope/read')).status).toBe(400);
    expect(calls).toEqual(['list:true', 'read-all', `read:${UUID}`]);
    app.close();
  });
});
