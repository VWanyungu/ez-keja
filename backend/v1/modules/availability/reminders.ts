import type { Knex } from 'knex';
import db from '../../db/knex.js';
import { withTx } from '../../db/tx.js';
import { isoMicros } from '../../lib/freshness.js';

/** N-04 "Update reminder" (SRS §10.2). */
export const REMINDER_EVENT_CODE = 'N-04';
/** Owner decision: notifications are email only (plus the in-app list). Phase 9 sends the email. */
const DELIVERY_CHANNELS = ['email'] as const;

export interface RemindersOptions {
  conn?: Knex;
}

export interface RemindersResult {
  /** Space types that were due a reminder and not yet logged for their cycle. */
  due: number;
  /** `reminder_log` rows this run won (a row is won only by the run that inserts it). */
  logged: number;
  notificationsCreated: number;
  /** Logged space types whose building has no active maintainer: flagged in the follow-up queue. */
  withoutRecipient: number;
}

interface DueRow {
  id: string;
  building_id: string;
  building_name: string;
  lister_id: string;
  name: string;
  vacant_count: number;
  cycle_text: string;
  last_confirmed_at: string;
  age_days: number;
  seq: number;
}

/**
 * BR-010: which reminder is due, as `reminder_log.seq` (design §5.3, review R-18).
 *   seq 0  from `freshness_days - reminder_lead_days` of age, up to the threshold itself;
 *   seq 1  once the label appears (age strictly over `freshness_days`);
 *   seq n  every `reminder_repeat_days` after that while it stays unconfirmed.
 * Only the latest due `seq` is considered, so a job that was down logs one reminder, not a burst.
 * Fully let, removed and unpublished (Draft, Pending, Suspended, Withdrawn) space types are
 * never due (BR-030, design QP-05). `FOR UPDATE OF st SKIP LOCKED`: a space type that someone is
 * confirming right now is left alone, and a second runner never waits on, or repeats, this one.
 */
const DUE_SQL = `
  SELECT st.id, st.building_id, b.name AS building_name, b.lister_id, st.name, st.vacant_count,
         st.last_confirmed_at::text AS cycle_text,
         ${isoMicros('st.last_confirmed_at')} AS last_confirmed_at,
         age.days AS age_days, due.seq
    FROM space_types st
    JOIN buildings b ON b.id = st.building_id AND b.status = 'published'
    CROSS JOIN (
      SELECT max(value) FILTER (WHERE key = 'freshness_days') AS threshold,
             max(value) FILTER (WHERE key = 'reminder_lead_days') AS lead,
             max(value) FILTER (WHERE key = 'reminder_repeat_days') AS repeat
        FROM settings
       WHERE key IN ('freshness_days', 'reminder_lead_days', 'reminder_repeat_days')
    ) s
    CROSS JOIN LATERAL (
      SELECT extract(epoch FROM (clock_timestamp() - st.last_confirmed_at)) / 86400.0 AS days
    ) age
    CROSS JOIN LATERAL (
      SELECT CASE
               WHEN age.days > s.threshold THEN 1 + floor((age.days - s.threshold) / s.repeat)::int
               WHEN s.threshold - s.lead > 0 AND age.days >= s.threshold - s.lead THEN 0
             END AS seq
    ) due
   WHERE st.vacant_count > 0 AND st.removed_at IS NULL AND due.seq IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM reminder_log rl
        WHERE rl.space_type_id = st.id AND rl.cycle_confirmed_at = st.last_confirmed_at AND rl.seq = due.seq)
   ORDER BY st.id
   FOR UPDATE OF st SKIP LOCKED`;

/**
 * TX-08 / FR-AVL-006: send each maintainer ONE combined N-04 notification covering every one of
 * their space types that reached a reminder point. Idempotent and safe to run twice or on two
 * PM2 instances: the candidate rows are locked with SKIP LOCKED, and the unique
 * `(space_type_id, cycle_confirmed_at, seq)` key plus `ON CONFLICT DO NOTHING RETURNING id` means
 * a notification is created only for the log rows this run actually inserted.
 *
 * It writes the `notifications` row and a pending `notification_deliveries` row per channel; the
 * email sender (Phase 9) reads those. Everything is one transaction, so a failure leaves no log
 * row behind and the next run tries again.
 *
 * shortcut: one transaction for the whole scan (about 100 stale rows a day at design volumes);
 * batch it if a scan ever takes seconds, keeping a lister's space types in the same batch.
 */
