import db from '../../db/knex.js';
import { withTx } from '../../db/tx.js';
import { writeAudit } from '../../lib/audit.js';
import { assertOpenForContact, isMaintainerOf, lockSpaceTypeContext } from '../../lib/engagement.js';
import { conflict, forbidden, notFound } from '../../lib/http-error.js';
import { keysetPage, keysetWhere } from '../../lib/keyset.js';
import { EVENT_VIEWING, maintainerRecipients, notifyEach } from '../../lib/notify.js';
import type { AuthContext } from '../../middlewares/auth.js';
import type { ListViewingsQuery, ViewingStatus } from './schemas.js';

/** Who may take each transition (FR-ENQ-002) and what it does. TX-07: every one is a compare-and-swap. */
export type ViewingAction = 'accept' | 'decline' | 'counter' | 'accept-counter' | 'decline-counter' | 'cancel';

interface Transition {
  actor: 'client' | 'maintainer';
  from: readonly ViewingStatus[];
  /** The proposed or agreed time must still be ahead (`COALESCE(counter_for, requested_for) > now()`). */
  needsFutureTime: boolean;
  /** `kind` in the N-07 payload, and who is told. */
  kind: string;
  tell: 'client' | 'maintainers';
}

const TRANSITIONS: Record<ViewingAction, Transition> = {
  accept: { actor: 'maintainer', from: ['requested'], needsFutureTime: true, kind: 'accepted', tell: 'client' },
  decline: { actor: 'maintainer', from: ['requested'], needsFutureTime: false, kind: 'declined', tell: 'client' },
  counter: { actor: 'maintainer', from: ['requested'], needsFutureTime: false, kind: 'counter_proposed', tell: 'client' },
  'accept-counter': { actor: 'client', from: ['counter_proposed'], needsFutureTime: true, kind: 'counter_accepted', tell: 'maintainers' },
  'decline-counter': { actor: 'client', from: ['counter_proposed'], needsFutureTime: false, kind: 'counter_declined', tell: 'maintainers' },
  cancel: { actor: 'client', from: ['requested', 'accepted', 'counter_proposed'], needsFutureTime: false, kind: 'cancelled', tell: 'maintainers' },
};

interface ViewingRow {
  id: string;
  status: ViewingStatus;
  client_id: string;
  space_type_id: string;
  space_type_name: string;
  building_id: string;
  building_name: string;
  requested_for: Date;
  counter_for: Date | null;
}

export interface ViewingResult {
  id: string;
  status: ViewingStatus;
  requestedFor: Date;
  counterFor: Date | null;
  /** The time both sides see once accepted: the counter-proposal if there was one. */
  agreedFor: Date | null;
}

const toResult = (r: {
  id: string;
  status: ViewingStatus;
  requested_for: Date;
  counter_for: Date | null;
}): ViewingResult => ({
  id: r.id,
  status: r.status,
  requestedFor: r.requested_for,
  counterFor: r.counter_for,
  agreedFor: r.status === 'accepted' ? (r.counter_for ?? r.requested_for) : null,
});

/** FR-ENQ-002: a logged-in user asks to view a Vacant space type at a future time; the maintainers are told (N-07). */
export async function requestViewing(auth: AuthContext, spaceTypeId: string, input: { requestedFor: string }): Promise<ViewingResult> {
  return withTx(async (trx) => {
    const ctx = await lockSpaceTypeContext(trx, spaceTypeId);
    assertOpenForContact(ctx, 'viewing request');
    if (await isMaintainerOf(trx, ctx.buildingId, auth.user.id)) {
      throw forbidden('You maintain this building, so you cannot request a viewing of it.', { code: 'OWN_BUILDING' });
    }
    const [row] = (await trx('viewing_requests')
      .insert({ space_type_id: spaceTypeId, client_id: auth.user.id, requested_for: input.requestedFor })
      .returning(['id', 'status', 'requested_for', 'counter_for'])) as Array<Parameters<typeof toResult>[0]>;
    await notifyEach(trx, await maintainerRecipients(trx, ctx.buildingId), EVENT_VIEWING, {
      viewingId: row!.id,
      kind: 'requested',
      spaceTypeId,
      spaceTypeName: ctx.name,
      buildingId: ctx.buildingId,
      buildingName: ctx.buildingName,
      proposedFor: input.requestedFor,
    });
    return toResult(row!);
  });
}

