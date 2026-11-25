import { afterEach, describe, expect, it } from 'bun:test';
import express, { type ErrorRequestHandler } from 'express';
import type { Server } from 'node:http';
import { HttpError, forbidden } from '../../lib/http-error.js';
import { mailTestAddress } from '../../lib/mail-test-address.js';
import type { AuthContext } from '../../middlewares/auth.js';
import { parseCreateAdminInviteBody, parseInviteIdParam } from './schemas.js';
import { createAdminRouter } from './routes.js';

const testErrorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const status = typeof err?.status === 'number' ? err.status : 500;
  const expose = Boolean(err?.expose);
  const message = expose ? err.message : 'Internal server error';
  res.status(status).json({ status: 'error', data: null, message });
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

function makeAdminAuth(): AuthContext {
  const now = new Date('2026-11-25T12:00:00Z');
  return {
    user: {
      id: '019363c8-1234-7000-8000-000000000001',
      email: 'admin@khunt.local',
      name: 'Admin',
      emailVerified: true,
      image: null,
    },
    session: {
      id: '019363c8-1234-7000-8000-000000000002',
      token: 'tok',
      expiresAt: new Date(Date.now() + 60_000),
    },
    profile: {
      userId: '019363c8-1234-7000-8000-000000000001',
      displayName: 'Admin',
      phone: null,
      language: 'en',
      agentType: null,
      photoFileId: null,
      accountStatus: 'active',
      suspendedReason: null,
      suspendedAt: null,
      verificationStatus: 'unverified',
      tokenVersion: 1,
      lastLoginAt: now,
      erasedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    roles: ['admin'],
    consent: {
      currentNotice: {
        id: '019363c8-1234-7000-8000-000000000099',
        version: '2026-12-01',
        effectiveAt: now,
      },
      acceptedAt: now,
      requiresReconsent: false,
    },
  };
}

describe('admin invite schemas', () => {
  it('normalizes email and applies default expiration', () => {
    const parsed = parseCreateAdminInviteBody({
      email: `  ${mailTestAddress('NewAdmin').toUpperCase()} `,
      displayName: 'Staff User',
    });
    expect(parsed).toEqual({
      email: mailTestAddress('newadmin'),
      displayName: 'Staff User',
      expiresInHours: 72,
    });
  });

  it('rejects out-of-range expiry and invalid invite ids', () => {
    expect(() =>
      parseCreateAdminInviteBody({
        email: mailTestAddress('expiry'),
        displayName: 'Staff',
        expiresInHours: 0,
      }),
    ).toThrow(HttpError);
    expect(() => parseInviteIdParam('not-a-uuid')).toThrow(HttpError);
  });
});

describe('/admin/invites routes', () => {
  it('rejects non-admin users with 403', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/admin',
      createAdminRouter({
        requireAuth: (req, _res, next) => {
          req.auth = makeAdminAuth();
          req.auth.roles = ['client'];
          next();
        },
        requireAdmin: (_req, _res, next) => next(forbidden('Insufficient permissions')),
      }),
    );
    app.use(testErrorHandler);

    await new Promise<void>((resolve) => {
      activeServer = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = activeServer!.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}/admin/invites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: mailTestAddress('non-admin'), displayName: 'Staff' }),
    });
    expect(res.status).toBe(403);
  });

  it('creates and lists invites for admins', async () => {
    const adminAuth = makeAdminAuth();
    const now = new Date('2026-11-25T12:00:00Z');
    const summary = {
      id: '019363c8-1234-7000-8000-000000000050',
      email: mailTestAddress('staff'),
      displayName: 'Staff',
      invitedBy: adminAuth.user.id,
      expiresAt: new Date(now.getTime() + 72 * 3_600_000),
      acceptedAt: null,
      acceptedUserId: null,
      revokedAt: null,
      revokedBy: null,
      createdAt: now,
      status: 'pending' as const,
    };

    const app = express();
    app.use(express.json());
    app.use(
      '/admin',
      createAdminRouter({
        requireAuth: (req, _res, next) => {
          req.auth = adminAuth;
          next();
        },
        createAdminInvite: async () => ({
          invite: summary,
          token: 'invite-token-xyz',
        }),
        listAdminInvites: async () => [summary],
      }),
    );
    app.use(testErrorHandler);

    await new Promise<void>((resolve) => {
      activeServer = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = activeServer!.address() as { port: number };

    const createRes = await fetch(`http://127.0.0.1:${addr.port}/admin/invites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: mailTestAddress('staff'), displayName: 'Staff' }),
    });
    const createBody = (await createRes.json()) as {
      status: string;
      data: { invite: { status: string }; token: string };
    };
    expect(createRes.status).toBe(201);
    expect(createBody.data.token).toBe('invite-token-xyz');
    expect(createBody.data.invite.status).toBe('pending');

    const listRes = await fetch(`http://127.0.0.1:${addr.port}/admin/invites`);
    const listBody = (await listRes.json()) as { status: string; data: unknown[] };
    expect(listRes.status).toBe(200);
    expect(listBody.data).toHaveLength(1);
  });
});
