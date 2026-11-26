import type { Knex } from 'knex';
import { lockBuildingRow, withTx } from '../db/tx.js';
import { conflict } from './http-error.js';
import { isPublishedLike, loadBuildingAccess, type BuildingAccess } from './maintainer.js';
import { EVENT_SPACE_TYPE_UNAVAILABLE, notifyEach } from './notify.js';
import type { AuthContext, UserRole } from '../middlewares/auth.js';

type Conn = Knex | Knex.Transaction;

export const actorTypeOf = (access: Pick<BuildingAccess, 'actsAsStaff'>): 'staff' | 'user' =>
  access.actsAsStaff ? 'staff' : 'user';

/** `availability_events.source` for a change made by a maintainer or by an Admin on their behalf. */
export const eventSourceOf = (access: Pick<BuildingAccess, 'actsAsStaff'>): 'admin' | 'maintainer' =>
  access.actsAsStaff ? 'admin' : 'maintainer';

/**
 * Runs `fn` in a transaction that holds the building row lock (design §9.3 step 1). The caller's
 * access is checked before any lock is taken (so a stranger cannot make others wait) and again
 * under the lock (so a maintainer removed a moment ago is refused).
 */
export async function withBuildingLock<T>(
  auth: Pick<AuthContext, 'user' | 'roles'>,
  buildingId: string,
  fn: (ctx: { trx: Knex.Transaction; access: BuildingAccess }) => Promise<T>,
): Promise<T> {
  await loadBuildingAccess(auth, buildingId);
  return withTx(async (trx) => {
    await lockBuildingRow(trx, buildingId);
    const access = await loadBuildingAccess(auth, buildingId, trx);
    return fn({ trx, access });
  });
}

/** Withdrawn buildings are read-only until reopened; a suspended one is changed only by an Admin. */
export function assertBuildingEditable(access: Pick<BuildingAccess, 'status' | 'isAdmin'>): void {
  if (access.status === 'withdrawn') {
    throw conflict('This building is withdrawn. Reopen it before changing it.', {
      code: 'BUILDING_WITHDRAWN',
    });
  }
  if (access.status === 'suspended' && !access.isAdmin) {
    throw conflict('This building is suspended. Contact an Admin.', { code: 'BUILDING_SUSPENDED' });
  }
}

/** TX-04: zero rows updated means someone saved first. The client reloads and retries. */
export const staleVersion = (what: string, currentVersion: number) =>
  conflict(`This ${what} was changed by someone else. Reload it and try again.`, {
    code: 'STALE_VERSION',
    data: { currentVersion },
  });

/** The fields that differ, as `{ before, after }`, for the audit row (TX-04). */
export function diffChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const changes = { before: {} as Record<string, unknown>, after: {} as Record<string, unknown> };
  for (const key of Object.keys(after)) {
    if (before[key] !== after[key]) {
      changes.before[key] = before[key] ?? null;
      changes.after[key] = after[key] ?? null;
    }
  }
  return changes;
}

export type DemandClosureReason = 'fully_let' | 'space_type_removed';

/**
 * TX-01 / TX-13: a space type stopped being available (count reached 0, or it was removed). Closes
 * its open enquiries and cancels its future viewings (`requested`, `counter_proposed`, `accepted`
 * whose time is still ahead; past-dated `requested` ones belong to the expiry job). Call inside the
 * caller's transaction with the space type row already locked. Tells the affected clients (N-08).
 */
