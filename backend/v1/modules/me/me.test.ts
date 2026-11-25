import { afterEach, describe, expect, it } from 'bun:test';
import express, { type ErrorRequestHandler } from 'express';
import type { Server } from 'node:http';
import { HttpError } from '../../lib/http-error.js';
import type { AuthContext } from '../../middlewares/auth.js';
import { parsePatchMeBody } from './schemas.js';
import { createMeRouter } from './routes.js';
import { getMe } from './service.js';

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

function makeAuthContext(): AuthContext {
  const now = new Date('2026-11-25T12:00:00Z');
  return {
    user: {
      id: '019363c8-1234-7000-8000-000000000001',
      email: 'alice@example.com',
      name: 'Alice',
      emailVerified: false,
      image: null,
    },
    session: {
      id: '019363c8-1234-7000-8000-000000000002',
      token: 'tok',
      expiresAt: new Date(Date.now() + 60_000),
    },
    profile: {
      userId: '019363c8-1234-7000-8000-000000000001',
      displayName: 'Alice',
      phone: '+254712345678',
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
    roles: ['client', 'landlord'],
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

describe('parsePatchMeBody', () => {
  it('parses valid editable fields', () => {
    expect(
      parsePatchMeBody({
        displayName: '  Alice Updated ',
        phone: '+254700000001',
        language: 'sw',
      }),
    ).toEqual({
      displayName: 'Alice Updated',
      phone: '+254700000001',
      language: 'sw',
    });
  });

  it('rejects empty body and disallowed fields', () => {
    expect(() => parsePatchMeBody({})).toThrow(HttpError);
    expect(() => parsePatchMeBody({ roles: ['admin'] })).toThrow(HttpError);
    expect(() => parsePatchMeBody({ verificationStatus: 'verified' })).toThrow(HttpError);
    expect(() => parsePatchMeBody({ accountStatus: 'active' })).toThrow(HttpError);
  });
});

describe('/me routes', () => {
  it('returns current profile on GET /me and updates on PATCH /me', async () => {
    const ctx = makeAuthContext();
    const app = express();
    app.use(express.json());
    app.use(
      '/me',
      createMeRouter({
        requireAuth: (req, _res, next) => {
          req.auth = ctx;
          next();
        },
        updateMe: async (authCtx, patch) => ({
          ...getMe(authCtx),
          displayName: patch.displayName ?? authCtx.profile.displayName,
          language: patch.language ?? authCtx.profile.language,
        }),
      }),
    );
    app.use(testErrorHandler);

    await new Promise<void>((resolve) => {
      activeServer = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = activeServer!.address() as { port: number };

    const getRes = await fetch(`http://127.0.0.1:${addr.port}/me`);
    const getBody = (await getRes.json()) as { status: string; data: { email: string; roles: string[] } };
    expect(getRes.status).toBe(200);
    expect(getBody.data.email).toBe('alice@example.com');
    expect(getBody.data.roles).toEqual(['client', 'landlord']);

    const patchRes = await fetch(`http://127.0.0.1:${addr.port}/me`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Alice B', language: 'sw' }),
    });
    const patchBody = (await patchRes.json()) as {
      status: string;
      data: { displayName: string; language: string };
    };
    expect(patchRes.status).toBe(200);
    expect(patchBody.data.displayName).toBe('Alice B');
    expect(patchBody.data.language).toBe('sw');
  });
});
