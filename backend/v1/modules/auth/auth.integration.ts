import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Server } from 'node:http';
import { createApp } from '../../../app.js';
import db, { closeDb } from '../../db/knex.js';
import { closeAuthPool } from '../../lib/auth.js';
import { mailTestAddress } from '../../lib/mail-test-address.js';
import { generateUuidV7, isUuidV7 } from '../../lib/uuid.js';
import { registerAccount } from './service.js';

// Every address that can receive mail here is a real, deliverable inbox (plus-tagged so each is
// unique). With real mail keys in .env the invite and reset emails are actually delivered.
const TOKENS_USER_EMAIL = mailTestAddress('tokens-user');

let server: Server;
let baseUrl: string;

function extractCookies(res: Response): string {
  const setCookies = res.headers.getSetCookie?.() ?? [];
  return setCookies.map((c) => c.split(';')[0]).join('; ');
}

// The refresh token only ever travels as an httpOnly cookie; returns "khunt_refresh=<token>".
function extractRefreshCookie(res: Response): string {
  const cookie = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('khunt_refresh='));
  return cookie?.split(';')[0] ?? '';
}

beforeAll(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to bind ephemeral port');
  }
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await closeAuthPool();
  await closeDb();
});

describe('Auth, accounts, consent, /me, and admin invites (PostgreSQL integration)', () => {
  let adminCookie = '';
  let landlordCookie = '';
  let landlordUserId = '';
  let agentCookie = '';
  let agentUserId = '';

  it('logs in seeded dev admin via Better Auth and updates last_login_at', async () => {
    const res = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@khunt.local', password: 'password' }),
    });

    expect(res.status).toBe(200);
    adminCookie = extractCookies(res);
    expect(adminCookie).toContain('better-auth.session_token=');

    const body = (await res.json()) as { user: { id: string; email: string } };
    expect(body.user.email).toBe('admin@khunt.local');
    expect(isUuidV7(body.user.id)).toBe(true);

    const profile = await db('profiles').where({ user_id: body.user.id }).first('last_login_at');
    expect(profile?.last_login_at).not.toBeNull();
  });

  it('blocks direct Better Auth /api/auth/sign-up/email so privacy notice cannot be bypassed', async () => {
    const res = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Bypass User',
        email: 'bypass@example.com',
        password: 'password123',
      }),
    });

    expect(res.status).toBe(400);
    const user = await db('auth_users').where({ email: 'bypass@example.com' }).first('id');
    expect(user).toBeUndefined();
  });

  it('rejects registration without accepted privacy notice and leaves zero rows', async () => {
    const res = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-v': 'v1' },
      body: JSON.stringify({
        email: 'noconsent@example.com',
        password: 'password123',
        displayName: 'No Consent',
        role: 'client',
        privacyNoticeAccepted: false,
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('PRIVACY_NOTICE_REQUIRED');

    const user = await db('auth_users').where({ email: 'noconsent@example.com' }).first('id');
    expect(user).toBeUndefined();
  });

  it('rolls back the entire registration transaction if any step fails', async () => {
    const failingEmail = 'rollback-test@example.com';

    const failingDb = new Proxy(db, {
      get(target, prop) {
        if (prop === 'transaction') {
          return async (cb: (trx: any) => Promise<any>) =>
            target.transaction(async (trx) => {
              const wrappedTrx = new Proxy(trx, {
                apply(fnTarget, thisArg, args) {
                  const table = args[0];
                  const qb = Reflect.apply(fnTarget, thisArg, args);
                  if (table === 'consent_records') {
                    return new Proxy(qb, {
                      get(qTarget, qProp) {
                        if (qProp === 'insert') {
                          return () => {
                            throw new Error('Simulated consent failure');
                          };
                        }
                        return Reflect.get(qTarget, qProp);
                      },
                    });
                  }
                  return qb;
                },
              });
              return cb(wrappedTrx);
            });
        }
        return Reflect.get(target, prop);
      },
    });

    await expect(
      registerAccount(
        {
          email: failingEmail,
          password: 'password123',
          displayName: 'Rollback User',
          phone: null,
          language: 'en',
          role: 'landlord',
          agentType: null,
          privacyNoticeAccepted: true,
        },
        { db: failingDb as typeof db },
      ),
    ).rejects.toThrow('Simulated consent failure');

    const user = await db('auth_users').where({ email: failingEmail }).first('id');
    expect(user).toBeUndefined();
  });

  it('registers landlord and agent atomically with UUIDv7 ids, roles, profile, and consent', async () => {
    const landlordRes = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-v': 'v1' },
      body: JSON.stringify({
        email: 'Landlord@Example.com',
        password: 'password123',
        displayName: 'Grace Landlord',
        phone: '+254712345678',
        language: 'en',
        role: 'landlord',
        privacyNoticeAccepted: true,
      }),
    });

    expect(landlordRes.status).toBe(201);
    landlordCookie = extractCookies(landlordRes);
    expect(landlordCookie).toContain('better-auth.session_token=');

    const landlordBody = (await landlordRes.json()) as {
      data: {
        user: { id: string; email: string };
        roles: string[];
        consent: { noticeVersion: string };
      };
    };
    landlordUserId = landlordBody.data.user.id;
    expect(isUuidV7(landlordUserId)).toBe(true);
    expect(landlordBody.data.user.email).toBe('landlord@example.com');
    expect(landlordBody.data.roles).toEqual(['client', 'landlord']);
    expect(landlordBody.data.consent.noticeVersion).toBe('2026-12-01');

    // Duplicate email refused without leaking details
    const dupRes = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-v': 'v1' },
      body: JSON.stringify({
        email: 'landlord@example.com',
        password: 'password123',
        displayName: 'Duplicate',
        role: 'client',
        privacyNoticeAccepted: true,
      }),
    });
    expect(dupRes.status).toBe(409);

    // Agent with caretaker agentType
    const agentRes = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-v': 'v1' },
      body: JSON.stringify({
        email: 'agent@example.com',
        password: 'password123',
        displayName: 'Sam Caretaker',
        phone: '+254722222222',
        language: 'sw',
        role: 'agent',
        agentType: 'caretaker',
        privacyNoticeAccepted: true,
      }),
    });
    expect(agentRes.status).toBe(201);
    agentCookie = extractCookies(agentRes);
    const agentBody = (await agentRes.json()) as {
      data: { user: { id: string }; roles: string[]; profile: { agentType: string } };
    };
    agentUserId = agentBody.data.user.id;
    expect(agentBody.data.roles).toEqual(['client', 'agent']);
    expect(agentBody.data.profile.agentType).toBe('caretaker');

    const sessionRow = await db('auth_sessions').where({ user_id: landlordUserId }).first('id');
    expect(sessionRow).toBeDefined();
    expect(isUuidV7(sessionRow!.id)).toBe(true);
  });

  it('supports GET /me and PATCH /me, including FR-VER-007 re-verification on identity edit', async () => {
    const meRes = await fetch(`${baseUrl}/me`, {
      headers: { 'api-v': 'v1', cookie: landlordCookie },
    });
    expect(meRes.status).toBe(200);
    const meBody = (await meRes.json()) as {
      data: { displayName: string; roles: string[]; verificationStatus: string };
    };
    expect(meBody.data.displayName).toBe('Grace Landlord');
    expect(meBody.data.roles).toEqual(['client', 'landlord']);
    expect(meBody.data.verificationStatus).toBe('unverified');

    // Non-agent cannot set agentType
    const badAgentTypeRes = await fetch(`${baseUrl}/me`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'api-v': 'v1', cookie: landlordCookie },
      body: JSON.stringify({ agentType: 'caretaker' }),
    });
    expect(badAgentTypeRes.status).toBe(400);

    // Approve account verification case so T3 sets profiles.verification_status = 'verified'
    const adminRow = await db('auth_users').where({ email: 'admin@khunt.local' }).first('id');
    const caseId = generateUuidV7();
    await db('verification_cases').insert({
      id: caseId,
      subject_type: 'account',
      subject_user_id: agentUserId,
      origin: 'applicant',
      status: 'pending',
      submitted_by: agentUserId,
    });
    await db('verification_cases')
      .where({ id: caseId })
      .update({
        status: 'approved',
        decided_by: adminRow!.id,
        decided_at: db.fn.now(),
      });

    const verifiedProfile = await db('profiles')
      .where({ user_id: agentUserId })
      .first('verification_status');
    expect(verifiedProfile?.verification_status).toBe('verified');

    // Edit displayName -> FR-VER-007 returns verificationStatus to pending via T3
    const patchRes = await fetch(`${baseUrl}/me`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'api-v': 'v1', cookie: agentCookie },
      body: JSON.stringify({ displayName: 'Samuel Caretaker', agentType: 'agent' }),
    });
    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as {
      data: { displayName: string; agentType: string; verificationStatus: string };
    };
    expect(patchBody.data.displayName).toBe('Samuel Caretaker');
    expect(patchBody.data.agentType).toBe('agent');
    expect(patchBody.data.verificationStatus).toBe('pending');
  });

  it('requires re-consent when a new privacy notice version becomes effective', async () => {
    await db('privacy_notice_versions').insert({
      id: generateUuidV7(),
      version: '2026-11-25-v2',
      effective_at: new Date(Date.now() - 1_000),
    });

    const blockedRes = await fetch(`${baseUrl}/me`, {
      headers: { 'api-v': 'v1', cookie: landlordCookie },
    });
    expect(blockedRes.status).toBe(403);
    const blockedBody = (await blockedRes.json()) as {
      code?: string;
      data?: { requiredNotice?: { version: string } };
    };
    expect(blockedBody.code).toBe('CONSENT_REQUIRED');
    expect(blockedBody.data?.requiredNotice?.version).toBe('2026-11-25-v2');

    // Re-consent via POST /auth/consent
    const consentRes = await fetch(`${baseUrl}/auth/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-v': 'v1', cookie: landlordCookie },
      body: JSON.stringify({ accepted: true, version: '2026-11-25-v2' }),
    });
    expect(consentRes.status).toBe(200);

    // Admin also needs to accept the new notice version before calling /admin/invites
    const adminConsentRes = await fetch(`${baseUrl}/auth/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-v': 'v1', cookie: adminCookie },
      body: JSON.stringify({ accepted: true, version: '2026-11-25-v2' }),
    });
    expect(adminConsentRes.status).toBe(200);

    // Subsequent GET /me succeeds
    const okRes = await fetch(`${baseUrl}/me`, {
      headers: { 'api-v': 'v1', cookie: landlordCookie },
    });
    expect(okRes.status).toBe(200);
  });

  it('returns 403 ACCOUNT_SUSPENDED in session middleware and blocks login for suspended users', async () => {
    await db('profiles')
      .where({ user_id: landlordUserId })
      .update({
        account_status: 'suspended',
        suspended_reason: 'Test suspension',
        suspended_at: db.fn.now(),
      });

    const meRes = await fetch(`${baseUrl}/me`, {
      headers: { 'api-v': 'v1', cookie: landlordCookie },
    });
    expect(meRes.status).toBe(403);
    const meBody = (await meRes.json()) as { code?: string };
    expect(meBody.code).toBe('ACCOUNT_SUSPENDED');

    const loginRes = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'landlord@example.com', password: 'password123' }),
    });
    expect(loginRes.status).toBe(403);
  });

  it('runs the full Admin invite flow (create -> preview -> accept -> admin access)', async () => {
    // Agent re-consents first so role enforcement (FORBIDDEN_ROLE) is exercised directly.
    const agentConsentRes = await fetch(`${baseUrl}/auth/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-v': 'v1', cookie: agentCookie },
      body: JSON.stringify({ accepted: true, version: '2026-11-25-v2' }),
    });
    expect(agentConsentRes.status).toBe(200);

    // Non-admin cannot create invites
    const nonAdminRes = await fetch(`${baseUrl}/admin/invites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-v': 'v1', cookie: agentCookie },
      body: JSON.stringify({ email: mailTestAddress('newadmin'), displayName: 'New Admin' }),
    });
    expect(nonAdminRes.status).toBe(403);
    const nonAdminBody = (await nonAdminRes.json()) as { code?: string };
    expect(nonAdminBody.code).toBe('FORBIDDEN_ROLE');

    // Admin creates invite
    const createRes = await fetch(`${baseUrl}/admin/invites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-v': 'v1', cookie: adminCookie },
      body: JSON.stringify({ email: mailTestAddress('NewAdmin'), displayName: 'New Admin' }),
    });
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as {
      data: { invite: { id: string; email: string; status: string }; token: string };
    };
    const { invite, token } = createBody.data;
    expect(isUuidV7(invite.id)).toBe(true);
    expect(invite.email).toBe(mailTestAddress('newadmin'));
    expect(invite.status).toBe('pending');
    expect(token.length).toBeGreaterThan(20);

    // Public invite preview
    const previewRes = await fetch(`${baseUrl}/auth/admin-invites/${token}`, {
      headers: { 'api-v': 'v1' },
    });
    expect(previewRes.status).toBe(200);
    const previewBody = (await previewRes.json()) as {
      data: { email: string; displayName: string; privacyNotice: { version: string } };
    };
    expect(previewBody.data.email).toBe(mailTestAddress('newadmin'));
    expect(previewBody.data.privacyNotice.version).toBe('2026-11-25-v2');

    // Accepting without privacy notice is rejected
    const noConsentRes = await fetch(`${baseUrl}/auth/admin-invites/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-v': 'v1' },
      body: JSON.stringify({
        token,
        password: 'adminpassword123',
        privacyNoticeAccepted: false,
      }),
    });
    expect(noConsentRes.status).toBe(400);

    // Accept invite
    const acceptRes = await fetch(`${baseUrl}/auth/admin-invites/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-v': 'v1' },
      body: JSON.stringify({
        token,
        password: 'adminpassword123',
        phone: '+254733333333',
        privacyNoticeAccepted: true,
      }),
    });
    expect(acceptRes.status).toBe(201);
    const newAdminCookie = extractCookies(acceptRes);
    expect(newAdminCookie).toContain('better-auth.session_token=');

    const acceptBody = (await acceptRes.json()) as {
      data: { user: { id: string }; roles: string[] };
    };
    expect(acceptBody.data.roles).toEqual(['admin']);

    // Verify granted_by on user_roles points to the inviting admin
    const adminUser = await db('auth_users').where({ email: 'admin@khunt.local' }).first('id');
    const roleRow = await db('user_roles')
      .where({ user_id: acceptBody.data.user.id, role: 'admin' })
      .first('granted_by');
    expect(roleRow?.granted_by).toBe(adminUser!.id);

    // Reusing the token is rejected
    const reuseRes = await fetch(`${baseUrl}/auth/admin-invites/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-v': 'v1' },
      body: JSON.stringify({
        token,
        password: 'adminpassword123',
        privacyNoticeAccepted: true,
      }),
    });
    expect(reuseRes.status).toBe(409);

    // New Admin can access /admin/invites
    const listRes = await fetch(`${baseUrl}/admin/invites`, {
      headers: { 'api-v': 'v1', cookie: newAdminCookie },
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { data: Array<{ status: string }> };
    expect(listBody.data[0]?.status).toBe('accepted');

    // Create and revoke an invite
    const createSecondRes = await fetch(`${baseUrl}/admin/invites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-v': 'v1', cookie: newAdminCookie },
      body: JSON.stringify({ email: mailTestAddress('revoked-admin'), displayName: 'Revoked Admin' }),
    });
    expect(createSecondRes.status).toBe(201);
    const secondBody = (await createSecondRes.json()) as {
      data: { invite: { id: string }; token: string };
    };

    const revokeRes = await fetch(
      `${baseUrl}/admin/invites/${secondBody.data.invite.id}/revoke`,
      {
        method: 'POST',
        headers: { 'api-v': 'v1', cookie: newAdminCookie },
      },
    );
    expect(revokeRes.status).toBe(200);
    const revokeBody = (await revokeRes.json()) as { data: { status: string } };
    expect(revokeBody.data.status).toBe('revoked');

    const acceptRevokedRes = await fetch(`${baseUrl}/auth/admin-invites/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-v': 'v1' },
      body: JSON.stringify({
        token: secondBody.data.token,
        password: 'adminpassword123',
        privacyNoticeAccepted: true,
      }),
    });
    expect(acceptRevokedRes.status).toBe(400);
    const acceptRevokedBody = (await acceptRevokedRes.json()) as { code?: string };
    expect(acceptRevokedBody.code).toBe('INVITE_REVOKED');
  });

  it('supports login, refresh token rotation + reuse detection, forgot/reset password, and centralized logout-all', async () => {
    // 1. Register a fresh user and confirm Bearer accessToken works immediately on GET /me
    const regRes = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-v': 'v1' },
      body: JSON.stringify({
        email: TOKENS_USER_EMAIL,
        password: 'password123',
        displayName: 'Token User',
        role: 'client',
        privacyNoticeAccepted: true,
      }),
    });
    expect(regRes.status).toBe(201);
    const regBody = (await regRes.json()) as {
      data: {
        user: { id: string };
        tokens: { accessToken: string; refreshToken?: string; tokenType: string };
      };
    };
    const tokenUserId = regBody.data.user.id;
    expect(regBody.data.tokens.tokenType).toBe('Bearer');
    expect(regBody.data.tokens.refreshToken).toBeUndefined();

    const meBearerRes = await fetch(`${baseUrl}/me`, {
      headers: {
        'api-v': 'v1',
        authorization: `Bearer ${regBody.data.tokens.accessToken}`,
      },
    });
    expect(meBearerRes.status).toBe(200);

    // 2. Refresh token rotation & reuse detection
    const oldRefresh = extractRefreshCookie(regRes);
    expect(oldRefresh).toStartWith('khunt_refresh=');
    const regSetCookie = regRes.headers.getSetCookie?.() ?? [];
    expect(regSetCookie.find((c) => c.startsWith('khunt_refresh='))).toMatch(
      /Path=\/auth; HttpOnly; SameSite=Lax/,
    );

    const noCookieRefreshRes = await fetch(`${baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'api-v': 'v1' },
    });
    expect(noCookieRefreshRes.status).toBe(401);

    const refreshRes = await fetch(`${baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'api-v': 'v1', cookie: oldRefresh },
    });
    expect(refreshRes.status).toBe(200);
    const refreshBody = (await refreshRes.json()) as {
      data: { accessToken: string; refreshToken?: string };
    };
    expect(refreshBody.data.refreshToken).toBeUndefined();
    const rotatedRefresh = extractRefreshCookie(refreshRes);
    expect(rotatedRefresh).toStartWith('khunt_refresh=');
    expect(rotatedRefresh).not.toBe(oldRefresh);

    // Replaying the old rotated refresh token triggers reuse_detected and kills the family + session
    const replayRes = await fetch(`${baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'api-v': 'v1', cookie: oldRefresh },
    });
    expect(replayRes.status).toBe(401);
    // A dead token is cleared from the browser so it stops being replayed.
    expect(replayRes.headers.getSetCookie?.().some((c) => /^khunt_refresh=;.*Max-Age=0/.test(c))).toBe(
      true,
    );

    const killedChildRes = await fetch(`${baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'api-v': 'v1', cookie: rotatedRefresh },
    });
    expect(killedChildRes.status).toBe(401);

    const killedAccessRes = await fetch(`${baseUrl}/me`, {
      headers: {
        'api-v': 'v1',
        authorization: `Bearer ${refreshBody.data.accessToken}`,
      },
    });
    expect(killedAccessRes.status).toBe(401);

    // 3. Log in from two separate sessions
    const login1Res = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-v': 'v1' },
      body: JSON.stringify({ email: TOKENS_USER_EMAIL, password: 'password123' }),
    });
    expect(login1Res.status).toBe(200);
    const login1Body = (await login1Res.json()) as {
      data: { tokens: { accessToken: string } };
    };
    const login1Refresh = extractRefreshCookie(login1Res);

    const login2Res = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-v': 'v1' },
      body: JSON.stringify({ email: TOKENS_USER_EMAIL, password: 'password123' }),
    });
    expect(login2Res.status).toBe(200);
    const login2Body = (await login2Res.json()) as {
      data: { tokens: { accessToken: string } };
    };
    const login2Refresh = extractRefreshCookie(login2Res);
    const login2Cookie = extractCookies(login2Res);

    // 4. Logout-all centrally invalidates BOTH access tokens, BOTH refresh tokens, and ALL sessions
    const logoutAllRes = await fetch(`${baseUrl}/auth/logout-all`, {
      method: 'POST',
      headers: {
        'api-v': 'v1',
        authorization: `Bearer ${login1Body.data.tokens.accessToken}`,
      },
    });
    expect(logoutAllRes.status).toBe(200);

    for (const tok of [
      login1Body.data.tokens.accessToken,
      login2Body.data.tokens.accessToken,
    ]) {
      const r = await fetch(`${baseUrl}/me`, {
        headers: { 'api-v': 'v1', authorization: `Bearer ${tok}` },
      });
      expect(r.status).toBe(401);
    }

    for (const rtok of [login1Refresh, login2Refresh]) {
      const r = await fetch(`${baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'api-v': 'v1', cookie: rtok },
      });
      expect(r.status).toBe(401);
    }

    const cookieAfterLogoutAll = await fetch(`${baseUrl}/me`, {
      headers: { 'api-v': 'v1', cookie: login2Cookie },
    });
    expect(cookieAfterLogoutAll.status).toBe(401);

    // 5. Forgot password -> usesendy.com email delivery -> reset password revokes active tokens
    const login3Res = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-v': 'v1' },
      body: JSON.stringify({ email: TOKENS_USER_EMAIL, password: 'password123' }),
    });
    expect(login3Res.status).toBe(200);
    const login3Body = (await login3Res.json()) as {
      data: { tokens: { accessToken: string } };
    };
    const login3Refresh = extractRefreshCookie(login3Res);

    const origFetch = globalThis.fetch;
    const origNodeEnv = process.env.NODE_ENV;
    const origSendyKey = process.env.USESENDY_API_KEY;
    const origMailFrom = process.env.MAIL_FROM;
    let capturedResetToken = '';

    process.env.NODE_ENV = 'production';
    process.env.USESENDY_API_KEY = 'test-sendy-key';
    process.env.MAIL_FROM = 'Khunt <noreply@khunt.local>';
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://usesendy.com/')) {
        const payload = JSON.parse(String(init?.body)) as {
          data: { attributes: { to: string; text: string } };
        };
        const match = payload.data.attributes.text.match(/token=([^\s&]+)/);
        const pathMatch = payload.data.attributes.text.match(/reset-password\/([^?\s]+)/);
        capturedResetToken = decodeURIComponent((match?.[1] ?? pathMatch?.[1] ?? ''));
        return new Response(JSON.stringify({ data: { id: 'sendy-msg-1' } }), { status: 202 });
      }
      return origFetch(input, init);
    }) as typeof fetch;

    try {
      const forgotRes = await fetch(`${baseUrl}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'api-v': 'v1' },
        body: JSON.stringify({ email: TOKENS_USER_EMAIL }),
      });
      expect(forgotRes.status).toBe(200);
      expect(capturedResetToken.length).toBeGreaterThan(10);
    } finally {
      globalThis.fetch = origFetch;
      process.env.NODE_ENV = origNodeEnv;
      if (origSendyKey === undefined) delete process.env.USESENDY_API_KEY;
      else process.env.USESENDY_API_KEY = origSendyKey;
      if (origMailFrom === undefined) delete process.env.MAIL_FROM;
      else process.env.MAIL_FROM = origMailFrom;
    }

    const resetRes = await fetch(`${baseUrl}/auth/reset-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-v': 'v1' },
      body: JSON.stringify({ token: capturedResetToken, newPassword: 'newpassword456' }),
    });
    expect(resetRes.status).toBe(200);

    // Pre-reset tokens are centrally invalidated
    const staleAccessRes = await fetch(`${baseUrl}/me`, {
      headers: {
        'api-v': 'v1',
        authorization: `Bearer ${login3Body.data.tokens.accessToken}`,
      },
    });
    expect(staleAccessRes.status).toBe(401);

    const staleRefreshRes = await fetch(`${baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'api-v': 'v1', cookie: login3Refresh },
    });
    expect(staleRefreshRes.status).toBe(401);

    // Old password fails; new password succeeds
    const oldPassLogin = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-v': 'v1' },
      body: JSON.stringify({ email: TOKENS_USER_EMAIL, password: 'password123' }),
    });
    expect(oldPassLogin.status).toBe(401);

    const newPassLogin = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-v': 'v1' },
      body: JSON.stringify({ email: TOKENS_USER_EMAIL, password: 'newpassword456' }),
    });
    expect(newPassLogin.status).toBe(200);

    const profileAfter = await db('profiles')
      .where({ user_id: tokenUserId })
      .first('token_version');
    expect(profileAfter?.token_version).toBeGreaterThanOrEqual(3);
  });
});
