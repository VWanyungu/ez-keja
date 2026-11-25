import express, { type Request, type RequestHandler, type Response, type Router } from 'express';
import type { IncomingHttpHeaders } from 'node:http';
import { fromNodeHeaders } from 'better-auth/node';
import { auth } from '../../lib/auth.js';
import { badRequest, forbidden, HttpError, unauthorized } from '../../lib/http-error.js';
import type { PrivacyNoticeVersion } from '../../lib/privacy-notice.js';
import { clearRefreshCookie, readRefreshCookie, refreshCookie } from '../../lib/refresh-cookie.js';
import { created, ok } from '../../lib/respond.js';
import {
  revokeAllUserTokens,
  revokeSessionTokens,
  rotateRefreshToken,
  type TokenPair,
  type TokenRequestMeta,
} from '../../lib/tokens.js';
import { requireSession } from '../../middlewares/auth.js';
import {
  parseAcceptAdminInviteBody,
  parseAcceptConsentBody,
  parseForgotPasswordBody,
  parseLoginBody,
  parseRegisterBody,
  parseResetPasswordBody,
  type AcceptAdminInviteInput,
  type AcceptConsentInput,
  type ForgotPasswordInput,
  type RegisterInput,
  type ResetPasswordInput,
} from './schemas.js';
import {
  acceptAdminInvite,
  getActivePrivacyNotice,
  getAdminInvitePreview,
  issueTokensForSessionToken,
  loadAuthenticatedAccount,
  recordUserConsent,
  registerAccount,
  type AdminInvitePreview,
  type ConsentRecordResult,
  type RegisteredAccountResult,
} from './service.js';

export interface SignInResult {
  userId: string;
  sessionToken: string;
  cookies: string[];
}

export interface AuthRouterDeps {
  registerAccount?: (input: RegisterInput) => Promise<RegisteredAccountResult>;
  getActivePrivacyNotice?: () => Promise<PrivacyNoticeVersion>;
  recordUserConsent?: (userId: string, input: AcceptConsentInput) => Promise<ConsentRecordResult>;
  getAdminInvitePreview?: (token: string) => Promise<AdminInvitePreview>;
  acceptAdminInvite?: (input: AcceptAdminInviteInput) => Promise<RegisteredAccountResult>;
  loadAuthenticatedAccount?: (userId: string) => Promise<RegisteredAccountResult>;
  signInWithEmail?: (
    credentials: { email: string; password: string },
    headers: IncomingHttpHeaders,
  ) => Promise<SignInResult>;
  issueTokensForSession?: (
    userId: string,
    sessionToken: string,
    meta: TokenRequestMeta,
  ) => Promise<TokenPair>;
  rotateRefreshToken?: (refreshToken: string, meta: TokenRequestMeta) => Promise<TokenPair>;
  requestPasswordReset?: (
    input: ForgotPasswordInput,
    headers: IncomingHttpHeaders,
  ) => Promise<void>;
  resetPassword?: (input: ResetPasswordInput, headers: IncomingHttpHeaders) => Promise<void>;
  revokeSession?: (userId: string, sessionId: string) => Promise<void>;
  revokeAllSessions?: (userId: string) => Promise<void>;
  clearSessionCookies?: (headers: IncomingHttpHeaders) => Promise<string[]>;
  requireAnySession?: RequestHandler;
}

function getRequestMeta(req: Request): TokenRequestMeta {
  const ua = req.headers['user-agent'];
  return {
    ipAddress: req.ip ?? req.socket?.remoteAddress ?? null,
    userAgent: typeof ua === 'string' ? ua : null,
  };
}

function appendSetCookies(res: Response, cookies: string[]): void {
  if (cookies.length === 0) return;
  res.setHeader('set-cookie', cookies);
}

/** The refresh token travels only in an httpOnly cookie, never in the JSON body. */
function sendTokens(res: Response, tokens: TokenPair, sessionCookies: string[] = []) {
  const { refreshToken, ...publicTokens } = tokens;
  appendSetCookies(res, [...sessionCookies, refreshCookie(refreshToken, tokens.refreshExpiresAt)]);
  return publicTokens;
}

