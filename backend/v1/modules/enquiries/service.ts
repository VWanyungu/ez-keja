import type { Knex } from 'knex';
import db from '../../db/knex.js';
import { withTx } from '../../db/tx.js';
import { writeAudit } from '../../lib/audit.js';
import { assertOpenForContact, isMaintainerOf, lockSpaceTypeContext, preview } from '../../lib/engagement.js';
import { conflict, forbidden, notFound } from '../../lib/http-error.js';
import { keysetPage, keysetWhere } from '../../lib/keyset.js';
import {
  EVENT_ENQUIRY_REPLY,
  EVENT_NEW_ENQUIRY_MESSAGE,
  maintainerRecipients,
  notifyEach,
} from '../../lib/notify.js';
import type { AuthContext } from '../../middlewares/auth.js';
import type { EnquiryStatus, ListEnquiriesQuery, MessageInput } from './schemas.js';

type Conn = Knex | Knex.Transaction;

interface ThreadRow {
  id: string;
  space_type_id: string;
  space_type_name: string;
  building_id: string;
  building_name: string;
  client_id: string;
  client_display_name: string;
  status: EnquiryStatus;
  closed_reason: string | null;
  closed_at: Date | null;
  first_response_at: Date | null;
  last_message_at: Date;
  created_at: Date;
}

const THREAD_SQL = `
  SELECT e.id, e.space_type_id, st.name AS space_type_name, b.id AS building_id, b.name AS building_name,
         e.client_id, cp.display_name AS client_display_name, e.status, e.closed_reason, e.closed_at,
         e.first_response_at, e.last_message_at, e.created_at
    FROM enquiries e
    JOIN space_types st ON st.id = e.space_type_id
    JOIN buildings b ON b.id = st.building_id
    LEFT JOIN profiles cp ON cp.user_id = e.client_id
   WHERE e.id = ?`;

const loadThread = async (conn: Conn, id: string, lock = false): Promise<ThreadRow | undefined> =>
  ((await conn.raw(lock ? `${THREAD_SQL} FOR UPDATE OF e` : THREAD_SQL, [id])) as { rows: ThreadRow[] }).rows[0];

const threadNotFound = () => notFound('Enquiry not found.', { code: 'ENQUIRY_NOT_FOUND' });

interface Relation {
  isClient: boolean;
  isMaintainer: boolean;
  /** An Admin who is neither the client nor a maintainer: acts as staff, and every read is audited. */
  isStaffOnly: boolean;
}

/**
 * NFR-PRV-02: a client sees only their own threads, a maintainer only threads on buildings they
 * maintain, an Admin any. Everyone else gets the same 404 as for an enquiry that does not exist, so
 * a stranger cannot probe for ids.
 */
async function relationOf(conn: Conn, auth: AuthContext, thread: ThreadRow): Promise<Relation> {
  const isClient = thread.client_id === auth.user.id;
  const isMaintainer = await isMaintainerOf(conn, thread.building_id, auth.user.id);
  const isAdmin = auth.roles.includes('admin');
  if (!isClient && !isMaintainer && !isAdmin) throw threadNotFound();
  return { isClient, isMaintainer, isStaffOnly: isAdmin && !isClient && !isMaintainer };
}

async function insertMessage(
  trx: Knex.Transaction,
  enquiryId: string,
  senderId: string,
  body: string,
): Promise<{ id: string; createdAt: Date }> {
  const [row] = (await trx('enquiry_messages')
    .insert({ enquiry_id: enquiryId, sender_id: senderId, body, created_at: trx.raw('clock_timestamp()') })
    .returning(['id', 'created_at'])) as Array<{ id: string; created_at: Date }>;
  return { id: row!.id, createdAt: row!.created_at };
}

export interface PostedMessage {
  enquiryId: string;
  /** True when this message opened a new thread. */
  newThread: boolean;
  status: EnquiryStatus;
  message: { id: string; body: string; createdAt: Date };
}

/**
 * TX-06 / FR-ENQ-001: a logged-in user starts, or continues, their one open thread about a space
 * type. The space type is read `FOR SHARE` first, so a Fully-let or removal cannot land between the
 * check and the insert. The upsert repeats the partial-index predicate as an inlined literal
 * (design §7.4); `xmax = 0` tells an insert from an update. The message and the N-05 rows are in
 * the same transaction.
 */
