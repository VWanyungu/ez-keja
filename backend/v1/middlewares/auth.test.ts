import { afterEach, describe, expect, it } from 'bun:test';
import express, { type ErrorRequestHandler } from 'express';
import type { Server } from 'node:http';
import { createOptionalSession, type AuthAccountSnapshot, type SessionMiddlewareDeps } from './auth.js';

const USER_ID = '019363c8-1234-7000-8000-000000000001';

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  res.status(typeof err?.status === 'number' ? err.status : 500).json({ code: err?.code });
};

const snapshot = (profile: Partial<NonNullable<AuthAccountSnapshot['profile']>> = {}): AuthAccountSnapshot => {
  const now = new Date('2026-11-25T12:00:00Z');
  return {
    profile: {
      userId: USER_ID, displayName: 'Alice', phone: null, language: 'en', agentType: null, photoFileId: null,
      accountStatus: 'active', suspendedReason: null, suspendedAt: null, verificationStatus: 'unverified',
      tokenVersion: 1, lastLoginAt: now, erasedAt: null, createdAt: now, updatedAt: now, ...profile,
    },
    roles: ['client'],
    consent: { currentNotice: null, acceptedAt: null, requiresReconsent: false },
  };
};

const sessionData = () =>
  ({
    user: { id: USER_ID, email: 'a@example.com', name: 'Alice', emailVerified: false, image: null },
    session: { id: 's1', token: 't', expiresAt: new Date(Date.now() + 60_000) },
  }) as never;

let server: Server | null = null;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

async function get(deps: SessionMiddlewareDeps, headers: Record<string, string> = {}) {
  const app = express();
  app.get('/p', createOptionalSession(deps), (req, res) => res.json({ guest: req.auth === undefined, user: req.auth?.user.id }));
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server!.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${port}/p`, { headers });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('optionalSession', () => {
  it('lets a request with no credentials through as a Guest', async () => {
    const res = await get({ resolveSession: async () => null });
    expect(res).toEqual({ status: 200, body: { guest: true } });
  });

  it('lets a request with an unrelated cookie through as a Guest', async () => {
    const res = await get({ resolveSession: async () => null }, { cookie: 'theme=dark; khunt_refresh=abc' });
    expect(res.status).toBe(200);
    expect(res.body.guest).toBe(true);
  });

  it('refuses a session cookie that no longer resolves instead of downgrading to Guest', async () => {
    const res = await get({ resolveSession: async () => null }, { cookie: 'better-auth.session_token=stale' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('refuses an invalid or revoked bearer token', async () => {
    const invalid = await get({ verifyBearerToken: async () => null }, { authorization: 'Bearer nope' });
    expect(invalid.status).toBe(401);
    expect(invalid.body.code).toBe('INVALID_ACCESS_TOKEN');

    const revoked = await get(
      {
        verifyBearerToken: async () => ({ userId: USER_ID, sessionId: 's1', tokenVersion: 1 }) as never,
        loadBearerSession: async () => null,
      },
      { authorization: 'Bearer ok' },
    );
    expect(revoked.status).toBe(401);
    expect(revoked.body.code).toBe('SESSION_REVOKED');
  });

  it('sets req.auth for a valid session', async () => {
    const res = await get({ resolveSession: async () => sessionData(), loadAccountSnapshot: async () => snapshot() }, { cookie: 'better-auth.session_token=ok' });
    expect(res).toEqual({ status: 200, body: { guest: false, user: USER_ID } });
  });

  it('refuses a suspended or erased account rather than treating it as a Guest', async () => {
    const suspended = await get(
      { resolveSession: async () => sessionData(), loadAccountSnapshot: async () => snapshot({ accountStatus: 'suspended' }) },
      { cookie: 'better-auth.session_token=ok' },
    );
    expect(suspended.status).toBe(403);
    expect(suspended.body.code).toBe('ACCOUNT_SUSPENDED');

    const erased = await get(
      { resolveSession: async () => sessionData(), loadAccountSnapshot: async () => snapshot({ erasedAt: new Date() }) },
      { cookie: 'better-auth.session_token=ok' },
    );
    expect(erased.status).toBe(403);
    expect(erased.body.code).toBe('ACCOUNT_INACTIVE');
  });
});
