import type { RequestHandler } from 'express';
import type { IncomingHttpHeaders } from 'node:http';
import db from '../db/knex.js';
import { getSessionFromHeaders, type BetterAuthSession } from '../lib/auth.js';
import { forbidden, unauthorized } from '../lib/http-error.js';
import { getCurrentPrivacyNotice, type PrivacyNoticeVersion } from '../lib/privacy-notice.js';
import { verifyAccessToken, type AccessTokenClaims } from '../lib/tokens.js';

export type UserRole = 'client' | 'landlord' | 'agent' | 'admin';
export type AccountStatus = 'active' | 'suspended';
export type VerificationStatus = 'unverified' | 'pending' | 'verified' | 'rejected' | 'revoked';
export type AgentType = 'agent' | 'caretaker';
export type LanguageCode = 'en' | 'sw';

export interface AuthProfile {
  userId: string;
  displayName: string;
  phone: string | null;
  language: LanguageCode;
  agentType: AgentType | null;
  photoFileId: string | null;
  accountStatus: AccountStatus;
  suspendedReason: string | null;
  suspendedAt: Date | null;
  verificationStatus: VerificationStatus;
  tokenVersion: number;
  lastLoginAt: Date | null;
  erasedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthConsentState {
  currentNotice: PrivacyNoticeVersion | null;
  acceptedAt: Date | null;
  requiresReconsent: boolean;
}

export interface AuthContext {
  user: {
    id: string;
    email: string;
    name: string;
    emailVerified: boolean;
    image: string | null;
  };
  session: {
    id: string;
    token: string;
    expiresAt: Date;
  };
  profile: AuthProfile;
  roles: UserRole[];
  consent: AuthConsentState;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

export interface RequireSessionOptions {
  allowPendingConsent?: boolean;
}

export interface AuthAccountSnapshot {
  profile: AuthProfile | null;
  roles: UserRole[];
  consent: AuthConsentState;
}

export interface BearerSessionRecord {
  user: AuthContext['user'];
  session: AuthContext['session'];
}

export interface SessionMiddlewareDeps {
  resolveSession?: (headers: IncomingHttpHeaders) => Promise<BetterAuthSession>;
  verifyBearerToken?: (token: string) => Promise<AccessTokenClaims | null>;
  loadBearerSession?: (claims: AccessTokenClaims) => Promise<BearerSessionRecord | null>;
  loadAccountSnapshot?: (userId: string) => Promise<AuthAccountSnapshot>;
}

interface ProfileRow {
  user_id: string;
  display_name: string;
  phone: string | null;
  language: LanguageCode;
  agent_type: AgentType | null;
  photo_file_id: string | null;
  account_status: AccountStatus;
  suspended_reason: string | null;
  suspended_at: Date | string | null;
  verification_status: VerificationStatus;
  token_version: number;
  last_login_at: Date | string | null;
  erased_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function toDate(val: Date | string): Date {
  return val instanceof Date ? val : new Date(val);
}

function toNullableDate(val: Date | string | null): Date | null {
  return val === null ? null : toDate(val);
}

export function extractBearerToken(headers: IncomingHttpHeaders): string | null {
  const raw = headers.authorization;
  if (typeof raw !== 'string') return null;
  if (!raw.toLowerCase().startsWith('bearer ')) return null;
  const token = raw.slice(7).trim();
  return token.length > 0 ? token : null;
}

export async function defaultLoadBearerSession(
  claims: AccessTokenClaims,
): Promise<BearerSessionRecord | null> {
  const row = (await db('auth_sessions as s')
    .join('auth_users as u', 'u.id', 's.user_id')
    .where('s.id', claims.sessionId)
    .where('s.user_id', claims.userId)
    .where('s.expires_at', '>', db.fn.now())
    .first(
      's.id as session_id',
      's.token as session_token',
      's.expires_at as session_expires_at',
      'u.id as user_id',
      'u.email',
      'u.name',
      'u.email_verified',
      'u.image',
    )) as
    | {
        session_id: string;
        session_token: string;
        session_expires_at: Date | string;
        user_id: string;
        email: string;
        name: string;
        email_verified: boolean;
        image: string | null;
      }
    | undefined;

  if (!row) return null;

  return {
    user: {
      id: row.user_id,
      email: row.email,
      name: row.name,
      emailVerified: row.email_verified,
      image: row.image,
    },
    session: {
      id: row.session_id,
      token: row.session_token,
      expiresAt: toDate(row.session_expires_at),
    },
  };
}

export async function defaultLoadAccountSnapshot(userId: string): Promise<AuthAccountSnapshot> {
  const [profileRow, roleRows, currentNotice] = await Promise.all([
    db('profiles')
      .where({ user_id: userId })
      .first(
        'user_id',
        'display_name',
        'phone',
        'language',
        'agent_type',
        'photo_file_id',
        'account_status',
        'suspended_reason',
        'suspended_at',
        'verification_status',
        'token_version',
        'last_login_at',
        'erased_at',
        'created_at',
        'updated_at',
      ) as Promise<ProfileRow | undefined>,
    db('user_roles').where({ user_id: userId }).select('role') as Promise<Array<{ role: UserRole }>>,
    getCurrentPrivacyNotice(db),
  ]);

  if (!profileRow) {
    return {
      profile: null,
      roles: [],
      consent: {
        currentNotice,
        acceptedAt: null,
        requiresReconsent: Boolean(currentNotice),
      },
    };
  }

  let acceptedAt: Date | null = null;
  if (currentNotice) {
    const consentRow = (await db('consent_records')
      .where({ user_id: userId, notice_version_id: currentNotice.id })
      .first('accepted_at')) as { accepted_at: Date | string } | undefined;
    if (consentRow) {
      acceptedAt = toDate(consentRow.accepted_at);
    }
  }

  const profile: AuthProfile = {
    userId: profileRow.user_id,
    displayName: profileRow.display_name,
    phone: profileRow.phone,
    language: profileRow.language,
    agentType: profileRow.agent_type,
    photoFileId: profileRow.photo_file_id,
    accountStatus: profileRow.account_status,
    suspendedReason: profileRow.suspended_reason,
    suspendedAt: toNullableDate(profileRow.suspended_at),
    verificationStatus: profileRow.verification_status,
    tokenVersion: profileRow.token_version ?? 1,
    lastLoginAt: toNullableDate(profileRow.last_login_at),
    erasedAt: toNullableDate(profileRow.erased_at),
    createdAt: toDate(profileRow.created_at),
    updatedAt: toDate(profileRow.updated_at),
  };

  return {
    profile,
    roles: roleRows.map((r) => r.role),
    consent: {
      currentNotice,
      acceptedAt,
      requiresReconsent: Boolean(currentNotice && acceptedAt === null),
    },
  };
}

export function createRequireSession(
  options: RequireSessionOptions = {},
  deps: SessionMiddlewareDeps = {},
): RequestHandler {
  const resolveSession = deps.resolveSession ?? getSessionFromHeaders;
  const verifyBearer = deps.verifyBearerToken ?? verifyAccessToken;
  const loadBearerSession = deps.loadBearerSession ?? defaultLoadBearerSession;
  const loadAccountSnapshot = deps.loadAccountSnapshot ?? defaultLoadAccountSnapshot;

  return async (req, _res, next) => {
    const bearerToken = extractBearerToken(req.headers);

    let resolvedUser: AuthContext['user'] | null = null;
    let resolvedSession: AuthContext['session'] | null = null;
    let expectedTokenVersion: number | null = null;

    if (bearerToken) {
      const claims = await verifyBearer(bearerToken);
      if (!claims) {
        next(unauthorized('Invalid or expired access token.', { code: 'INVALID_ACCESS_TOKEN' }));
        return;
      }
      const bearerSession = await loadBearerSession(claims);
      if (!bearerSession) {
        next(unauthorized('Session is no longer active.', { code: 'SESSION_REVOKED' }));
        return;
      }
      resolvedUser = bearerSession.user;
      resolvedSession = bearerSession.session;
      expectedTokenVersion = claims.tokenVersion;
    } else {
      const sessionData = await resolveSession(req.headers);
      if (!sessionData) {
        next(unauthorized('Authentication required', { code: 'UNAUTHORIZED' }));
        return;
      }
      resolvedUser = {
        id: sessionData.user.id,
        email: sessionData.user.email,
        name: sessionData.user.name,
        emailVerified: sessionData.user.emailVerified,
        image: sessionData.user.image ?? null,
      };
      resolvedSession = {
        id: sessionData.session.id,
        token: sessionData.session.token,
        expiresAt: sessionData.session.expiresAt,
      };
    }

    const snapshot = await loadAccountSnapshot(resolvedUser.id);
    if (!snapshot.profile || snapshot.profile.erasedAt !== null) {
      next(forbidden('Account is not active', { code: 'ACCOUNT_INACTIVE' }));
      return;
    }

    if (
      expectedTokenVersion !== null &&
      snapshot.profile.tokenVersion !== expectedTokenVersion
    ) {
      next(unauthorized('Access token has been revoked.', { code: 'TOKEN_REVOKED' }));
      return;
    }

    if (snapshot.profile.accountStatus === 'suspended') {
      next(
        forbidden('Account is suspended', {
          code: 'ACCOUNT_SUSPENDED',
          data: {
            suspendedAt: snapshot.profile.suspendedAt,
            reason: snapshot.profile.suspendedReason,
          },
        }),
      );
      return;
    }

    if (!options.allowPendingConsent && snapshot.consent.requiresReconsent) {
      next(
        forbidden('Privacy notice re-acceptance required', {
          code: 'CONSENT_REQUIRED',
          data: {
            requiredNotice: snapshot.consent.currentNotice,
          },
        }),
      );
      return;
    }

    req.auth = {
      user: resolvedUser,
      session: resolvedSession,
      profile: snapshot.profile,
      roles: snapshot.roles,
      consent: snapshot.consent,
    };

    next();
  };
}

export const requireSession = (options: RequireSessionOptions = {}): RequestHandler =>
  createRequireSession(options);

export function requireRole(...allowedRoles: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) {
      next(unauthorized('Authentication required', { code: 'UNAUTHORIZED' }));
      return;
    }

    const hasRole = allowedRoles.some((role) => req.auth!.roles.includes(role));
    if (!hasRole) {
      next(forbidden('Insufficient permissions', { code: 'FORBIDDEN_ROLE' }));
      return;
    }

    next();
  };
}
