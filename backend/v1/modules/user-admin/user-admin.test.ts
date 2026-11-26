import { afterEach, describe, expect, it } from 'bun:test';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import type { Server } from 'node:http';
import { forbidden, HttpError } from '../../lib/http-error.js';
import { encodeCursor } from '../../lib/keyset.js';
import type { AuthContext } from '../../middlewares/auth.js';
import { createUserAdminRouter, type UserAdminRouterDeps } from './routes.js';
import { parseGrantRoleBody, parseRole, parseUserListQuery } from './schemas.js';

const ID = '019363c8-1234-7000-8000-000000000001';
const ADMIN = '019363c8-1234-7000-8000-0000000000aa';

describe('roles an Admin may assign (FR-ADM-006)', () => {
  it('accepts client, landlord and agent', () => {
    for (const role of ['client', 'landlord', 'agent'] as const) expect(parseRole(role)).toBe(role);
    expect(parseGrantRoleBody({ role: 'agent' })).toEqual({ role: 'agent' });
  });

  it('never grants or revokes admin, with its own code', () => {
    for (const fn of [() => parseRole('admin'), () => parseGrantRoleBody({ role: 'admin' })]) {
      try {
        fn();
        throw new Error('should have thrown');
      } catch (err) {
        expect((err as HttpError).code).toBe('ADMIN_ROLE_NOT_ASSIGNABLE');
      }
    }
  });

  it('refuses unknown roles, extra fields and a missing role', () => {
    expect(() => parseRole('superuser')).toThrow(HttpError);
    expect(() => parseGrantRoleBody({})).toThrow(HttpError);
    expect(() => parseGrantRoleBody({ role: 'client', grantedBy: ID })).toThrow(HttpError);
  });
});

describe('parseUserListQuery', () => {
  it('defaults to no filters and the standard page size', () => {
    expect(parseUserListQuery({})).toEqual({ limit: 25, cursor: null, q: null, role: null, status: null, verification: null });
  });

  it('reads search, role, status, verification and keyset paging', () => {
    const cursor = encodeCursor({ t: '2026-11-26 09:00:00.123456+00', id: ID });
    const q = parseUserListQuery({ q: ' amina ', role: 'landlord', status: 'suspended', verification: 'pending', limit: '5', cursor });
    expect(q).toMatchObject({ q: 'amina', role: 'landlord', status: 'suspended', verification: 'pending', limit: 5 });
    expect(q.cursor?.id).toBe(ID);
  });

  it('rejects values outside the allowed lists', () => {
    for (const bad of [{ role: 'root' }, { status: 'banned' }, { verification: 'maybe' }, { q: '' }, { q: 'x'.repeat(101) }, { limit: '0' }, { cursor: 'nope' }]) {
      expect(() => parseUserListQuery(bad)).toThrow(HttpError);
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

async function start(role: string, deps: UserAdminRouterDeps = {}): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use(createUserAdminRouter({ requireAuth: asRole(role), requireAdmin: adminOnly, ...deps }));
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    active = app.listen(0, '127.0.0.1', () => resolve());
  });
  return `http://127.0.0.1:${(active!.address() as { port: number }).port}`;
}

describe('user administration router', () => {
  it('keeps every route behind the Admin role', async () => {
    const base = await start('client');
    expect((await fetch(`${base}/admin/users`)).status).toBe(403);
    expect((await fetch(`${base}/admin/users/${ID}`)).status).toBe(403);
    expect((await fetch(`${base}/admin/users/${ID}/roles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'agent' }) })).status).toBe(403);
    expect((await fetch(`${base}/admin/users/${ID}/roles/agent`, { method: 'DELETE' })).status).toBe(403);
  });

  it('refuses the admin role on both role routes before the service runs', async () => {
    let called = false;
    const base = await start('admin', {
      grantRole: async () => ((called = true), { roles: [] }),
      revokeRole: async () => ((called = true), { roles: [] }),
    });
    const grant = await fetch(`${base}/admin/users/${ID}/roles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'admin' }) });
    expect(grant.status).toBe(400);
    const revoke = await fetch(`${base}/admin/users/${ID}/roles/admin`, { method: 'DELETE' });
    expect(revoke.status).toBe(400);
    expect(((await revoke.json()) as { code: string }).code).toBe('ADMIN_ROLE_NOT_ASSIGNABLE');
    expect(called).toBe(false);
  });

  it('passes parsed input to the service and wraps the result', async () => {
    const seen: unknown[] = [];
    const base = await start('admin', {
      listUsers: async (_auth, q) => (seen.push(q.role), { items: [], nextCursor: null }),
      revokeRole: async (_auth, id, role) => (seen.push([id, role]), { roles: ['client'] }),
    });
    const list = await fetch(`${base}/admin/users?role=agent`);
    expect(await list.json()).toMatchObject({ status: 'success', data: { items: [], nextCursor: null } });
    const revoke = await fetch(`${base}/admin/users/${ID}/roles/landlord`, { method: 'DELETE' });
    expect(((await revoke.json()) as { data: { roles: string[] } }).data.roles).toEqual(['client']);
    expect(seen).toEqual(['agent', [ID, 'landlord']]);
  });
});
