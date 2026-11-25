import { afterEach, describe, expect, it } from 'bun:test';
import express, { type ErrorRequestHandler } from 'express';
import type { Server } from 'node:http';
import { HttpError } from '../../lib/http-error.js';
import { MAIL_TEST_ADDRESS } from '../../lib/mail-test-address.js';
import { sendEmail, sendPasswordResetEmail } from '../../lib/mailer.js';
import { signAccessToken, verifyAccessToken } from '../../lib/tokens.js';
import { generateUuidV7, isUuidV7 } from '../../lib/uuid.js';
import {
  createRequireSession,
  requireRole,
  type AuthAccountSnapshot,
  type AuthContext,
} from '../../middlewares/auth.js';
import {
  parseAcceptAdminInviteBody,
  parseAcceptConsentBody,
  parseForgotPasswordBody,
  parseLoginBody,
  parseRegisterBody,
  parseResetPasswordBody,
} from './schemas.js';
import { createAuthRouter } from './routes.js';

const testErrorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const status = typeof err?.status === 'number' ? err.status : 500;
  const expose = Boolean(err?.expose);
  const message = expose ? err.message : 'Internal server error';
  const data = expose && err instanceof HttpError && err.data !== undefined ? err.data : null;
  const code = expose && typeof err?.code === 'string' ? err.code : undefined;

  res.status(status).json({
    status: 'error',
    data,
    message,
    ...(code !== undefined ? { code } : {}),
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

async function startTestApp(router: express.Router, basePath = '/auth'): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use(basePath, router);
  app.use(testErrorHandler);

  await new Promise<void>((resolve) => {
    activeServer = app.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = activeServer!.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to bind ephemeral test port');
  }
  return `http://127.0.0.1:${addr.port}`;
}

function makeSnapshot(overrides: Partial<AuthAccountSnapshot> = {}): AuthAccountSnapshot {
  const now = new Date('2026-11-25T12:00:00Z');
  return {
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
    roles: ['client'],
    consent: {
      currentNotice: {
        id: '019363c8-1234-7000-8000-000000000099',
        version: '2026-12-01',
        effectiveAt: now,
      },
      acceptedAt: now,
      requiresReconsent: false,
    },
    ...overrides,
  };
}

function makeSessionData(userId = '019363c8-1234-7000-8000-000000000001') {
  const now = new Date('2026-11-25T12:00:00Z');
  return {
    user: {
      id: userId,
      email: 'alice@example.com',
      name: 'Alice',
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    },
    session: {
      id: '019363c8-1234-7000-8000-000000000002',
      token: 'session-token-123',
      userId,
      expiresAt: new Date(Date.now() + 3_600_000),
      createdAt: now,
      updatedAt: now,
      ipAddress: '127.0.0.1',
      userAgent: 'bun-test',
    },
  };
}

describe('generateUuidV7', () => {
  it('produces valid RFC 9562 UUIDv7 strings', () => {
    const ids = Array.from({ length: 10 }, () => generateUuidV7());
    for (const id of ids) {
      expect(isUuidV7(id)).toBe(true);
    }
    expect(new Set(ids).size).toBe(10);
  });
});

describe('auth schemas', () => {
  it('accepts valid client, landlord, and agent registrations', () => {
    const client = parseRegisterBody({
      email: '  Alice@Example.COM ',
      password: 'password123',
      displayName: 'Alice',
      role: 'client',
      privacyNoticeAccepted: true,
    });
    expect(client.email).toBe('alice@example.com');
    expect(client.role).toBe('client');
    expect(client.agentType).toBeNull();
    expect(client.language).toBe('en');

    const agent = parseRegisterBody({
      email: 'bob@example.com',
      password: 'password123',
      displayName: 'Bob',
      phone: '+254712345678',
      language: 'sw',
      role: 'agent',
      agentType: 'caretaker',
      privacyNoticeAccepted: true,
    });
    expect(agent.agentType).toBe('caretaker');
    expect(agent.language).toBe('sw');
  });

  it('rejects registration when privacyNoticeAccepted is missing or false', () => {
    expect(() =>
      parseRegisterBody({
        email: 'a@example.com',
        password: 'password123',
        displayName: 'A',
        role: 'client',
      }),
    ).toThrow(HttpError);

    try {
      parseRegisterBody({
        email: 'a@example.com',
        password: 'password123',
        displayName: 'A',
        role: 'client',
        privacyNoticeAccepted: false,
      });
    } catch (err) {
      expect((err as HttpError).status).toBe(400);
      expect((err as HttpError).code).toBe('PRIVACY_NOTICE_REQUIRED');
    }
  });

  it('rejects admin role and agentType on non-agents', () => {
    expect(() =>
      parseRegisterBody({
        email: 'admin@example.com',
        password: 'password123',
        displayName: 'Bad Admin',
        role: 'admin',
        privacyNoticeAccepted: true,
      }),
    ).toThrow(HttpError);

    expect(() =>
      parseRegisterBody({
        email: 'landlord@example.com',
        password: 'password123',
        displayName: 'Landlord',
        role: 'landlord',
        agentType: 'caretaker',
        privacyNoticeAccepted: true,
      }),
    ).toThrow(HttpError);
  });

  it('rejects invalid phone numbers and short passwords', () => {
    expect(() =>
      parseRegisterBody({
        email: 'a@example.com',
        password: 'password123',
        displayName: 'A',
        phone: '0712345678',
        role: 'client',
        privacyNoticeAccepted: true,
      }),
    ).toThrow(HttpError);

    expect(() =>
      parseRegisterBody({
        email: 'a@example.com',
        password: 'short',
        displayName: 'A',
        role: 'client',
        privacyNoticeAccepted: true,
      }),
    ).toThrow(HttpError);
  });

  it('validates consent and admin invite acceptance payloads', () => {
    expect(parseAcceptConsentBody({ accepted: true, version: '2026-12-01' })).toEqual({
      accepted: true,
      version: '2026-12-01',
    });
    expect(() => parseAcceptConsentBody({ accepted: false })).toThrow(HttpError);

    const invite = parseAcceptAdminInviteBody({
      token: 'a'.repeat(32),
      password: 'strongpassword123',
      privacyNoticeAccepted: true,
    });
    expect(invite.token).toBe('a'.repeat(32));
    expect(() =>
      parseAcceptAdminInviteBody({
        token: 'a'.repeat(32),
        password: 'strongpassword123',
        privacyNoticeAccepted: false,
      }),
    ).toThrow(HttpError);
  });
});

describe('session middleware', () => {
  it('returns 401 when unauthenticated', async () => {
    const app = express();
    app.get(
      '/protected',
      createRequireSession(
        {},
        {
          resolveSession: async () => null,
        },
      ),
      (_req, res) => res.json({ ok: true }),
    );
    app.use(testErrorHandler);

    await new Promise<void>((resolve) => {
      activeServer = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = activeServer!.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}/protected`);
    expect(res.status).toBe(401);
  });

  it('returns 403 ACCOUNT_SUSPENDED for suspended users', async () => {
    const app = express();
    const suspendedSnapshot = makeSnapshot();
    suspendedSnapshot.profile!.accountStatus = 'suspended';
    suspendedSnapshot.profile!.suspendedReason = 'Policy breach';
    suspendedSnapshot.profile!.suspendedAt = new Date('2026-11-25T12:00:00Z');

    app.get(
      '/protected',
      createRequireSession(
        {},
        {
          resolveSession: async () => makeSessionData(),
          loadAccountSnapshot: async () => suspendedSnapshot,
        },
      ),
      (_req, res) => res.json({ ok: true }),
    );
    app.use(testErrorHandler);

    await new Promise<void>((resolve) => {
      activeServer = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = activeServer!.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}/protected`);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(403);
    expect(body.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('returns 403 CONSENT_REQUIRED on new notice version unless allowPendingConsent is true', async () => {
    const pendingConsentSnapshot = makeSnapshot({
      consent: {
        currentNotice: {
          id: '019363c8-1234-7000-8000-000000000100',
          version: '2027-01-01',
          effectiveAt: new Date('2026-11-25T12:00:00Z'),
        },
        acceptedAt: null,
        requiresReconsent: true,
      },
    });

    const app = express();
    app.get(
      '/blocked',
      createRequireSession(
        {},
        {
          resolveSession: async () => makeSessionData(),
          loadAccountSnapshot: async () => pendingConsentSnapshot,
        },
      ),
      (_req, res) => res.json({ ok: true }),
    );
    app.post(
      '/consent',
      createRequireSession(
        { allowPendingConsent: true },
        {
          resolveSession: async () => makeSessionData(),
          loadAccountSnapshot: async () => pendingConsentSnapshot,
        },
      ),
      (req, res) => res.json({ userId: req.auth!.user.id }),
    );
    app.use(testErrorHandler);

    await new Promise<void>((resolve) => {
      activeServer = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = activeServer!.address() as { port: number };

    const blockedRes = await fetch(`http://127.0.0.1:${addr.port}/blocked`);
    const blockedBody = (await blockedRes.json()) as Record<string, unknown>;
    expect(blockedRes.status).toBe(403);
    expect(blockedBody.code).toBe('CONSENT_REQUIRED');

    const consentRes = await fetch(`http://127.0.0.1:${addr.port}/consent`, { method: 'POST' });
    expect(consentRes.status).toBe(200);
  });

  it('enforces role requirements via requireRole', async () => {
    const app = express();
    app.get(
      '/admin-only',
      createRequireSession(
        {},
        {
          resolveSession: async () => makeSessionData(),
          loadAccountSnapshot: async () => makeSnapshot({ roles: ['client'] }),
        },
      ),
      requireRole('admin'),
      (_req, res) => res.json({ ok: true }),
    );
    app.use(testErrorHandler);

    await new Promise<void>((resolve) => {
      activeServer = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = activeServer!.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}/admin-only`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(403);
    expect(body.code).toBe('FORBIDDEN_ROLE');
  });
});

describe('auth router', () => {
  it('registers an account and sets session cookies', async () => {
    const baseUrl = await startTestApp(
      createAuthRouter({
        registerAccount: async (input) => ({
          user: {
            id: '019363c8-1234-7000-8000-000000000010',
            email: input.email,
            name: input.displayName,
            emailVerified: false,
          },
          profile: {
            userId: '019363c8-1234-7000-8000-000000000010',
            displayName: input.displayName,
            phone: input.phone,
            language: input.language,
            agentType: input.agentType,
            accountStatus: 'active',
            verificationStatus: 'unverified',
          },
          roles: ['client', 'landlord'],
          consent: {
            noticeVersionId: '019363c8-1234-7000-8000-000000000099',
            noticeVersion: '2026-12-01',
            acceptedAt: new Date('2026-11-25T12:00:00Z'),
          },
        }),
        signInWithEmail: async () => ({
          userId: '019363c8-1234-7000-8000-000000000010',
          sessionToken: 'session-tok-abc',
          cookies: ['better-auth.session_token=abc; Path=/; HttpOnly'],
        }),
        issueTokensForSession: async () => ({
          accessToken: 'jwt-access-token',
          refreshToken: 'opaque-refresh-token',
          tokenType: 'Bearer',
          expiresIn: 900,
          refreshExpiresAt: new Date('2026-12-25T12:00:00Z'),
        }),
      }),
    );

    const res = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'landlord@example.com',
        password: 'password123',
        displayName: 'Grace Landlord',
        role: 'landlord',
        privacyNoticeAccepted: true,
      }),
    });

    const body = (await res.json()) as {
      status: string;
      data: { tokens: { accessToken: string; refreshToken?: string } };
    };
    expect(res.status).toBe(201);
    expect(body.status).toBe('success');
    expect(body.data.tokens.accessToken).toBe('jwt-access-token');
    // The refresh token is delivered only as an httpOnly cookie, never in the JSON body.
    expect(body.data.tokens.refreshToken).toBeUndefined();
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('better-auth.session_token=abc');
    expect(setCookie).toContain('khunt_refresh=opaque-refresh-token');
    expect(setCookie).toMatch(/khunt_refresh=[^;]+; Path=\/auth; HttpOnly; SameSite=Lax/);
  });

  it('records re-consent via POST /auth/consent', async () => {
    const fakeAuth: AuthContext = {
      user: {
        id: '019363c8-1234-7000-8000-000000000010',
        email: 'alice@example.com',
        name: 'Alice',
        emailVerified: false,
        image: null,
      },
      session: {
        id: '019363c8-1234-7000-8000-000000000011',
        token: 'tok',
        expiresAt: new Date(Date.now() + 10_000),
      },
      profile: makeSnapshot().profile!,
      roles: ['client'],
      consent: {
        currentNotice: {
          id: '019363c8-1234-7000-8000-000000000100',
          version: '2027-01-01',
          effectiveAt: new Date(),
        },
        acceptedAt: null,
        requiresReconsent: true,
      },
    };

    const baseUrl = await startTestApp(
      createAuthRouter({
        requireAnySession: (req, _res, next) => {
          req.auth = fakeAuth;
          next();
        },
        recordUserConsent: async (userId, input) => ({
          userId,
          noticeVersionId: '019363c8-1234-7000-8000-000000000100',
          noticeVersion: input.version ?? '2027-01-01',
          acceptedAt: new Date('2026-11-25T12:00:00Z'),
        }),
      }),
    );

    const res = await fetch(`${baseUrl}/auth/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accepted: true, version: '2027-01-01' }),
    });
    const body = (await res.json()) as { status: string; data: { noticeVersion: string } };
    expect(res.status).toBe(200);
    expect(body.status).toBe('success');
    expect(body.data.noticeVersion).toBe('2027-01-01');
  });

  it('handles login, forgot-password, reset-password, refresh, and logout-all routes', async () => {
    const fakeAuth: AuthContext = {
      user: {
        id: '019363c8-1234-7000-8000-000000000010',
        email: 'alice@example.com',
        name: 'Alice',
        emailVerified: false,
        image: null,
      },
      session: {
        id: '019363c8-1234-7000-8000-000000000011',
        token: 'tok',
        expiresAt: new Date(Date.now() + 10_000),
      },
      profile: makeSnapshot().profile!,
      roles: ['client'],
      consent: makeSnapshot().consent,
    };

    const state: {
      revokedAllUserId: string | null;
      resetCalledWith: { token: string; newPassword: string } | null;
    } = {
      revokedAllUserId: null,
      resetCalledWith: null,
    };

    const baseUrl = await startTestApp(
      createAuthRouter({
        requireAnySession: (req, _res, next) => {
          req.auth = fakeAuth;
          next();
        },
        signInWithEmail: async () => ({
          userId: fakeAuth.user.id,
          sessionToken: 'sess-1',
          cookies: ['better-auth.session_token=sess1; Path=/; HttpOnly'],
        }),
        loadAuthenticatedAccount: async () => ({
          user: {
            id: fakeAuth.user.id,
            email: fakeAuth.user.email,
            name: fakeAuth.user.name,
            emailVerified: false,
          },
          profile: {
            userId: fakeAuth.user.id,
            displayName: 'Alice',
            phone: '+254712345678',
            language: 'en',
            agentType: null,
            accountStatus: 'active',
            verificationStatus: 'unverified',
          },
          roles: ['client'],
          consent: {
            noticeVersionId: '019363c8-1234-7000-8000-000000000099',
            noticeVersion: '2026-12-01',
            acceptedAt: new Date('2026-11-25T12:00:00Z'),
          },
        }),
        issueTokensForSession: async () => ({
          accessToken: 'access-1',
          refreshToken: 'refresh-1-long-enough-token',
          tokenType: 'Bearer',
          expiresIn: 900,
          refreshExpiresAt: new Date('2026-12-25T12:00:00Z'),
        }),
        rotateRefreshToken: async () => ({
          accessToken: 'access-2',
          refreshToken: 'refresh-2-long-enough-token',
          tokenType: 'Bearer',
          expiresIn: 900,
          refreshExpiresAt: new Date('2026-12-25T12:00:00Z'),
        }),
        requestPasswordReset: async () => {},
        resetPassword: async (input) => {
          state.resetCalledWith = input;
        },
        revokeAllSessions: async (userId) => {
          state.revokedAllUserId = userId;
        },
        clearSessionCookies: async () => ['better-auth.session_token=; Max-Age=0'],
      }),
    );

    const loginRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'password123' }),
    });
    expect(loginRes.status).toBe(200);
    const loginBody = (await loginRes.json()) as { data: { tokens: { accessToken: string } } };
    expect(loginBody.data.tokens.accessToken).toBe('access-1');

    const forgotRes = await fetch(`${baseUrl}/auth/forgot-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com' }),
    });
    expect(forgotRes.status).toBe(200);

    const resetRes = await fetch(`${baseUrl}/auth/reset-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'reset-tok-123', newPassword: 'newpassword123' }),
    });
    expect(resetRes.status).toBe(200);
    expect(state.resetCalledWith).toEqual({ token: 'reset-tok-123', newPassword: 'newpassword123' });

    const noCookieRes = await fetch(`${baseUrl}/auth/refresh`, { method: 'POST' });
    expect(noCookieRes.status).toBe(401);

    const refreshRes = await fetch(`${baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { cookie: 'khunt_refresh=refresh-1-long-enough-token' },
    });
    expect(refreshRes.status).toBe(200);
    const refreshBody = (await refreshRes.json()) as {
      data: { accessToken: string; refreshToken?: string };
    };
    expect(refreshBody.data.accessToken).toBe('access-2');
    expect(refreshBody.data.refreshToken).toBeUndefined();
    expect(refreshRes.headers.get('set-cookie')).toContain(
      'khunt_refresh=refresh-2-long-enough-token',
    );

    const logoutAllRes = await fetch(`${baseUrl}/auth/logout-all`, {
      method: 'POST',
    });
    expect(logoutAllRes.status).toBe(200);
    expect(state.revokedAllUserId).toBe(fakeAuth.user.id);
    expect(logoutAllRes.headers.get('set-cookie')).toMatch(/khunt_refresh=; .*Max-Age=0/);
  });
});

describe('access tokens, bearer middleware, and usesendy.com mailer', () => {
  it('signs and verifies access tokens and enforces token_version in middleware', async () => {
    const { accessToken } = await signAccessToken({
      userId: '019363c8-1234-7000-8000-000000000001',
      sessionId: '019363c8-1234-7000-8000-000000000002',
      tokenVersion: 1,
      expiresIn: 60,
    });

    const claims = await verifyAccessToken(accessToken);
    expect(claims).not.toBeNull();
    expect(claims!.userId).toBe('019363c8-1234-7000-8000-000000000001');
    expect(claims!.tokenVersion).toBe(1);

    let currentTokenVersion = 1;
    const app = express();
    app.get(
      '/bearer-protected',
      createRequireSession(
        {},
        {
          loadBearerSession: async (c) => ({
            user: makeSessionData(c.userId).user,
            session: {
              id: c.sessionId,
              token: 'sess-tok',
              expiresAt: new Date(Date.now() + 60_000),
            },
          }),
          loadAccountSnapshot: async () => {
            const snap = makeSnapshot();
            snap.profile!.tokenVersion = currentTokenVersion;
            return snap;
          },
        },
      ),
      (req, res) => res.json({ userId: req.auth!.user.id }),
    );
    app.use(testErrorHandler);

    await new Promise<void>((resolve) => {
      activeServer = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = activeServer!.address() as { port: number };

    const okRes = await fetch(`http://127.0.0.1:${addr.port}/bearer-protected`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(okRes.status).toBe(200);

    // Central token_version bump immediately invalidates the already-issued JWT
    currentTokenVersion = 2;
    const revokedRes = await fetch(`http://127.0.0.1:${addr.port}/bearer-protected`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const revokedBody = (await revokedRes.json()) as { code?: string };
    expect(revokedRes.status).toBe(401);
    expect(revokedBody.code).toBe('TOKEN_REVOKED');
  });

  it('validates auth login/reset/refresh schemas', () => {
    expect(parseLoginBody({ email: ' Alice@Example.COM ', password: 'secret' })).toEqual({
      email: 'alice@example.com',
      password: 'secret',
    });
    expect(parseForgotPasswordBody({ email: 'alice@example.com' })).toEqual({
      email: 'alice@example.com',
      redirectTo: undefined,
    });
    expect(
      parseResetPasswordBody({ token: 'abc123', newPassword: 'newpassword123' }),
    ).toEqual({
      token: 'abc123',
      newPassword: 'newpassword123',
    });
  });

  it('posts JSON:API email payload to usesendy.com in production', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;

    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify({ data: { id: 'email-1' } }), { status: 202 });
    }) as typeof fetch;

    const result = await sendPasswordResetEmail(
      {
        to: MAIL_TEST_ADDRESS,
        name: 'Alice',
        resetUrl: 'https://app.khunt.local/reset-password?token=tok123',
        token: 'tok123',
      },
      {
        nodeEnv: 'production',
        apiKey: 'sendy-test-key',
        from: `Khunt <${MAIL_TEST_ADDRESS}>`,
        fetchFn: fakeFetch,
      },
    );

    expect(result).toEqual({ sent: true, provider: 'usesendy' });
    expect(capturedUrl).toBe('https://usesendy.com/api/v1/emails');
    expect(capturedInit?.method).toBe('POST');
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sendy-test-key');
    expect(headers['Content-Type']).toBe('application/vnd.api+json');
    expect(headers['Idempotency-Key']).toBe('password-reset-tok123');
    const body = JSON.parse(String(capturedInit?.body)) as {
      data: { type: string; attributes: { to: string; from: string; html: string } };
    };
    expect(body.data.type).toBe('emails');
    expect(body.data.attributes.to).toBe(MAIL_TEST_ADDRESS);
    expect(body.data.attributes.html).toContain('tok123');

    await expect(
      sendEmail(
        { to: MAIL_TEST_ADDRESS, subject: 'Hi', text: 'Hi', html: '<p>Hi</p>' },
        {
          nodeEnv: 'production',
          apiKey: 'k',
          from: MAIL_TEST_ADDRESS,
          fetchFn: (async () =>
            new Response('Bad Request', { status: 400 })) as unknown as typeof fetch,
        },
      ),
    ).rejects.toThrow('Sendy email delivery failed (400)');
  });

  it('sends via Gmail in development and staging', async () => {
    const capture: {
      sentMail: Record<string, unknown> | null;
      transportCreds: { user: string; pass: string } | null;
    } = {
      sentMail: null,
      transportCreds: null,
    };

    const result = await sendPasswordResetEmail(
      {
        to: MAIL_TEST_ADDRESS,
        name: 'Dev User',
        resetUrl: 'http://localhost:5173/reset-password?token=devtok',
        token: 'devtok',
      },
      {
        nodeEnv: 'staging',
        gmailUser: MAIL_TEST_ADDRESS,
        gmailAppPassword: 'app-password',
        // Pinned so the result never depends on MAIL_FROM in a developer's .env.
        from: MAIL_TEST_ADDRESS,
        createGmailTransport: (creds) => {
          capture.transportCreds = creds;
          return {
            sendMail: async (options) => {
              capture.sentMail = options as Record<string, unknown>;
              return {} as never;
            },
          };
        },
      },
    );

    expect(result).toEqual({ sent: true, provider: 'gmail' });
    expect(capture.transportCreds).toEqual({
      user: MAIL_TEST_ADDRESS,
      pass: 'app-password',
    });
    expect(capture.sentMail?.from).toBe(MAIL_TEST_ADDRESS);
    expect(capture.sentMail?.to).toBe(MAIL_TEST_ADDRESS);
    expect(capture.sentMail?.text).toContain('devtok');

    // Staging fails closed when Gmail credentials are missing. Empty values must not fall back to
    // the real GMAIL_* variables in .env, or this test would send a real email.
    await expect(
      sendEmail(
        { to: MAIL_TEST_ADDRESS, subject: 'Hi', text: 'Hi', html: '<p>Hi</p>' },
        { nodeEnv: 'staging', gmailUser: '', gmailAppPassword: '' },
      ),
    ).rejects.toThrow('GMAIL_USER and GMAIL_APP_PASSWORD must be configured in staging.');
  });
});
