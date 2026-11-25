import { createHash, randomBytes } from 'node:crypto';
import { signJWT, verifyJWT } from 'better-auth/crypto';
import type { Knex } from 'knex';
import db from '../db/knex.js';
import { getAuthSecret } from './auth-secret.js';
import { forbidden, HttpError, unauthorized } from './http-error.js';
import { generateUuidV7 } from './uuid.js';

export const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 900;
export const DEFAULT_REFRESH_TOKEN_TTL_DAYS = 30;

export function getAccessTokenTtlSeconds(): number {
  const raw = Number(process.env.ACCESS_TOKEN_TTL_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
}

export function getRefreshTokenTtlDays(): number {
  const raw = Number(process.env.REFRESH_TOKEN_TTL_DAYS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_REFRESH_TOKEN_TTL_DAYS;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  refreshExpiresAt: Date;
}

export interface AccessTokenClaims {
  userId: string;
  sessionId: string;
  tokenVersion: number;
  jti?: string;
}

export interface TokenRequestMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function signAccessToken(params: {
  userId: string;
  sessionId: string;
  tokenVersion: number;
  expiresIn?: number;
}): Promise<{ accessToken: string; expiresIn: number }> {
  const expiresIn = params.expiresIn ?? getAccessTokenTtlSeconds();
  const accessToken = await signJWT(
    {
      sub: params.userId,
      sid: params.sessionId,
      tv: params.tokenVersion,
      typ: 'access',
      jti: generateUuidV7(),
    },
    getAuthSecret(),
    expiresIn,
  );
  return { accessToken, expiresIn };
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
  const payload = await verifyJWT(token, getAuthSecret());
  if (!payload) return null;

  if (
    payload.typ !== 'access' ||
    typeof payload.sub !== 'string' ||
    typeof payload.sid !== 'string' ||
    typeof payload.tv !== 'number'
  ) {
    return null;
  }

  return {
    userId: payload.sub,
    sessionId: payload.sid,
    tokenVersion: payload.tv,
    jti: typeof payload.jti === 'string' ? payload.jti : undefined,
  };
}

export async function issueTokenPair(
  params: {
    userId: string;
    sessionId: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
  conn: Knex | Knex.Transaction = db,
): Promise<TokenPair> {
  const profile = (await conn('profiles')
    .where({ user_id: params.userId })
    .first('token_version')) as { token_version: number } | undefined;

  if (!profile) {
    throw forbidden('Account profile not found.', { code: 'ACCOUNT_INACTIVE' });
  }

  const refreshTtlDays = getRefreshTokenTtlDays();
  const refreshExpiresAt = new Date(Date.now() + refreshTtlDays * 86_400_000);
  const rawRefreshToken = randomBytes(32).toString('base64url');
  const tokenHash = hashRefreshToken(rawRefreshToken);

  await conn('auth_refresh_tokens').insert({
    id: generateUuidV7(),
    user_id: params.userId,
    session_id: params.sessionId,
    family_id: generateUuidV7(),
    token_hash: tokenHash,
    expires_at: refreshExpiresAt,
    ip_address: params.ipAddress ?? null,
    user_agent: params.userAgent ?? null,
  });

  const { accessToken, expiresIn } = await signAccessToken({
    userId: params.userId,
    sessionId: params.sessionId,
    tokenVersion: profile.token_version,
  });

  return {
    accessToken,
    refreshToken: rawRefreshToken,
    tokenType: 'Bearer',
    expiresIn,
    refreshExpiresAt,
  };
}

interface RefreshTokenRow {
  id: string;
  user_id: string;
  session_id: string | null;
  family_id: string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  revoked_reason: string | null;
}

type RotateOutcome =
  | { ok: true; tokens: TokenPair }
  | { ok: false; error: HttpError };

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export async function rotateRefreshToken(
  rawRefreshToken: string,
  meta: TokenRequestMeta = {},
  conn: Knex = db,
): Promise<TokenPair> {
  const tokenHash = hashRefreshToken(rawRefreshToken);

  const outcome: RotateOutcome = await conn.transaction(async (trx) => {
    const row = (await trx('auth_refresh_tokens')
      .where({ token_hash: tokenHash })
      .forUpdate()
      .first(
        'id',
        'user_id',
        'session_id',
        'family_id',
        'expires_at',
        'revoked_at',
        'revoked_reason',
      )) as RefreshTokenRow | undefined;

    if (!row) {
      return {
        ok: false,
        error: unauthorized('Invalid refresh token.', { code: 'INVALID_REFRESH_TOKEN' }),
      };
    }

    if (row.revoked_at !== null) {
      if (row.revoked_reason === 'rotated') {
        // Reuse of an already-rotated token indicates theft: revoke the whole token family
        // and kill the associated session so access tokens die immediately too.
        await trx('auth_refresh_tokens')
          .where({ family_id: row.family_id })
          .whereNull('revoked_at')
          .update({
            revoked_at: trx.fn.now(),
            revoked_reason: 'reuse_detected',
          });

        if (row.session_id) {
          await trx('auth_sessions').where({ id: row.session_id }).delete();
        }
      }

      return {
        ok: false,
        error: unauthorized('Refresh token has been revoked.', { code: 'REFRESH_TOKEN_REVOKED' }),
      };
    }

    if (toDate(row.expires_at).getTime() <= Date.now()) {
      await trx('auth_refresh_tokens')
        .where({ id: row.id })
        .update({ revoked_at: trx.fn.now(), revoked_reason: 'expired' });

      return {
        ok: false,
        error: unauthorized('Refresh token has expired.', { code: 'REFRESH_TOKEN_EXPIRED' }),
      };
    }

    if (!row.session_id) {
      await trx('auth_refresh_tokens')
        .where({ id: row.id })
        .update({ revoked_at: trx.fn.now(), revoked_reason: 'session_revoked' });

      return {
        ok: false,
        error: unauthorized('Session is no longer active.', { code: 'SESSION_REVOKED' }),
      };
    }

    const sessionRow = (await trx('auth_sessions')
      .where({ id: row.session_id, user_id: row.user_id })
      .first('id', 'expires_at')) as { id: string; expires_at: Date | string } | undefined;

    if (!sessionRow || toDate(sessionRow.expires_at).getTime() <= Date.now()) {
      await trx('auth_refresh_tokens')
        .where({ id: row.id })
        .update({ revoked_at: trx.fn.now(), revoked_reason: 'session_revoked' });

      return {
        ok: false,
        error: unauthorized('Session is no longer active.', { code: 'SESSION_REVOKED' }),
      };
    }

    const profile = (await trx('profiles')
      .where({ user_id: row.user_id })
      .first('account_status', 'erased_at', 'token_version')) as
      | { account_status: string; erased_at: Date | string | null; token_version: number }
      | undefined;

    if (!profile || profile.erased_at !== null) {
      await trx('auth_refresh_tokens')
        .where({ user_id: row.user_id })
        .whereNull('revoked_at')
        .update({ revoked_at: trx.fn.now(), revoked_reason: 'inactive_account' });
      await trx('auth_sessions').where({ user_id: row.user_id }).delete();

      return {
        ok: false,
        error: forbidden('Account is not active.', { code: 'ACCOUNT_INACTIVE' }),
      };
    }

    if (profile.account_status === 'suspended') {
      await trx('auth_refresh_tokens')
        .where({ user_id: row.user_id })
        .whereNull('revoked_at')
        .update({ revoked_at: trx.fn.now(), revoked_reason: 'suspended' });
      await trx('auth_sessions').where({ user_id: row.user_id }).delete();

      return {
        ok: false,
        error: forbidden('Account is suspended.', { code: 'ACCOUNT_SUSPENDED' }),
      };
    }

    const newRefreshTokenId = generateUuidV7();
    const newRawRefreshToken = randomBytes(32).toString('base64url');
    const newTokenHash = hashRefreshToken(newRawRefreshToken);
    const refreshExpiresAt = new Date(Date.now() + getRefreshTokenTtlDays() * 86_400_000);

    await trx('auth_refresh_tokens').insert({
      id: newRefreshTokenId,
      user_id: row.user_id,
      session_id: row.session_id,
      family_id: row.family_id,
      token_hash: newTokenHash,
      expires_at: refreshExpiresAt,
      ip_address: meta.ipAddress ?? null,
      user_agent: meta.userAgent ?? null,
    });

    await trx('auth_refresh_tokens')
      .where({ id: row.id })
      .update({
        revoked_at: trx.fn.now(),
        revoked_reason: 'rotated',
        replaced_by_id: newRefreshTokenId,
      });

    // Keep the linked Better Auth session alive at least as long as a freshly refreshed session.
    const extendedSessionExpiry = new Date(Date.now() + 7 * 86_400_000);
    if (toDate(sessionRow.expires_at).getTime() < extendedSessionExpiry.getTime()) {
      await trx('auth_sessions')
        .where({ id: row.session_id })
        .update({ expires_at: extendedSessionExpiry });
    }

    const { accessToken, expiresIn } = await signAccessToken({
      userId: row.user_id,
      sessionId: row.session_id,
      tokenVersion: profile.token_version,
    });

    return {
      ok: true,
      tokens: {
        accessToken,
        refreshToken: newRawRefreshToken,
        tokenType: 'Bearer',
        expiresIn,
        refreshExpiresAt,
      },
    };
  });

  if (!outcome.ok) {
    throw outcome.error;
  }

  return outcome.tokens;
}

export async function revokeSessionTokens(
  userId: string,
  sessionId: string,
  reason = 'logout',
  conn: Knex = db,
): Promise<void> {
  await conn.transaction(async (trx) => {
    await trx('auth_refresh_tokens')
      .where({ user_id: userId, session_id: sessionId })
      .whereNull('revoked_at')
      .update({
        revoked_at: trx.fn.now(),
        revoked_reason: reason,
      });

    await trx('auth_sessions').where({ id: sessionId, user_id: userId }).delete();

    await trx('audit_log').insert({
      id: generateUuidV7(),
      actor_user_id: userId,
      actor_type: 'user',
      action: 'account.logout',
      object_type: 'session',
      object_id: sessionId,
      changes: JSON.stringify({ reason }),
    });
  });
}

export async function revokeAllUserTokens(
  userId: string,
  reason = 'logout_all',
  conn: Knex = db,
): Promise<void> {
  await conn.transaction(async (trx) => {
    await trx('profiles')
      .where({ user_id: userId })
      .increment('token_version', 1);

    await trx('auth_refresh_tokens')
      .where({ user_id: userId })
      .whereNull('revoked_at')
      .update({
        revoked_at: trx.fn.now(),
        revoked_reason: reason,
      });

    await trx('auth_sessions').where({ user_id: userId }).delete();

    await trx('audit_log').insert({
      id: generateUuidV7(),
      actor_user_id: userId,
      actor_type: 'user',
      action: reason === 'password_reset' ? 'account.password_reset' : 'account.logout_all',
      object_type: 'user',
      object_id: userId,
      changes: JSON.stringify({ reason }),
    });
  });
}