export async function sendReminders(options: RemindersOptions = {}): Promise<RemindersResult> {
  return withTx(async (trx) => {
    const due = ((await trx.raw(DUE_SQL)) as { rows: DueRow[] }).rows;
    const result: RemindersResult = { due: due.length, logged: 0, notificationsCreated: 0, withoutRecipient: 0 };
    if (due.length === 0) return result;

    // Win each (space type, cycle, seq) before telling anyone about it.
    const won: Array<{ row: DueRow; logId: string }> = [];
    for (const row of due) {
      const inserted = (await trx('reminder_log')
        .insert({
          space_type_id: row.id,
          cycle_confirmed_at: trx.raw('?::timestamptz', [row.cycle_text]),
          seq: row.seq,
        })
        .onConflict(['space_type_id', 'cycle_confirmed_at', 'seq'])
        .ignore()
        .returning('id')) as Array<{ id: string }>;
      if (inserted[0]) won.push({ row, logId: inserted[0].id });
    }
    result.logged = won.length;
    if (won.length === 0) return result;

    const maintainers = (await trx('building_maintainers as m')
      .join('profiles as p', 'p.user_id', 'm.user_id')
      .where('p.account_status', 'active')
      .whereNull('p.erased_at')
      .whereIn('m.building_id', [...new Set(won.map((w) => w.row.building_id))])
      .select('m.building_id', 'm.user_id')) as Array<{ building_id: string; user_id: string }>;
    const recipientsOf = new Map<string, string[]>();
    for (const m of maintainers) {
      recipientsOf.set(m.building_id, [...(recipientsOf.get(m.building_id) ?? []), m.user_id].sort());
    }

    const itemsByUser = new Map<string, DueRow[]>();
    for (const { row } of won) {
      const recipients = recipientsOf.get(row.building_id) ?? [];
      if (recipients.length === 0) result.withoutRecipient += 1;
      for (const userId of recipients) itemsByUser.set(userId, [...(itemsByUser.get(userId) ?? []), row]);
    }

    const notificationOf = new Map<string, string>();
    for (const userId of [...itemsByUser.keys()].sort()) {
      const items = itemsByUser.get(userId)!;
      const [notification] = (await trx('notifications')
        .insert({
          user_id: userId,
          event_code: REMINDER_EVENT_CODE,
          payload: JSON.stringify({
            count: items.length,
            spaceTypes: items.map((r) => ({
              spaceTypeId: r.id,
              name: r.name,
              buildingId: r.building_id,
              buildingName: r.building_name,
              vacantCount: r.vacant_count,
              lastConfirmedAt: r.last_confirmed_at,
              daysSinceConfirmed: Math.floor(Number(r.age_days)),
              reminderSeq: r.seq,
              outdated: r.seq >= 1,
            })),
          }),
        })
        .returning('id')) as Array<{ id: string }>;
      await trx('notification_deliveries').insert(
        DELIVERY_CHANNELS.map((channel) => ({ notification_id: notification!.id, channel, status: 'pending' })),
      );
      notificationOf.set(userId, notification!.id);
      result.notificationsCreated += 1;
    }

    // Each log row points at one notification: the lister's when they maintain the building,
    // otherwise the first maintainer's (design §5.3 allows a single shared notification_id).
    for (const { row, logId } of won) {
      const recipients = recipientsOf.get(row.building_id) ?? [];
      const owner = recipients.includes(row.lister_id) ? row.lister_id : recipients[0];
      if (owner) await trx('reminder_log').where({ id: logId }).update({ notification_id: notificationOf.get(owner) });
    }
    return result;
  }, options.conn ?? db);
}
