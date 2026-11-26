import type { Knex } from 'knex';
import db from '../../db/knex.js';
import { withTx } from '../../db/tx.js';
import { writeAudit } from '../../lib/audit.js';
import { conflict, forbidden, notFound } from '../../lib/http-error.js';
import { keysetPage, keysetWhere } from '../../lib/keyset.js';
import { adminRecipients, EVENT_DATA_REQUEST, notifyEach } from '../../lib/notify.js';
import type { AuthContext } from '../../middlewares/auth.js';
import { completeDeletionRequest, type EraseOptions, type ErasureResult } from './erasure.js';
import {
  EXPORT_WINDOW_DAYS,
  type AdminListQuery,
  type CreateRequestInput,
  type RequestStatus,
  type RequestType,
} from './schemas.js';

/**
 * Data subject requests (FR-PRV-002). A user files and follows their own requests; an Admin starts,
 * completes or rejects them. Every transition is a compare-and-swap (`UPDATE ... WHERE status = ...`,
 * zero rows = 409) with its audit row in the same transaction. Audit rows hold ids, types and
 * counts only: never the note, the outcome text, or any other personal value.
 */

export interface OwnRequestItem {
  id: string;
  type: RequestType;
  status: RequestStatus;
  note: string | null;
  requestedAt: string;
  completedAt: Date | null;
  outcome: string | null;
}

const OWN_COLUMNS = ['id', 'request_type', 'status', 'note', 'completed_at', 'outcome'] as const;

type OwnRow = {
  id: string;
  request_type: RequestType;
  status: RequestStatus;
  note: string | null;
  completed_at: Date | null;
  outcome: string | null;
  cursor_t: string;
};

const toOwn = (r: OwnRow): OwnRequestItem => ({
  id: r.id,
  type: r.request_type,
  status: r.status,
  note: r.note,
  requestedAt: r.cursor_t,
  completedAt: r.completed_at,
  outcome: r.outcome,
});

/** A user creates a request. A second OPEN request of the same type is 409 (`ux_dsr_one_open_per_type`). */
export async function createRequest(auth: AuthContext, input: CreateRequestInput): Promise<OwnRequestItem> {
  return withTx(async (trx) => {
    let row: OwnRow;
    try {
      [row] = (await trx('data_subject_requests')
        .insert({ user_id: auth.user.id, request_type: input.type, note: input.note })
        .returning([...OWN_COLUMNS, trx.raw('requested_at::text AS cursor_t')])) as [OwnRow];
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw conflict(`You already have an open ${input.type} request.`, { code: 'REQUEST_ALREADY_OPEN' });
      }
      throw err;
    }
    await writeAudit(trx, {
      actorUserId: auth.user.id,
      actorType: 'user',
      action: 'data_request.create',
      objectType: 'data_subject_request',
      objectId: row.id,
      changes: { type: input.type },
    });
    // N-12: every other Admin is told, the requester gets an acknowledgement.
    const payload = { requestId: row.id, requestType: input.type };
    const admins = (await adminRecipients(trx)).filter((id) => id !== auth.user.id);
    await notifyEach(trx, admins, EVENT_DATA_REQUEST, { ...payload, kind: 'received' });
    await notifyEach(trx, [auth.user.id], EVENT_DATA_REQUEST, { ...payload, kind: 'acknowledged' });
    return toOwn(row);
  });
}

/** The caller's own requests, newest first. Nobody else's are ever read. */
export async function listOwnRequests(
  auth: AuthContext,
  query: { limit: number; cursor: Parameters<typeof keysetWhere>[2] },
): Promise<{ items: OwnRequestItem[]; nextCursor: string | null }> {
  const qb = db('data_subject_requests')
    .where({ user_id: auth.user.id })
    .select(...OWN_COLUMNS, db.raw('requested_at::text AS cursor_t'))
    .orderBy('requested_at', 'desc')
    .orderBy('id', 'desc')
    .limit(query.limit + 1);
  const where = keysetWhere('requested_at', 'id', query.cursor);
  if (where) qb.whereRaw(where[0], where[1]);
  const page = keysetPage((await qb) as OwnRow[], query.limit);
  return { items: page.items.map(toOwn), nextCursor: page.nextCursor };
}

export interface AdminRequestItem extends OwnRequestItem {
  userId: string;
  email: string;
  displayName: string;
  handledBy: string | null;
}

/**
 * The Admin queue: open and in progress by default, oldest first (`ix_dsr_open`). Each page shows the
 * requester's e-mail, name and note, so each page writes ONE `pii.view` audit row in the same
 * transaction, with field names, a count and request ids but no personal value.
 */
export async function listRequests(
  auth: AuthContext,
  query: AdminListQuery,
): Promise<{ items: AdminRequestItem[]; nextCursor: string | null }> {
  return withTx(async (trx) => {
    const qb = trx('data_subject_requests as r')
      .join('auth_users as u', 'u.id', 'r.user_id')
      .join('profiles as p', 'p.user_id', 'r.user_id')
      .select(
        'r.id', 'r.user_id', 'r.request_type', 'r.status', 'r.note', 'r.completed_at', 'r.outcome', 'r.handled_by',
        'u.email', 'p.display_name',
        trx.raw('r.requested_at::text AS cursor_t'),
      )
      .orderBy('r.requested_at', 'asc')
      .orderBy('r.id', 'asc')
      .limit(query.limit + 1);
    if (query.status === null) qb.whereIn('r.status', ['open', 'in_progress']);
    else if (query.status !== 'all') qb.where('r.status', query.status);
    if (query.type) qb.where('r.request_type', query.type);
    const where = keysetWhere('r.requested_at', 'r.id', query.cursor, 'asc');
    if (where) qb.whereRaw(where[0], where[1]);

    const rows = (await qb) as Array<OwnRow & { user_id: string; email: string; display_name: string; handled_by: string | null }>;
    const page = keysetPage(rows, query.limit);
    await writeAudit(trx, {
      actorUserId: auth.user.id,
      actorType: 'staff',
      action: 'pii.view',
      objectType: 'data_subject_request',
      changes: {
        view: 'data_request_list',
        fields: ['email', 'displayName', 'note'],
        count: page.items.length,
        filters: (['status', 'type'] as const).filter((k) => query[k] !== null),
        requestIds: page.items.map((r) => r.id),
      },
    });
    return {
      nextCursor: page.nextCursor,
      items: page.items.map((r) => ({
        ...toOwn(r),
        userId: r.user_id,
        email: r.email,
        displayName: r.display_name,
        handledBy: r.handled_by,
      })),
    };
  });
}