const VIEWING_SQL = `
  SELECT v.id, v.status, v.client_id, v.space_type_id, st.name AS space_type_name,
         b.id AS building_id, b.name AS building_name, v.requested_for, v.counter_for
    FROM viewing_requests v
    JOIN space_types st ON st.id = v.space_type_id
    JOIN buildings b ON b.id = st.building_id
   WHERE v.id = ?`;

/**
 * TX-07 / FR-ENQ-002. The caller must be a party to the viewing (anyone else gets a 404, like an
 * unknown id) and on the right side for this action (403). Then one `UPDATE ... WHERE id AND status
 * IN (<expected>)`: zero rows means the other party, the expiry job or a Fully-let got there first,
 * which is a 409, never a double transition. The notification and, for an Admin acting for the
 * maintainers, the audit row commit with the change.
 */
export async function transitionViewing(
  auth: AuthContext,
  viewingId: string,
  action: ViewingAction,
  input: { proposedFor?: string } = {},
): Promise<ViewingResult> {
  const t = TRANSITIONS[action];
  return withTx(async (trx) => {
    const row = ((await trx.raw(VIEWING_SQL, [viewingId])) as { rows: ViewingRow[] }).rows[0];
    if (!row) throw notFound('Viewing request not found.', { code: 'VIEWING_NOT_FOUND' });

    const isClient = row.client_id === auth.user.id;
    const isMaintainer = await isMaintainerOf(trx, row.building_id, auth.user.id);
    const isAdmin = auth.roles.includes('admin');
    if (!isClient && !isMaintainer && !isAdmin) throw notFound('Viewing request not found.', { code: 'VIEWING_NOT_FOUND' });
    const onRightSide = t.actor === 'client' ? isClient : isMaintainer || isAdmin;
    if (!onRightSide) {
      throw forbidden(
        t.actor === 'client' ? 'Only the client who made this request can do that.' : "Only the building's maintainers can do that.",
        { code: 'WRONG_PARTY' },
      );
    }

    const now = trx.fn.now();
    const patch: Record<string, unknown> =
      action === 'accept' || action === 'decline' || action === 'counter'
        ? {
            status: action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : 'counter_proposed',
            responded_by: auth.user.id,
            responded_at: now,
            ...(action === 'counter' ? { counter_for: input.proposedFor } : {}),
          }
        : action === 'accept-counter'
          ? { status: 'accepted' }
          : {
              status: 'cancelled',
              cancelled_by: auth.user.id,
              cancelled_at: now,
              cancel_reason: action === 'cancel' ? 'client' : 'client_declined_counter',
            };

    const query = trx('viewing_requests').where({ id: viewingId }).whereIn('status', [...t.from]);
    if (t.needsFutureTime) query.whereRaw('COALESCE(counter_for, requested_for) > now()');
    const updated = (await query.update(patch).returning(['id', 'status', 'requested_for', 'counter_for'])) as Array<
      Parameters<typeof toResult>[0]
    >;

    if (!updated[0]) {
      const current = (await trx('viewing_requests').where({ id: viewingId }).first('status')) as { status: ViewingStatus };
      if (!t.from.includes(current.status)) {
        throw conflict(`This viewing request was already handled (it is now "${current.status}").`, {
          code: 'VIEWING_ALREADY_HANDLED',
          data: { status: current.status },
        });
      }
      throw conflict('The proposed viewing time has already passed.', { code: 'VIEWING_TIME_PASSED' });
    }

    const result = toResult(updated[0]);
    const proposedFor = action === 'counter' ? input.proposedFor : (result.counterFor ?? result.requestedFor);
    await notifyEach(trx, t.tell === 'client' ? [row.client_id] : await maintainerRecipients(trx, row.building_id), EVENT_VIEWING, {
      viewingId,
      kind: t.kind,
      spaceTypeId: row.space_type_id,
      spaceTypeName: row.space_type_name,
      buildingId: row.building_id,
      buildingName: row.building_name,
      proposedFor: proposedFor instanceof Date ? proposedFor.toISOString() : (proposedFor ?? null),
    });
    if (t.actor === 'maintainer' && !isMaintainer) {
      await writeAudit(trx, {
        actorUserId: auth.user.id,
        actorType: 'staff',
        action: `viewing.${action}`,
        objectType: 'viewing_request',
        objectId: viewingId,
        buildingId: row.building_id,
      });
    }
    return result;
  });
}

