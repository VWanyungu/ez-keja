import { afterEach, describe, expect, it } from 'bun:test';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import type { Server } from 'node:http';
import { forbidden, HttpError } from '../../lib/http-error.js';
import type { AuthContext } from '../../middlewares/auth.js';
import { renderNotification } from '../notifications/templates.js';
import { createModerationRouter, type ModerationRouterDeps } from './routes.js';
import { parseModerationBody } from './schemas.js';

const ID = '019363c8-1234-7000-8000-000000000001';
const ADMIN = '019363c8-1234-7000-8000-0000000000aa';

describe('parseModerationBody (FR-ADM-003: the reason is mandatory)', () => {
  it('accepts a reason and trims it', () => {
    expect(parseModerationBody({ reason: '  fake listing  ' })).toEqual({ reason: 'fake listing' });
  });

  it('refuses a missing, blank or non-text reason with REASON_REQUIRED', () => {
    for (const body of [undefined, {}, { reason: '' }, { reason: '   ' }, { reason: 5 }, { reason: null }]) {
      try {
        parseModerationBody(body);
        throw new Error('should have thrown');
      } catch (err) {
        expect((err as HttpError).status).toBe(400);
        expect((err as HttpError).code).toBe('REASON_REQUIRED');
      }
    }
  });

  it('refuses an over-long reason and unknown fields', () => {
    expect(() => parseModerationBody({ reason: 'x'.repeat(1001) })).toThrow(HttpError);
    expect(() => parseModerationBody({ reason: 'ok', status: 'active' })).toThrow(HttpError);
    expect(() => parseModerationBody('text')).toThrow(HttpError);
  });
});

describe('N-10 text (FR-ADM-003), English and Kiswahili', () => {
  const b = { buildingName: 'Acacia Court' };
  it('says what happened to the account, with the reason and the cascade count', () => {
    expect(renderNotification('N-10', { subject: 'account', action: 'suspended', reason: 'fake documents', buildingsAffected: 2 }, 'en')).toEqual({
      title: 'Your account has been suspended',
      body: 'Your account has been suspended. 2 buildings you maintain were also suspended. Reason: fake documents',
    });
    expect(renderNotification('N-10', { subject: 'account', action: 'reinstated', buildingsRestored: 1 }, 'en').body).toBe(
      'Your account has been reinstated. 1 building was restored.',
    );
    expect(renderNotification('N-10', { subject: 'account', action: 'suspended', reason: 'x' }, 'sw').title).toBe('Akaunti yako imesimamishwa');
  });

  it('uses the singular for one building and the plural for more, exactly (Kiswahili needs native review)', () => {
    const body = (lang: 'en' | 'sw', payload: Record<string, unknown>) => renderNotification('N-10', { subject: 'account', ...payload }, lang).body;
    expect(body('en', { action: 'suspended', buildingsAffected: 1 })).toBe('Your account has been suspended. 1 building you maintain was also suspended.');
    expect(body('en', { action: 'suspended', buildingsAffected: 3 })).toBe('Your account has been suspended. 3 buildings you maintain were also suspended.');
    expect(body('sw', { action: 'suspended', buildingsAffected: 1 })).toBe('Akaunti yako imesimamishwa. Jengo 1 unalolisimamia pia limesimamishwa.');
    expect(body('sw', { action: 'suspended', buildingsAffected: 3 })).toBe('Akaunti yako imesimamishwa. Majengo 3 unayoyasimamia pia yamesimamishwa.');
    expect(body('en', { action: 'reinstated', buildingsRestored: 1 })).toBe('Your account has been reinstated. 1 building was restored.');
    expect(body('en', { action: 'reinstated', buildingsRestored: 3 })).toBe('Your account has been reinstated. 3 buildings were restored.');
    expect(body('sw', { action: 'reinstated', buildingsRestored: 1 })).toBe('Akaunti yako imerejeshwa. Jengo 1 limerejeshwa.');
    expect(body('sw', { action: 'reinstated', buildingsRestored: 3 })).toBe('Akaunti yako imerejeshwa. Majengo 3 yamerejeshwa.');
  });

  it('names the building or photo', () => {
    expect(renderNotification('N-10', { ...b, subject: 'building', action: 'suspended', reason: 'r' }, 'en').title).toBe('Acacia Court has been suspended');
    expect(renderNotification('N-10', { ...b, subject: 'building', action: 'reinstated' }, 'sw').title).toBe('Acacia Court imerejeshwa');
    expect(renderNotification('N-10', { ...b, subject: 'photo', action: 'removed', reason: 'not the building' }, 'en').body).toBe(
      'A photo of Acacia Court was removed. Reason: not the building',
    );
    expect(renderNotification('N-10', { ...b, subject: 'photo', action: 'removed' }, 'sw').title).toBe('Picha ya Acacia Court imeondolewa');
  });

  it('falls back to words, never a raw key, for an odd payload', () => {
    const { title, body } = renderNotification('N-10', { subject: 5, buildingsAffected: 'many' }, 'en');
    expect(`${title} ${body}`).not.toMatch(/undefined|null|N-10/);
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

async function start(role: string, deps: ModerationRouterDeps = {}): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use(createModerationRouter({ requireAuth: asRole(role), requireAdmin: adminOnly, ...deps }));
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    active = app.listen(0, '127.0.0.1', () => resolve());
  });
  return `http://127.0.0.1:${(active!.address() as { port: number }).port}`;
}
const post = (url: string, body?: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe('moderation router', () => {
  const paths = [`/admin/users/${ID}/suspend`, `/admin/users/${ID}/reinstate`, `/admin/buildings/${ID}/suspend`, `/admin/buildings/${ID}/reinstate`];

  it('keeps every route behind the Admin role', async () => {
    const base = await start('landlord');
    for (const path of paths) expect((await post(`${base}${path}`, { reason: 'x' })).status, path).toBe(403);
  });

  it('refuses a missing reason before the service runs, and a bad id', async () => {
    let called = false;
    const fake = async () => {
      called = true;
      return {} as never;
    };
    const base = await start('admin', { suspendUser: fake, reinstateUser: fake, suspendBuilding: fake, reinstateBuilding: fake });
    for (const path of paths) {
      const res = await post(`${base}${path}`, {});
      expect(res.status, path).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('REASON_REQUIRED');
    }
    expect((await post(`${base}/admin/users/not-a-uuid/suspend`, { reason: 'x' })).status).toBe(400);
    expect(called).toBe(false);
  });

  it('passes the caller, id and reason to the service inside the {status,data,message} envelope', async () => {
    const seen: unknown[] = [];
    const base = await start('admin', {
      suspendUser: async (auth, id, reason) => {
        seen.push([auth.user.id, id, reason]);
        return { userId: id, accountStatus: 'suspended', buildings: { suspended: [], contactReassigned: [], skipped: [], restored: [], blocked: [] } };
      },
    });
    const res = await post(`${base}/admin/users/${ID}/suspend`, { reason: ' fraud ' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; data: { accountStatus: string }; message: string };
    expect(body).toMatchObject({ status: 'success', message: 'User suspended', data: { accountStatus: 'suspended' } });
    expect(seen).toEqual([[ADMIN, ID, 'fraud']]);
  });
});
