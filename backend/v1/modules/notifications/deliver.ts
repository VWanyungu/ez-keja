import type { Knex } from 'knex';
import db from '../../db/knex.js';
import { sendEmail, type SendEmailPayload, type SendEmailResult } from '../../lib/mailer.js';
import { EMAIL_REGEX } from '../../lib/validation.js';
import { renderEmail, renderNotification } from './templates.js';

/** After this many attempts a delivery becomes `abandoned` (design §5.5, review R-30). */
export const MAX_ATTEMPTS = 5;
/** Wait before retry n (index n - 1): 1 min, 5 min, 30 min, 2 h. The attempt that hits the cap is final. */
export const BACKOFF_SECONDS = [60, 300, 1800, 7200] as const;
/**
 * A claimed delivery is invisible to other runs for this long. If the process dies mid-send the
 * delivery becomes claimable again afterwards (at-least-once; the idempotency key limits repeats).
 */
export const CLAIM_LEASE_SECONDS = 300;
export const DEFAULT_BATCH_SIZE = 50;

export type EmailSender = (message: SendEmailPayload) => Promise<SendEmailResult>;

export interface DeliverOptions {
  /** Inject a fake in tests; defaults to the real mailer (`lib/mailer.ts`). */
  sender?: EmailSender;
  now?: () => Date;
  batchSize?: number;
  conn?: Knex;
}

export interface DeliverResult {
  claimed: number;
  sent: number;
  /** Failed this time and scheduled for another attempt. */
  failed: number;
  /** Not retried any more: attempt cap reached, or the recipient has no deliverable email. */
  abandoned: number;
}

/**
 * `last_error` is written to a column that the erasure procedure blanks (design §10.6 step 7)
 * because provider messages can echo an address. We never store the message at all: only a short
 * code that matches a strict pattern, so no email address or other personal data can reach it.
 */
export function safeErrorReason(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  const responseCode = (err as { responseCode?: unknown } | null)?.responseCode;
  const pick = typeof code === 'string' ? code : typeof responseCode === 'number' ? String(responseCode) : null;
  return pick && /^[A-Za-z0-9_]{1,40}$/.test(pick) ? `send_failed:${pick}` : 'send_failed';
}

export const NO_EMAIL_REASON = 'no_deliverable_email';
export const NOT_CONFIGURED_REASON = 'mail_not_configured';

/** An erased account carries `erased+<id>@invalid` (design §10.6 step 2). */
export const hasDeliverableEmail = (email: string | null, erasedAt: unknown): boolean =>
  !erasedAt && !!email && EMAIL_REGEX.test(email) && !email.toLowerCase().endsWith('@invalid');

interface ClaimedRow {
  id: string;
  attempts: number;
}

interface WorkRow {
  id: string;
  event_code: string;
  payload: unknown;
  email: string | null;
  language: string | null;
  erased_at: Date | null;
}

/**
 * FR-NTF-001: sends the pending email deliveries. Claiming is one UPDATE over a
 * `FOR UPDATE SKIP LOCKED` subselect: it counts the attempt and pushes `next_attempt_at` out by
 * the lease, so two overlapping runs (or two PM2 instances) never take the same row, and nobody
 * holds a lock while the slow mail call is in flight. The in-app notification is never touched, so
 * a failed email leaves it exactly as it was (FR-NTF-001 AC).
 */
export async function deliverNotifications(options: DeliverOptions = {}): Promise<DeliverResult> {
  const conn = options.conn ?? db;
  const send: EmailSender = options.sender ?? ((message) => sendEmail(message));
  const now = options.now ?? (() => new Date());
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const result: DeliverResult = { claimed: 0, sent: 0, failed: 0, abandoned: 0 };

  const claimTime = now().toISOString();
  const claimed = (
    (await conn.raw(
      `UPDATE notification_deliveries d
          SET attempts = d.attempts + 1,
              next_attempt_at = ?::timestamptz + make_interval(secs => ?)
         FROM (SELECT id FROM notification_deliveries
                WHERE channel = 'email' AND status IN ('pending', 'failed')
                  AND COALESCE(next_attempt_at, created_at) <= ?::timestamptz
                ORDER BY COALESCE(next_attempt_at, created_at), id
                LIMIT ?
                FOR UPDATE SKIP LOCKED) c
        WHERE d.id = c.id
        RETURNING d.id, d.attempts`,
      [claimTime, CLAIM_LEASE_SECONDS, claimTime, batchSize],
    )) as { rows: ClaimedRow[] }
  ).rows;
  result.claimed = claimed.length;
  if (claimed.length === 0) return result;
  const attemptsOf = new Map(claimed.map((r) => [r.id, r.attempts]));

  const work = (await conn('notification_deliveries as d')
    .join('notifications as n', 'n.id', 'd.notification_id')
    .join('auth_users as u', 'u.id', 'n.user_id')
    .leftJoin('profiles as p', 'p.user_id', 'n.user_id')
    .whereIn('d.id', [...attemptsOf.keys()])
    .orderBy('d.id')
    .select('d.id', 'n.event_code', 'n.payload', 'u.email', 'p.language', 'p.erased_at')) as WorkRow[];

  const abandon = async (id: string, reason: string) => {
    await conn('notification_deliveries').where({ id }).update({ status: 'abandoned', last_error: reason, next_attempt_at: null });
    result.abandoned += 1;
  };
  const fail = async (id: string, reason: string) => {
    const attempts = attemptsOf.get(id) ?? MAX_ATTEMPTS;
    if (attempts >= MAX_ATTEMPTS) return abandon(id, reason);
    const wait = BACKOFF_SECONDS[Math.min(attempts, BACKOFF_SECONDS.length) - 1]!;
    await conn('notification_deliveries')
      .where({ id })
      .update({ status: 'failed', last_error: reason, next_attempt_at: new Date(now().getTime() + wait * 1000) });
    result.failed += 1;
  };

  for (const row of work) {
    if (!hasDeliverableEmail(row.email, row.erased_at)) {
      await abandon(row.id, NO_EMAIL_REASON);
      continue;
    }
    try {
      const mail = renderEmail(renderNotification(row.event_code, row.payload, row.language));
      const outcome = await send({ to: row.email!, ...mail, idempotencyKey: `notification-delivery-${row.id}` });
      if (outcome.sent) {
        await conn('notification_deliveries')
          .where({ id: row.id })
          .update({ status: 'sent', sent_at: now(), last_error: null, next_attempt_at: null });
        result.sent += 1;
      } else {
        await fail(row.id, NOT_CONFIGURED_REASON); // the mailer skipped it: no provider is configured
      }
    } catch (err) {
      await fail(row.id, safeErrorReason(err));
    }
  }
  return result;
}