export async function startOrContinueEnquiry(auth: AuthContext, spaceTypeId: string, input: MessageInput): Promise<PostedMessage> {
  return withTx(async (trx) => {
    const ctx = await lockSpaceTypeContext(trx, spaceTypeId);
    assertOpenForContact(ctx, 'enquiry');
    if (await isMaintainerOf(trx, ctx.buildingId, auth.user.id)) {
      throw forbidden('You maintain this building, so you cannot send an enquiry about it.', { code: 'OWN_BUILDING' });
    }

    const { rows } = (await trx.raw(
      `INSERT INTO enquiries (space_type_id, client_id, last_message_at)
       VALUES (?, ?, clock_timestamp())
       ON CONFLICT (client_id, space_type_id) WHERE status <> 'closed'
       DO UPDATE SET last_message_at = clock_timestamp()
       RETURNING id, status, (xmax = 0) AS inserted`,
      [spaceTypeId, auth.user.id],
    )) as { rows: Array<{ id: string; status: EnquiryStatus; inserted: boolean }> };
    const enquiry = rows[0]!;
    const message = await insertMessage(trx, enquiry.id, auth.user.id, input.body);

    await notifyEach(trx, await maintainerRecipients(trx, ctx.buildingId), EVENT_NEW_ENQUIRY_MESSAGE, {
      enquiryId: enquiry.id,
      spaceTypeId,
      spaceTypeName: ctx.name,
      buildingId: ctx.buildingId,
      buildingName: ctx.buildingName,
      newThread: enquiry.inserted,
    });
    return {
      enquiryId: enquiry.id,
      newThread: enquiry.inserted,
      status: enquiry.status,
      message: { id: message.id, body: input.body, createdAt: message.createdAt },
    };
  });
}

/**
 * FR-ENQ-001 / FR-ENQ-005: add a message to an existing thread. The first message from someone
 * other than the client sets `first_response_at` and moves `new` to `responded` (TX-06); later
 * client messages leave the status alone ("awaiting reply" = `status = 'new'`, Q-D7). A closed thread
 * takes no messages. A client cannot continue a thread about a space type that is no longer Vacant
 * or listed; that case closes the thread anyway, so the check mostly guards Suspended buildings.
 */
export async function addMessage(auth: AuthContext, enquiryId: string, input: MessageInput): Promise<PostedMessage> {
  const probe = await loadThread(db, enquiryId);
  if (!probe) throw threadNotFound();
  const relation = await relationOf(db, auth, probe); // before any lock, so a stranger waits for nothing

  return withTx(async (trx) => {
    const ctx = await lockSpaceTypeContext(trx, probe.space_type_id); // lock order: space type, then the thread
    const thread = (await loadThread(trx, enquiryId, true)) ?? probe;
    if (thread.status === 'closed') throw conflict('This conversation is closed.', { code: 'ENQUIRY_CLOSED' });
    if (relation.isClient) assertOpenForContact(ctx, 'enquiry');

    const message = await insertMessage(trx, enquiryId, auth.user.id, input.body);
    const payload = {
      enquiryId,
      spaceTypeId: thread.space_type_id,
      spaceTypeName: thread.space_type_name,
      buildingId: thread.building_id,
      buildingName: thread.building_name,
    };
    let status: EnquiryStatus = thread.status;
    if (relation.isClient) {
      await trx('enquiries').where({ id: enquiryId }).update({ last_message_at: trx.raw('clock_timestamp()') });
      await notifyEach(trx, await maintainerRecipients(trx, thread.building_id), EVENT_NEW_ENQUIRY_MESSAGE, {
        ...payload,
        newThread: false,
      });
    } else {
      const updated = (await trx.raw(
        `UPDATE enquiries
            SET first_response_at = COALESCE(first_response_at, clock_timestamp()),
                status = CASE WHEN status = 'new' THEN 'responded' ELSE status END,
                last_message_at = clock_timestamp()
          WHERE id = ? RETURNING status`,
        [enquiryId],
      )) as { rows: Array<{ status: EnquiryStatus }> };
      status = updated.rows[0]!.status;
      await notifyEach(trx, [thread.client_id], EVENT_ENQUIRY_REPLY, payload);
      if (relation.isStaffOnly) {
        await writeAudit(trx, {
          actorUserId: auth.user.id,
          actorType: 'staff',
          action: 'enquiry.reply',
          objectType: 'enquiry',
          objectId: enquiryId,
          buildingId: thread.building_id,
        });
      }
    }
    return { enquiryId, newThread: false, status, message: { id: message.id, body: input.body, createdAt: message.createdAt } };
  });
}