export async function closeSpaceTypeDemand(
  trx: Knex.Transaction,
  spaceTypeId: string,
  opts: {
    enquiryReason: DemandClosureReason;
    viewingReason: DemandClosureReason;
    cancelledBy: string | null;
    /** What the clients are told in N-08. Defaults to `enquiryReason`; removal stores `fully_let` (Phase 5) but says "removed". */
    cause?: DemandClosureReason;
  },
): Promise<{ closedEnquiries: number; cancelledViewings: number }> {
  const closed = (await trx('enquiries')
    .where({ space_type_id: spaceTypeId })
    .whereNot({ status: 'closed' })
    .update({ status: 'closed', closed_reason: opts.enquiryReason, closed_at: trx.fn.now() })
    .returning('client_id')) as Array<{ client_id: string }>;
  const cancelled = (await trx('viewing_requests')
    .where({ space_type_id: spaceTypeId })
    .whereIn('status', ['requested', 'accepted', 'counter_proposed'])
    .whereRaw('COALESCE(counter_for, requested_for) > now()')
    .update({
      status: 'cancelled',
      cancelled_by: opts.cancelledBy,
      cancelled_at: trx.fn.now(),
      cancel_reason: opts.viewingReason,
    })
    .returning('client_id')) as Array<{ client_id: string }>;

  // N-08 (FR-AVL-009): each affected client is told once, whether they had a thread, a viewing or both.
  const clients = [...new Set([...closed, ...cancelled].map((r) => r.client_id))];
  if (clients.length > 0) {
    const info = (await trx('space_types as st')
      .join('buildings as b', 'b.id', 'st.building_id')
      .where('st.id', spaceTypeId)
      .first('st.name as space_type_name', 'b.id as building_id', 'b.name as building_name')) as
      | { space_type_name: string; building_id: string; building_name: string }
      | undefined;
    await notifyEach(trx, clients, EVENT_SPACE_TYPE_UNAVAILABLE, {
      spaceTypeId,
      spaceTypeName: info?.space_type_name ?? null,
      buildingId: info?.building_id ?? null,
      buildingName: info?.building_name ?? null,
      reason: opts.cause ?? opts.enquiryReason,
    });
  }
  return { closedEnquiries: closed.length, cancelledViewings: cancelled.length };
}

/** Roles held by each of the given users (empty set for an unknown user). */
export async function rolesByUser(conn: Conn, userIds: string[]): Promise<Map<string, Set<UserRole>>> {
  const map = new Map<string, Set<UserRole>>(userIds.map((id) => [id, new Set<UserRole>()]));
  if (userIds.length === 0) return map;
  const rows = (await conn('user_roles').whereIn('user_id', userIds).select('user_id', 'role')) as Array<{
    user_id: string;
    role: UserRole;
  }>;
  for (const row of rows) map.get(row.user_id)?.add(row.role);
  return map;
}

/** Blocker text without the live counts, so "(has 2)" and "(has 3)" compare as the same blocker. */
const normaliseBlocker = (blocker: string): string => blocker.replace(/\s*\(has \d+\)/, '');

/** `building_publish_blockers(uuid)` (T5), the same list the publish gate enforces. */
export async function fetchPublishBlockers(
  conn: Conn,
  buildingId: string,
  keepCounts = false,
): Promise<string[]> {
  const result = await conn.raw('SELECT building_publish_blockers(?::uuid) AS blockers', [buildingId]);
  const blockers = (result.rows[0]?.blockers as string[] | null) ?? [];
  return keepCounts ? blockers : blockers.map(normaliseBlocker);
}

/** FR-VER-008: this blocker alone means "park the building as Pending", not "refuse". */
export const LISTER_NOT_VERIFIED_BLOCKER = 'the lister is not verified';

export const onlyListerUnverified = (blockers: string[]): boolean =>
  blockers.length === 1 && blockers[0] === LISTER_NOT_VERIFIED_BLOCKER;

/**
 * TX-13: the T5 trigger fires only on a status change, so the service re-runs the gate around a
 * space-type change on a building that is, or was, on public display. A change that introduces a
 * blocker is refused and rolled back. Blockers that were already there (say, an unverified lister)
 * do not stop the change. Call inside `withBuildingLock` so two requests cannot both pass.
 */
export async function guardPublishingMinimums(
  trx: Knex.Transaction,
  access: BuildingAccess,
  mutate: () => Promise<void>,
  refusal: string,
): Promise<void> {
  if (!isPublishedLike(access)) {
    await mutate();
    return;
  }
  const before = new Set(await fetchPublishBlockers(trx, access.buildingId));
  await mutate();
  const introduced = (await fetchPublishBlockers(trx, access.buildingId)).filter((b) => !before.has(b));
  if (introduced.length > 0) {
    throw conflict(`${refusal}: ${introduced.join('; ')}.`, {
      code: 'PUBLISH_MINIMUMS',
      data: { blockers: introduced },
    });
  }
}