interface RequestRow {
  id: string;
  user_id: string;
  request_type: RequestType;
  status: RequestStatus;
}

/** 404 for an unknown request, 403 when it is the Admin's own (FR-PRV-002: no self-service on one's own data). */
async function loadForAction(conn: Knex | Knex.Transaction, auth: AuthContext, id: string): Promise<RequestRow> {
  const row = (await conn('data_subject_requests')
    .where({ id })
    .first('id', 'user_id', 'request_type', 'status')) as RequestRow | undefined;
  if (!row) throw notFound('Data request not found.', { code: 'REQUEST_NOT_FOUND' });
  if (row.user_id === auth.user.id) {
    throw forbidden('You cannot action a request for your own account.', { code: 'CANNOT_ACTION_OWN_REQUEST' });
  }
  return row;
}

const invalidState = (row: RequestRow, needs: string) =>
  conflict(`This request is ${row.status}; it must be ${needs}.`, { code: 'INVALID_STATE' });

export interface RequestTransitionResult {
  id: string;
  status: RequestStatus;
}

/** open -> in_progress, recording who handles it. */
export async function startRequest(auth: AuthContext, id: string): Promise<RequestTransitionResult> {
  return withTx(async (trx) => {
    const row = await loadForAction(trx, auth, id);
    const updated = await trx('data_subject_requests')
      .where({ id, status: 'open' })
      .update({ status: 'in_progress', handled_by: auth.user.id })
      .returning('id');
    if (updated.length === 0) throw invalidState(row, 'open');
    await writeAudit(trx, {
      actorUserId: auth.user.id,
      actorType: 'staff',
      action: 'data_request.start',
      objectType: 'data_subject_request',
      objectId: id,
      changes: { type: row.request_type, userId: row.user_id },
    });
    return { id, status: 'in_progress' };
  });
}

/** The requester is told in the app and by e-mail, unless the account is already erased. */
async function notifyRequester(trx: Knex.Transaction, row: RequestRow, kind: 'completed' | 'rejected', reason?: string) {
  const profile = (await trx('profiles').where({ user_id: row.user_id }).first('erased_at')) as
    | { erased_at: Date | null }
    | undefined;
  if (!profile || profile.erased_at) return;
  await notifyEach(trx, [row.user_id], EVENT_DATA_REQUEST, {
    requestId: row.id,
    requestType: row.request_type,
    kind,
    ...(reason ? { reason } : {}),
    ...(kind === 'completed' ? { exportDays: EXPORT_WINDOW_DAYS } : {}),
  });
}

/**
 * in_progress -> completed, with the outcome. A `deletion` request runs the erasure (TX-10,
 * `erasure.ts`), which completes the request in its own transaction and sends the e-mail first.
 */
export async function completeRequest(
  auth: AuthContext,
  id: string,
  outcome: string,
  options: EraseOptions = {},
): Promise<RequestTransitionResult & { erasure?: ErasureResult }> {
  const row = await loadForAction(db, auth, id);
  if (row.request_type === 'deletion') {
    const erasure = await completeDeletionRequest(auth, id, outcome, options);
    return { id, status: 'completed', erasure };
  }
  return withTx(async (trx) => {
    const updated = await trx('data_subject_requests')
      .where({ id, status: 'in_progress' })
      .update({ status: 'completed', completed_at: trx.fn.now(), outcome, handled_by: auth.user.id })
      .returning('id');
    if (updated.length === 0) throw invalidState(row, 'in progress');
    await writeAudit(trx, {
      actorUserId: auth.user.id,
      actorType: 'staff',
      action: 'data_request.complete',
      objectType: 'data_subject_request',
      objectId: id,
      changes: { type: row.request_type, userId: row.user_id },
    });
    await notifyRequester(trx, row, 'completed');
    return { id, status: 'completed' as const };
  });
}

/** open or in_progress -> rejected, with the reason (the outcome text) shown to the requester. */
export async function rejectRequest(auth: AuthContext, id: string, outcome: string): Promise<RequestTransitionResult> {
  return withTx(async (trx) => {
    const row = await loadForAction(trx, auth, id);
    const updated = await trx('data_subject_requests')
      .where({ id })
      .whereIn('status', ['open', 'in_progress'])
      .update({ status: 'rejected', completed_at: trx.fn.now(), outcome, handled_by: auth.user.id })
      .returning('id');
    if (updated.length === 0) throw invalidState(row, 'open or in progress');
    await writeAudit(trx, {
      actorUserId: auth.user.id,
      actorType: 'staff',
      action: 'data_request.reject',
      objectType: 'data_subject_request',
      objectId: id,
      changes: { type: row.request_type, userId: row.user_id },
    });
    await notifyRequester(trx, row, 'rejected', outcome);
    return { id, status: 'rejected' as const };
  });
}
