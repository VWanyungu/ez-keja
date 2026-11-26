import type { Knex } from 'knex';
import db from '../../db/knex.js';

/** Design §10.7: refresh tokens are kept this long after they expire (for reuse detection and support). */
export const REFRESH_TOKEN_RETENTION_DAYS = 30;

export interface PurgeExpiredAuthResult {
  sessions: number;
  verifications: number;
  refreshTokens: number;
}

/**
 * Nightly cleanup of expired credentials (design §10.7; no legal dependency). Deletes expired
 * `auth_sessions` and `auth_verifications`, and `auth_refresh_tokens` that expired more than 30 days
 * ago. Safe to run twice: it only ever deletes rows that are already past their expiry, so a live
 * row is never touched. `auth_refresh_tokens.session_id` cascades, so tokens of a deleted session go
 * with it; `replaced_by_id` is SET NULL.
 */
export async function purgeExpiredAuth(options: { now?: Date; conn?: Knex } = {}): Promise<PurgeExpiredAuthResult> {
  const conn = options.conn ?? db;
  const now = options.now ?? new Date();
  const tokenCutoff = new Date(now.getTime() - REFRESH_TOKEN_RETENTION_DAYS * 86_400_000);
  // Tokens first, so the count is the number that expired >30 days ago (not the cascaded ones).
  const refreshTokens = await conn('auth_refresh_tokens').where('expires_at', '<', tokenCutoff).del();
  const sessions = await conn('auth_sessions').where('expires_at', '<', now).del();
  const verifications = await conn('auth_verifications').where('expires_at', '<', now).del();
  return { sessions, verifications, refreshTokens };
}
