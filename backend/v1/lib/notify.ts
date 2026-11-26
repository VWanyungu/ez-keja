import type { Knex } from 'knex';

/** Owner decision: notifications are email only (plus the in-app list). Phase 9 sends the email. */
const DELIVERY_CHANNELS = ['email'] as const;

export interface NotificationInput {
  userId: string;
  /** SRS §10.2 event code, `N-01` to `N-14`. */
  eventCode: string;
  payload: Record<string, unknown>;
}

/**
 * Writes `notifications` rows and one pending `notification_deliveries` row per channel, exactly as
 * the reminder job does (`modules/availability/reminders.ts`). Rows only: the email sender and the
 * in-app list are Phase 9. Call inside the caller's transaction so they commit with the change.
 */
export async function createNotifications(
  trx: Knex.Transaction,
  items: readonly NotificationInput[],
): Promise<number> {
  if (items.length === 0) return 0;
  const rows = (await trx('notifications')
    .insert(
      items.map((item) => ({
        user_id: item.userId,
        event_code: item.eventCode,
        payload: JSON.stringify(item.payload),
      })),
    )
    .returning('id')) as Array<{ id: string }>;
  await trx('notification_deliveries').insert(
    rows.flatMap((row) => DELIVERY_CHANNELS.map((channel) => ({ notification_id: row.id, channel, status: 'pending' }))),
  );
  return rows.length;
}

/** The building's maintainers whose account is active and not erased, ordered for stable output. */
export async function maintainerRecipients(trx: Knex.Transaction, buildingId: string): Promise<string[]> {
  const rows = (await trx('building_maintainers as m')
    .join('profiles as p', 'p.user_id', 'm.user_id')
    .where('m.building_id', buildingId)
    .where('p.account_status', 'active')
    .whereNull('p.erased_at')
    .orderBy('m.user_id')
    .select('m.user_id')) as Array<{ user_id: string }>;
  return rows.map((r) => r.user_id);
}

/** There is no per-admin recipient list (SRS §10.2): every active Admin is told. */
export async function adminRecipients(trx: Knex.Transaction): Promise<string[]> {
  const rows = (await trx('user_roles as r')
    .join('profiles as p', 'p.user_id', 'r.user_id')
    .where('r.role', 'admin')
    .where('p.account_status', 'active')
    .whereNull('p.erased_at')
    .orderBy('r.user_id')
    .select('r.user_id')) as Array<{ user_id: string }>;
  return rows.map((r) => r.user_id);
}

/** SRS §10.2 event codes written by Phase 9. */
export const EVENT_NEW_ENQUIRY_MESSAGE = 'N-05';
export const EVENT_ENQUIRY_REPLY = 'N-06';
export const EVENT_VIEWING = 'N-07';
export const EVENT_SPACE_TYPE_UNAVAILABLE = 'N-08';
export const EVENT_REPORT_RECEIVED = 'N-09';
export const EVENT_MAPS_USAGE = 'N-11';

/**
 * Tells every active Admin about `eventCode` at most once per `dedupeKey` (for N-11: threshold and
 * UTC day). The key is stored in the payload, so no schema change is needed; a transaction-scoped
 * advisory lock makes the check-then-insert safe across PM2 instances. Returns the number of rows
 * written (0 when this key was already announced).
 */
export async function notifyAdminsOnce(
  trx: Knex.Transaction,
  eventCode: string,
  dedupeKey: string,
  payload: Record<string, unknown>,
): Promise<number> {
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`notify-once:${eventCode}`]);
  const seen = await trx('notifications')
    .where({ event_code: eventCode })
    .whereRaw("payload->>'dedupeKey' = ?", [dedupeKey])
    .first('id');
  if (seen) return 0;
  return notifyEach(trx, await adminRecipients(trx), eventCode, { ...payload, dedupeKey });
}

/** Same notification to several users, each at most once. */
export const notifyEach = (
  trx: Knex.Transaction,
  userIds: readonly string[],
  eventCode: string,
  payload: Record<string, unknown>,
): Promise<number> =>
  createNotifications(
    trx,
    [...new Set(userIds)].sort().map((userId) => ({ userId, eventCode, payload })),
  );