export interface EnquirySummary {
  id: string;
  status: EnquiryStatus;
  /** The caller's side of this thread. */
  role: 'client' | 'maintainer';
  spaceType: { id: string; name: string };
  building: { id: string; name: string };
  client: { id: string; displayName: string };
  firstResponseAt: Date | null;
  lastMessageAt: Date;
  createdAt: Date;
  lastMessage: { senderId: string; preview: string } | null;
}

interface ListRow {
  id: string;
  status: EnquiryStatus;
  as_client: boolean;
  space_type_id: string;
  space_type_name: string;
  building_id: string;
  building_name: string;
  client_id: string;
  client_display_name: string | null;
  first_response_at: Date | null;
  last_message_at: Date;
  created_at: Date;
  cursor_t: string;
  last_sender_id: string | null;
  last_body: string | null;
}

/**
 * FR-ENQ-001: "my" threads, as the client or as a maintainer of the building, most recently active
 * first. An Admin sees their own threads here like anyone else (reading others' is `GET /enquiries/:id`,
 * which is audited). Keyset-paged on `(last_message_at, id)`: the inbox order is the one that matters.
 */
export async function listEnquiries(
  auth: AuthContext,
  { limit, cursor, status, as }: ListEnquiriesQuery,
): Promise<{ items: EnquirySummary[]; nextCursor: string | null }> {
  const me = auth.user.id;
  const maintains = 'EXISTS (SELECT 1 FROM building_maintainers m WHERE m.building_id = b.id AND m.user_id = ?)';
  const conditions: string[] = [];
  const bindings: Array<string | number> = [];
  if (as === 'client') {
    conditions.push('e.client_id = ?');
    bindings.push(me);
  } else if (as === 'maintainer') {
    conditions.push(maintains);
    bindings.push(me);
  } else {
    conditions.push(`(e.client_id = ? OR ${maintains})`);
    bindings.push(me, me);
  }
  if (status) {
    conditions.push('e.status = ?');
    bindings.push(status);
  }
  const where = keysetWhere('e.last_message_at', 'e.id', cursor);
  if (where) {
    conditions.push(where[0]);
    bindings.push(...where[1]);
  }

  const { rows } = (await db.raw(
    `SELECT e.id, e.status, (e.client_id = ?) AS as_client, e.space_type_id, st.name AS space_type_name,
            b.id AS building_id, b.name AS building_name, e.client_id, cp.display_name AS client_display_name,
            e.first_response_at, e.last_message_at, e.created_at, e.last_message_at::text AS cursor_t,
            lm.sender_id AS last_sender_id, lm.body AS last_body
       FROM enquiries e
       JOIN space_types st ON st.id = e.space_type_id
       JOIN buildings b ON b.id = st.building_id
       LEFT JOIN profiles cp ON cp.user_id = e.client_id
       LEFT JOIN LATERAL (SELECT sender_id, body FROM enquiry_messages
                           WHERE enquiry_id = e.id ORDER BY created_at DESC, id DESC LIMIT 1) lm ON true
      WHERE ${conditions.join(' AND ')}
      ORDER BY e.last_message_at DESC, e.id DESC
      LIMIT ?`,
    [me, ...bindings, limit + 1],
  )) as { rows: ListRow[] };

  const page = keysetPage(rows, limit);
  return {
    nextCursor: page.nextCursor,
    items: page.items.map((r) => ({
      id: r.id,
      status: r.status,
      role: r.as_client ? 'client' : 'maintainer',
      spaceType: { id: r.space_type_id, name: r.space_type_name },
      building: { id: r.building_id, name: r.building_name },
      client: { id: r.client_id, displayName: r.client_display_name ?? 'Deleted user' },
      firstResponseAt: r.first_response_at,
      lastMessageAt: r.last_message_at,
      createdAt: r.created_at,
      lastMessage: r.last_sender_id && r.last_body ? { senderId: r.last_sender_id, preview: preview(r.last_body) } : null,
    })),
  };
}