export interface ViewingSummary extends ViewingResult {
  role: 'client' | 'maintainer';
  spaceType: { id: string; name: string };
  building: { id: string; name: string };
  client: { id: string; displayName: string };
  respondedAt: Date | null;
  cancelReason: string | null;
  createdAt: Date;
}

interface ListRow {
  id: string;
  status: ViewingStatus;
  as_client: boolean;
  space_type_id: string;
  space_type_name: string;
  building_id: string;
  building_name: string;
  client_id: string;
  client_display_name: string | null;
  requested_for: Date;
  counter_for: Date | null;
  responded_at: Date | null;
  cancel_reason: string | null;
  created_at: Date;
  cursor_t: string;
}

/** FR-ENQ-002: "my" viewing requests, as the client or as a maintainer of the building, newest first. */
export async function listViewings(
  auth: AuthContext,
  { limit, cursor, status, as }: ListViewingsQuery,
): Promise<{ items: ViewingSummary[]; nextCursor: string | null }> {
  const me = auth.user.id;
  const maintains = 'EXISTS (SELECT 1 FROM building_maintainers m WHERE m.building_id = b.id AND m.user_id = ?)';
  const conditions: string[] = [];
  const bindings: Array<string | number> = [];
  if (as === 'client') {
    conditions.push('v.client_id = ?');
    bindings.push(me);
  } else if (as === 'maintainer') {
    conditions.push(maintains);
    bindings.push(me);
  } else {
    conditions.push(`(v.client_id = ? OR ${maintains})`);
    bindings.push(me, me);
  }
  if (status) {
    conditions.push('v.status = ?');
    bindings.push(status);
  }
  const where = keysetWhere('v.created_at', 'v.id', cursor);
  if (where) {
    conditions.push(where[0]);
    bindings.push(...where[1]);
  }

  const { rows } = (await db.raw(
    `SELECT v.id, v.status, (v.client_id = ?) AS as_client, v.space_type_id, st.name AS space_type_name,
            b.id AS building_id, b.name AS building_name, v.client_id, cp.display_name AS client_display_name,
            v.requested_for, v.counter_for, v.responded_at, v.cancel_reason, v.created_at,
            v.created_at::text AS cursor_t
       FROM viewing_requests v
       JOIN space_types st ON st.id = v.space_type_id
       JOIN buildings b ON b.id = st.building_id
       LEFT JOIN profiles cp ON cp.user_id = v.client_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY v.created_at DESC, v.id DESC
      LIMIT ?`,
    [me, ...bindings, limit + 1],
  )) as { rows: ListRow[] };

  const page = keysetPage(rows, limit);
  return {
    nextCursor: page.nextCursor,
    items: page.items.map((r) => ({
      ...toResult(r),
      role: r.as_client ? 'client' : 'maintainer',
      spaceType: { id: r.space_type_id, name: r.space_type_name },
      building: { id: r.building_id, name: r.building_name },
      client: { id: r.client_id, displayName: r.client_display_name ?? 'Deleted user' },
      respondedAt: r.responded_at,
      cancelReason: r.cancel_reason,
      createdAt: r.created_at,
    })),
  };
}
