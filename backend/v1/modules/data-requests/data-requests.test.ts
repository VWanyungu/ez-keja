import { afterEach, describe, expect, it } from 'bun:test';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import type { Server } from 'node:http';
import { forbidden, HttpError } from '../../lib/http-error.js';
import type { AuthContext } from '../../middlewares/auth.js';
import { hasDeliverableEmail } from '../notifications/deliver.js';
import { renderEmail, renderNotification } from '../notifications/templates.js';
import { erasedEmail } from './erasure.js';
import { EXPORT_SECTIONS } from './export.js';
import { REFRESH_TOKEN_RETENTION_DAYS } from './purge-expired-auth.js';
import { createDataRequestsRouter, type DataRequestsRouterDeps } from './routes.js';
import { EXPORT_WINDOW_DAYS, parseAdminListQuery, parseCreateRequestBody, parseOutcomeBody } from './schemas.js';

const ID = '019363c8-1234-7000-8000-000000000001';
const USER = '019363c8-1234-7000-8000-0000000000aa';

const status = (fn: () => unknown): { status: number; code?: string } | null => {
  try {
    fn();
    return null;
  } catch (err) {
    return { status: (err as HttpError).status, code: (err as HttpError).code };
  }
};

describe('request bodies and queries', () => {
  it('creates a request with a type and an optional note (trimmed, blank means none)', () => {
    expect(parseCreateRequestBody({ type: 'export' })).toEqual({ type: 'export', note: null });
    expect(parseCreateRequestBody({ type: 'deletion', note: '  please  ' })).toEqual({ type: 'deletion', note: 'please' });
    expect(parseCreateRequestBody({ type: 'access', note: '   ' })).toEqual({ type: 'access', note: null });
  });

  it('refuses a missing or unknown type, a long note, unknown fields and a non-object', () => {
    for (const body of [{}, { type: 'wipe' }, { type: 5 }, { type: 'export', note: 'x'.repeat(1001) }, { type: 'export', userId: ID }, 'x', null]) {
      expect(status(() => parseCreateRequestBody(body))?.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('requires an outcome for complete and reject', () => {
    expect(parseOutcomeBody({ outcome: ' Done ' })).toEqual({ outcome: 'Done' });
    for (const body of [undefined, {}, { outcome: '' }, { outcome: '  ' }, { outcome: 3 }]) {
      expect(status(() => parseOutcomeBody(body))).toEqual({ status: 400, code: 'OUTCOME_REQUIRED' });
    }
    expect(status(() => parseOutcomeBody({ outcome: 'x'.repeat(2001) }))?.status).toBe(400);
    expect(status(() => parseOutcomeBody({ outcome: 'ok', status: 'completed' }))?.status).toBe(400);
  });

  it('parses the Admin queue filters (default is the open queue)', () => {
    expect(parseAdminListQuery({})).toMatchObject({ status: null, type: null, limit: 25, cursor: null });
    expect(parseAdminListQuery({ status: 'all', type: 'deletion', limit: '10' })).toMatchObject({ status: 'all', type: 'deletion', limit: 10 });
    expect(status(() => parseAdminListQuery({ status: 'done' }))?.status).toBe(400);
    expect(status(() => parseAdminListQuery({ type: 'x' }))?.status).toBe(400);
    expect(status(() => parseAdminListQuery({ cursor: 'garbage' }))?.status).toBe(400);
  });
});

describe('constants and helpers', () => {
  it('keeps the 7-day export window and the 30-day refresh token retention', () => {
    expect(EXPORT_WINDOW_DAYS).toBe(7);
    expect(REFRESH_TOKEN_RETENTION_DAYS).toBe(30);
  });

  it('documents the export sections and never lists credentials', () => {
    expect([...EXPORT_SECTIONS]).toEqual([
      'account', 'profile', 'roles', 'consents', 'buildings', 'enquiries', 'viewingRequests', 'reports',
      'contactEvents', 'notifications', 'files', 'verificationCases', 'dataRequests',
    ]);
    expect(EXPORT_SECTIONS.join(' ')).not.toMatch(/password|token|session/i);
  });

  it('builds a unique, non-routable placeholder address that the mail worker never delivers to', () => {
    const email = erasedEmail(ID);
    expect(email).toBe(`erased+${ID}@invalid`);
    expect(email).toBe(email.toLowerCase()); // ck_auth_users_email_lower
    expect(erasedEmail(USER)).not.toBe(email);
    expect(hasDeliverableEmail(email, null)).toBe(false);
  });
});

describe('N-12 text (FR-PRV-002), English and Kiswahili (Kiswahili needs native review)', () => {
  const en = (kind: string, type: string, extra: Record<string, unknown> = {}) =>
    renderNotification('N-12', { kind, requestType: type, ...extra }, 'en');
  const sw = (kind: string, type: string, extra: Record<string, unknown> = {}) =>
    renderNotification('N-12', { kind, requestType: type, ...extra }, 'sw');

  it('tells Admins about a new request and acknowledges it to the requester', () => {
    expect(en('received', 'deletion')).toEqual({
      title: 'New data request',
      body: 'A user asked for deletion of their data. Open the Admin request queue to handle it.',
    });
    expect(en('acknowledged', 'export').title).toBe('We received your data request');
    expect(sw('acknowledged', 'export').title).toBe('Tumepokea ombi lako la data');
    expect(sw('received', 'access').title).toBe('Ombi jipya la data');
  });

  it('says how long the download stays available, with a correct singular and plural', () => {
    expect(en('completed', 'export', { exportDays: 7 }).body).toBe(
      'Your request for a copy of your data was completed. You can download your data from your account for 7 days.',
    );
    expect(en('completed', 'access', { exportDays: 1 }).body).toContain('for 1 day.');
    expect(sw('completed', 'export', { exportDays: 7 }).body).toBe(
      'Ombi lako la nakala ya data yako limekamilika. Unaweza kupakua data yako kutoka kwenye akaunti yako kwa siku 7.',
    );
    // No download sentence for a correction or deletion request.
    expect(en('completed', 'correction', { exportDays: 7 }).body).toBe('Your request for correction of your data was completed.');
  });

  it('shows the reason on a rejection, and nothing else of the outcome text on a completion', () => {
    expect(en('rejected', 'deletion', { reason: 'We could not verify you' }).body).toBe(
      'Your request for deletion of your data was not approved. Reason: We could not verify you',
    );
    expect(sw('rejected', 'export', { reason: 'Hatukuweza kukuthibitisha' }).body).toContain('Sababu: Hatukuweza kukuthibitisha');
    expect(en('completed', 'correction', { outcome: 'secret outcome text' }).body).not.toContain('secret');
  });

  it('renders the deletion completion e-mail (sent before the erasure) in both languages', () => {
    const mail = renderEmail(en('deletion_completed', 'deletion'));
    expect(mail.subject).toBe('Your personal data has been erased');
    expect(mail.text).toContain('can no longer be used to sign in');
    expect(mail.html).toContain('<p>Records that must be kept');
    expect(sw('deletion_completed', 'deletion').title).toBe('Data zako binafsi zimefutwa');
  });

  it('never shows a raw key for an odd payload', () => {
    for (const payload of [{}, { kind: 5, requestType: {} }, null, { kind: 'completed', exportDays: 'seven' }]) {
      const { title, body } = renderNotification('N-12', payload, 'en');
      expect(`${title} ${body}`).not.toMatch(/undefined|null|N-12|\[object/);
    }
  });
});

// ---- router wiring with fake services ---------------------------------------------------------

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const code = typeof err?.status === 'number' ? err.status : 500;
  res.status(code).json({ status: 'fail', data: null, message: err.expose ? err.message : 'Internal server error', code: err.code });
};
const asRole = (...roles: string[]): RequestHandler => (req, _res, next) => {
  req.auth = { user: { id: USER }, roles } as unknown as AuthContext;
  next();
};
const adminOnly: RequestHandler = (req, _res, next) =>
  next(req.auth?.roles.includes('admin') ? undefined : forbidden('Insufficient permissions', { code: 'FORBIDDEN_ROLE' }));

let active: Server | null = null;
afterEach(async () => {
  if (active) await new Promise<void>((resolve) => active!.close(() => resolve()));
  active = null;
});

async function start(role: string, deps: DataRequestsRouterDeps = {}): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use(createDataRequestsRouter({ requireAuth: asRole(role), requireAdmin: adminOnly, ...deps }));
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    active = app.listen(0, '127.0.0.1', () => resolve());
  });
  return `http://127.0.0.1:${(active!.address() as { port: number }).port}`;
}
const post = (url: string, body?: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe('data requests router', () => {
  it('keeps the Admin routes behind the Admin role', async () => {
    const base = await start('client');
    expect((await fetch(`${base}/admin/data-requests`)).status).toBe(403);
    for (const action of ['start', 'complete', 'reject']) {
      expect((await post(`${base}/admin/data-requests/${ID}/${action}`, { outcome: 'x' })).status, action).toBe(403);
    }
  });

  it('refuses a missing outcome and a bad id before the service runs', async () => {
    let called = false;
    const fake = async () => {
      called = true;
      return {} as never;
    };
    const base = await start('admin', { completeRequest: fake, rejectRequest: fake, startRequest: fake });
    for (const action of ['complete', 'reject']) {
      const res = await post(`${base}/admin/data-requests/${ID}/${action}`, {});
      expect(res.status, action).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('OUTCOME_REQUIRED');
    }
    expect((await post(`${base}/admin/data-requests/not-a-uuid/start`)).status).toBe(400);
    expect(called).toBe(false);
  });

  it('answers 201 for a created request and passes the caller and body to the service', async () => {
    const seen: unknown[] = [];
    const base = await start('client', {
      createRequest: async (auth, input) => {
        seen.push([auth.user.id, input]);
        return { id: ID, type: input.type, status: 'open', note: input.note, requestedAt: 't', completedAt: null, outcome: null };
      },
    });
    const res = await post(`${base}/me/data-requests`, { type: 'export', note: ' hello ' });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { status: string; data: { id: string } }).data.id).toBe(ID);
    expect(seen).toEqual([[USER, { type: 'export', note: 'hello' }]]);
    expect((await post(`${base}/me/data-requests`, { type: 'wipe' })).status).toBe(400);
  });

  it('serves the export from the service for the signed-in caller only', async () => {
    const seen: unknown[] = [];
    const base = await start('client', {
      runExport: async (auth, id) => {
        seen.push([auth.user.id, id]);
        return { generatedAt: 'now', userId: auth.user.id, sections: {} as never };
      },
    });
    expect((await fetch(`${base}/me/data-requests/${ID}/export`)).status).toBe(200);
    expect(seen).toEqual([[USER, ID]]);
    expect((await fetch(`${base}/me/data-requests/nope/export`)).status).toBe(400);
  });
});