export interface EnquiryDetail extends Omit<EnquirySummary, 'role' | 'lastMessage'> {
  role: 'client' | 'maintainer' | 'staff';
  closedReason: string | null;
  closedAt: Date | null;
  messages: Array<{
    id: string;
    senderId: string;
    senderDisplayName: string;
    fromClient: boolean;
    body: string;
    createdAt: Date;
  }>;
}

/**
 * FR-ENQ-001 / NFR-PRV-02: the whole thread. An Admin who is neither the client nor a maintainer may
 * read it, and each such read writes a `pii.view` audit row in the same transaction (design §10.1).
 *
 * shortcut: the thread comes back unpaged; threads are a handful of messages. Add keyset paging on
 * `(created_at, id)` if a thread ever grows past a few hundred.
 */
export async function getEnquiry(auth: AuthContext, enquiryId: string): Promise<EnquiryDetail> {
  return withTx(async (trx) => {
    const thread = await loadThread(trx, enquiryId);
    if (!thread) throw threadNotFound();
    const relation = await relationOf(trx, auth, thread);
    const messages = (await trx('enquiry_messages as m')
      .leftJoin('profiles as p', 'p.user_id', 'm.sender_id')
      .where('m.enquiry_id', enquiryId)
      .orderBy('m.created_at')
      .orderBy('m.id')
      .select('m.id', 'm.sender_id', 'm.body', 'm.created_at', 'p.display_name')) as Array<{
      id: string;
      sender_id: string;
      body: string;
      created_at: Date;
      display_name: string | null;
    }>;
    if (relation.isStaffOnly) {
      await writeAudit(trx, {
        actorUserId: auth.user.id,
        actorType: 'staff',
        action: 'pii.view',
        objectType: 'enquiry',
        objectId: enquiryId,
        buildingId: thread.building_id,
        changes: { fields: ['enquiry_messages.body', 'client'], messages: messages.length },
      });
    }
    return {
      id: thread.id,
      status: thread.status,
      role: relation.isClient ? 'client' : relation.isMaintainer ? 'maintainer' : 'staff',
      spaceType: { id: thread.space_type_id, name: thread.space_type_name },
      building: { id: thread.building_id, name: thread.building_name },
      client: { id: thread.client_id, displayName: thread.client_display_name ?? 'Deleted user' },
      firstResponseAt: thread.first_response_at,
      lastMessageAt: thread.last_message_at,
      createdAt: thread.created_at,
      closedReason: thread.closed_reason,
      closedAt: thread.closed_at,
      messages: messages.map((m) => ({
        id: m.id,
        senderId: m.sender_id,
        senderDisplayName: m.display_name ?? 'Deleted user',
        fromClient: m.sender_id === thread.client_id,
        body: m.body,
        createdAt: m.created_at,
      })),
    };
  });
}

/**
 * FR-ENQ-005: the client or a maintainer (or an Admin acting for them) closes a thread. A
 * compare-and-swap on the status, so closing twice, or racing a Fully-let that already closed it,
 * is a clean 409.
 */
export async function closeEnquiry(auth: AuthContext, enquiryId: string): Promise<{ id: string; status: 'closed'; closedAt: Date }> {
  return withTx(async (trx) => {
    const thread = await loadThread(trx, enquiryId);
    if (!thread) throw threadNotFound();
    const relation = await relationOf(trx, auth, thread);
    const rows = (await trx('enquiries')
      .where({ id: enquiryId })
      .whereNot({ status: 'closed' })
      .update({ status: 'closed', closed_reason: 'manual', closed_at: trx.fn.now() })
      .returning('closed_at')) as Array<{ closed_at: Date }>;
    if (!rows[0]) throw conflict('This conversation is already closed.', { code: 'ENQUIRY_CLOSED' });
    if (relation.isStaffOnly) {
      await writeAudit(trx, {
        actorUserId: auth.user.id,
        actorType: 'staff',
        action: 'enquiry.close',
        objectType: 'enquiry',
        objectId: enquiryId,
        buildingId: thread.building_id,
      });
    }
    return { id: enquiryId, status: 'closed', closedAt: rows[0].closed_at };
  });
}