async function defaultSignInWithEmail(
  credentials: { email: string; password: string },
  headers: IncomingHttpHeaders,
): Promise<SignInResult> {
  const response = await auth.api.signInEmail({
    body: credentials,
    headers: fromNodeHeaders(headers),
    asResponse: true,
  });

  if (!response.ok) {
    const errBody = (await response.json().catch(() => ({}))) as {
      code?: string;
      message?: string;
    };
    if (response.status === 403) {
      throw forbidden(errBody.message || 'Account is not active.', {
        code: errBody.code || 'ACCOUNT_FORBIDDEN',
      });
    }
    throw unauthorized('Invalid email or password.', { code: 'INVALID_CREDENTIALS' });
  }

  const data = (await response.json()) as { token?: string; user?: { id: string } };
  if (!data.token || !data.user?.id) {
    throw unauthorized('Invalid email or password.', { code: 'INVALID_CREDENTIALS' });
  }

  return {
    userId: data.user.id,
    sessionToken: data.token,
    cookies: response.headers.getSetCookie?.() ?? [],
  };
}

async function defaultRequestPasswordReset(
  input: ForgotPasswordInput,
  headers: IncomingHttpHeaders,
): Promise<void> {
  const response = await auth.api.requestPasswordReset({
    body: {
      email: input.email,
      ...(input.redirectTo ? { redirectTo: input.redirectTo } : {}),
    },
    headers: fromNodeHeaders(headers),
    asResponse: true,
  });

  if (!response.ok) {
    const errBody = (await response.json().catch(() => ({}))) as {
      code?: string;
      message?: string;
    };
    throw badRequest(errBody.message || 'Unable to process password reset request.', {
      code: errBody.code,
    });
  }
}

async function defaultResetPassword(
  input: ResetPasswordInput,
  headers: IncomingHttpHeaders,
): Promise<void> {
  const response = await auth.api.resetPassword({
    body: {
      token: input.token,
      newPassword: input.newPassword,
    },
    headers: fromNodeHeaders(headers),
    asResponse: true,
  });

  if (!response.ok) {
    const errBody = (await response.json().catch(() => ({}))) as {
      code?: string;
      message?: string;
    };
    throw badRequest(errBody.message || 'Invalid or expired password reset token.', {
      code: errBody.code || 'INVALID_TOKEN',
    });
  }
}

async function defaultClearSessionCookies(headers: IncomingHttpHeaders): Promise<string[]> {
  const response = await auth.api.signOut({
    headers: fromNodeHeaders(headers),
    asResponse: true,
  });
  return response.headers.getSetCookie?.() ?? [];
}

