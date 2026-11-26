import db from '../../db/knex.js';
import { keysetPage, keysetWhere } from '../../lib/keyset.js';
import { notFound } from '../../lib/http-error.js';
import type { AuthContext } from '../../middlewares/auth.js';
import type { ListNotificationsQuery } from './schemas.js';
import { renderNotification } from './templates.js';

export interface NotificationItem {
  id: string;
  eventCode: string;
  /** Rendered in the recipient's language (FR-LOC-001). */
  title: string;
  body: string;
  /** Ids and public names only (design §5.5). */
  payload: Record<string, unknown>;
  read: boolean;
  readAt: Date | null;
  createdAt: Date;
}

interface Row {
  id: string;
  event_code: string;
  payload: Record<string, unknown>;
  read_at: Date | null;
  created_at: Date;
  cursor_t: string;
}

/** FR-NTF-001: the caller's own notifications, newest first. Only `user_id = caller` rows are ever read. */
export async function listNotifications(
  auth: AuthContext,
  { limit, cursor, unreadOnly }: ListNotificationsQuery,
): Promise<{ items: NotificationItem[]; nextCursor: string | null }> {
  const query = db('notifications')
    .where({ user_id: auth.user.id })
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit + 1)
    .select('id', 'event_code', 'payload', 'read_at', 'created_at', db.raw('created_at::text AS cursor_t'));
  if (unreadOnly) query.whereNull('read_at');
  const where = keysetWhere('created_at', 'id', cursor);
  if (where) query.whereRaw(where[0], where[1]);

  const page = keysetPage((await query) as Row[], limit);
  return {
    nextCursor: page.nextCursor,
    items: page.items.map((row) => ({
      id: row.id,
      eventCode: row.event_code,
      ...renderNotification(row.event_code, row.payload, auth.profile.language),
      payload: row.payload,
      read: row.read_at !== null,
      readAt: row.read_at,
      createdAt: row.created_at,
    })),
  };
}

/** The unread badge. Uses `ix_notif_unread`. */
export async function unreadCount(auth: AuthContext): Promise<{ count: number }> {
  const row = (await db('notifications').where({ user_id: auth.user.id }).whereNull('read_at').count('* as n').first()) as
    | { n: string | number }
    | undefined;
  return { count: Number(row?.n ?? 0) };
}

/** Marks one of the caller's notifications read. Idempotent; somebody else's id is a 404, not a 403. */
export async function markRead(auth: AuthContext, id: string): Promise<{ id: string; readAt: Date }> {
  const rows = (await db('notifications')
    .where({ id, user_id: auth.user.id })
    .update({ read_at: db.raw('COALESCE(read_at, now())') })
    .returning(['id', 'read_at'])) as Array<{ id: string; read_at: Date }>;
  if (!rows[0]) throw notFound('Notification not found.', { code: 'NOTIFICATION_NOT_FOUND' });
  return { id: rows[0].id, readAt: rows[0].read_at };
}

/** Marks every unread notification of the caller read, and nobody else's. */
export async function markAllRead(auth: AuthContext): Promise<{ updated: number }> {
  const updated = await db('notifications').where({ user_id: auth.user.id }).whereNull('read_at').update({ read_at: db.fn.now() });
  return { updated };
}