export function createAuthRouter(deps: AuthRouterDeps = {}): Router {
  const router = express.Router();

  const registerFn = deps.registerAccount ?? registerAccount;
  const noticeFn = deps.getActivePrivacyNotice ?? getActivePrivacyNotice;
  const consentFn = deps.recordUserConsent ?? recordUserConsent;
  const previewInviteFn = deps.getAdminInvitePreview ?? getAdminInvitePreview;
  const acceptInviteFn = deps.acceptAdminInvite ?? acceptAdminInvite;
  const loadAccountFn = deps.loadAuthenticatedAccount ?? loadAuthenticatedAccount;
  const signInFn = deps.signInWithEmail ?? defaultSignInWithEmail;
  const issueTokensFn = deps.issueTokensForSession ?? issueTokensForSessionToken;
  const rotateRefreshFn = deps.rotateRefreshToken ?? rotateRefreshToken;
  const forgotPasswordFn = deps.requestPasswordReset ?? defaultRequestPasswordReset;
  const resetPasswordFn = deps.resetPassword ?? defaultResetPassword;
  const revokeSessionFn = deps.revokeSession ?? revokeSessionTokens;
  const revokeAllFn = deps.revokeAllSessions ?? revokeAllUserTokens;
  const clearCookiesFn = deps.clearSessionCookies ?? defaultClearSessionCookies;
  const sessionAuth = deps.requireAnySession ?? requireSession({ allowPendingConsent: true });

  router.post('/register', async (req, res) => {
    const input = parseRegisterBody(req.body);
    const result = await registerFn(input);
    const signIn = await signInFn(
      { email: input.email, password: input.password },
      req.headers,
    );
    const tokens = await issueTokensFn(
      result.user.id,
      signIn.sessionToken,
      getRequestMeta(req),
    );
    created(res, { ...result, tokens: sendTokens(res, tokens, signIn.cookies) }, 'Account registered');
  });

  router.post('/login', async (req, res) => {
    const input = parseLoginBody(req.body);
    const signIn = await signInFn(input, req.headers);
    const [account, tokens] = await Promise.all([
      loadAccountFn(signIn.userId),
      issueTokensFn(signIn.userId, signIn.sessionToken, getRequestMeta(req)),
    ]);
    ok(res, { ...account, tokens: sendTokens(res, tokens, signIn.cookies) }, 'Logged in');
  });

  router.post('/forgot-password', async (req, res) => {
    const input = parseForgotPasswordBody(req.body);
    await forgotPasswordFn(input, req.headers);
    ok(
      res,
      { sent: true },
      'If this email exists in our system, check your email for the reset link',
    );
  });

  router.post('/reset-password', async (req, res) => {
    const input = parseResetPasswordBody(req.body);
    await resetPasswordFn(input, req.headers);
    ok(res, { reset: true }, 'Password has been reset');
  });

  router.post('/refresh', async (req, res) => {
    const refreshToken = readRefreshCookie(req.headers);
    if (!refreshToken) {
      throw unauthorized('Missing refresh token.', { code: 'INVALID_REFRESH_TOKEN' });
    }

    try {
      const tokens = await rotateRefreshFn(refreshToken, getRequestMeta(req));
      ok(res, sendTokens(res, tokens), 'Token refreshed');
    } catch (err) {
      // A dead refresh token must not keep being replayed by the browser.
      if (err instanceof HttpError && err.status < 500) appendSetCookies(res, [clearRefreshCookie()]);
      throw err;
    }
  });

  router.post('/logout', sessionAuth, async (req, res) => {
    await revokeSessionFn(req.auth!.user.id, req.auth!.session.id);
    const cookies = await clearCookiesFn(req.headers);
    appendSetCookies(res, [...cookies, clearRefreshCookie()]);
    ok(res, { loggedOut: true }, 'Logged out');
  });

  router.post('/logout-all', sessionAuth, async (req, res) => {
    await revokeAllFn(req.auth!.user.id);
    const cookies = await clearCookiesFn(req.headers);
    appendSetCookies(res, [...cookies, clearRefreshCookie()]);
    ok(res, { revokedAll: true }, 'Logged out of all sessions');
  });

  router.get('/privacy-notice', async (_req, res) => {
    const notice = await noticeFn();
    ok(res, notice, 'Current privacy notice');
  });

  router.post('/consent', sessionAuth, async (req, res) => {
    const input = parseAcceptConsentBody(req.body);
    const consent = await consentFn(req.auth!.user.id, input);
    ok(res, consent, 'Privacy notice accepted');
  });

  router.get('/admin-invites/:token', async (req, res) => {
    const preview = await previewInviteFn(req.params.token);
    ok(res, preview, 'Invite details');
  });

  router.post('/admin-invites/accept', async (req, res) => {
    const input = parseAcceptAdminInviteBody(req.body);
    const result = await acceptInviteFn(input);
    const signIn = await signInFn(
      { email: result.user.email, password: input.password },
      req.headers,
    );
    const tokens = await issueTokensFn(
      result.user.id,
      signIn.sessionToken,
      getRequestMeta(req),
    );
    created(
      res,
      { ...result, tokens: sendTokens(res, tokens, signIn.cookies) },
      'Admin account activated',
    );
  });

  return router;
}

export default createAuthRouter();
