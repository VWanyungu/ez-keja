import type { Knex } from 'knex';
import db from '../../db/knex.js';
import { withTx } from '../../db/tx.js';
import { assertBuildingEditable, closeSpaceTypeDemand, eventSourceOf } from '../../lib/catalogue.js';
import { isoMicros } from '../../lib/freshness.js';
import { notFound } from '../../lib/http-error.js';
import { encodeCursor, type KeysetQuery } from '../../lib/keyset.js';
import { loadBuildingAccess, type BuildingAccess } from '../../lib/maintainer.js';
import type { AuthContext } from '../../middlewares/auth.js';
import type { BulkConfirmItem } from './schemas.js';

type Conn = Knex | Knex.Transaction;

export type AvailabilityEventSource = 'maintainer' | 'admin' | 'follow_up' | 'bulk_confirm';

/** Who is acting, as `availability_events` records them (FR-AVL-008, FR-ADM-001). */
export interface CountActor {
  userId: string;
  actedAsStaff: boolean;
  source: AvailabilityEventSource;
}

export interface AvailabilityChange {
  id: string;
  buildingId: string;
  previousCount: number;
  vacantCount: number;
  /** ISO-8601 with microseconds: send it back unchanged in a bulk confirm. */
  lastConfirmedAt: string;
  eventType: 'confirmed' | 'count_changed';
  closedEnquiries: number;
  cancelledViewings: number;
}

const spaceTypeNotFound = () => notFound('Space type not found.', { code: 'SPACE_TYPE_NOT_FOUND' });

async function buildingOfSpaceType(conn: Conn, spaceTypeId: string): Promise<string> {
  const row = (await conn('space_types').where({ id: spaceTypeId }).first('building_id')) as
    | { building_id: string }
    | undefined;
  if (!row) throw spaceTypeNotFound();
  return row.building_id;
}

/**
 * TX-01 step 1: `SELECT ... WHERE id = $1 AND removed_at IS NULL FOR UPDATE`. This is the only lock
 * a count change takes. It never touches the building row (design §9.3), so a confirmation cannot
 * deadlock with a publish, which locks the building and then its space types.
 */
export async function lockLiveSpaceType(
  trx: Knex.Transaction,
  spaceTypeId: string,
): Promise<{ id: string; building_id: string; vacant_count: number }> {
  const row = (await trx('space_types')
    .where({ id: spaceTypeId })
    .whereNull('removed_at')
    .forUpdate()
    .first('id', 'building_id', 'vacant_count')) as
    | { id: string; building_id: string; vacant_count: number }
    | undefined;
  if (!row) throw spaceTypeNotFound();
  return row;
}

/**
 * TX-01 steps 2 and 3, on a space type the caller has locked: set the count and `last_confirmed_at`
 * (not `version`, so a confirmation never causes a false edit conflict), write the history row, and
 * when the count falls from above 0 to 0 close its enquiries and cancel its future viewings in the
 * same transaction. Notifying the affected clients is Phase 9.
 */
export async function applyVacantCount(
  trx: Knex.Transaction,
  locked: { id: string; building_id: string; vacant_count: number },
  newCount: number,
  actor: CountActor,
): Promise<AvailabilityChange> {
  const previousCount = locked.vacant_count;
  const eventType = previousCount === newCount ? 'confirmed' : 'count_changed';

  const result = (await trx.raw(
    `UPDATE space_types SET vacant_count = ?, last_confirmed_at = clock_timestamp()
      WHERE id = ? RETURNING ${isoMicros('last_confirmed_at')} AS last_confirmed_at`,
    [newCount, locked.id],
  )) as { rows: Array<{ last_confirmed_at: string }> };

  await trx('availability_events').insert({
    space_type_id: locked.id,
    event_type: eventType,
    old_count: previousCount,
    new_count: newCount,
    actor_user_id: actor.userId,
    acted_as_staff: actor.actedAsStaff,
    source: actor.source,
  });

  let closure = { closedEnquiries: 0, cancelledViewings: 0 };
  if (previousCount > 0 && newCount === 0) {
    closure = await closeSpaceTypeDemand(trx, locked.id, {
      enquiryReason: 'fully_let',
      viewingReason: 'fully_let',
      cancelledBy: actor.userId,
    });
  }

  return {
    id: locked.id,
    buildingId: locked.building_id,
    previousCount,
    vacantCount: newCount,
    lastConfirmedAt: result.rows[0]!.last_confirmed_at,
    eventType,
    ...closure,
  };
}

const actorFor = (auth: AuthContext, access: BuildingAccess): CountActor => ({
  userId: auth.user.id,
  actedAsStaff: access.actsAsStaff,
  source: eventSourceOf(access),
});

/**
 * Shared by set, confirm and "Now fully let". Access is checked before the lock (so a stranger
 * cannot make a maintainer wait) and again under it (so a maintainer removed a moment ago is
 * refused). `count` is resolved under the lock, because "Still N vacant" without an adjustment
 * means whatever the count is at that moment.
 */
async function changeCount(
  auth: AuthContext,
  spaceTypeId: string,
  count: number | 'current',
): Promise<AvailabilityChange> {
  const buildingId = await buildingOfSpaceType(db, spaceTypeId);
  assertBuildingEditable(await loadBuildingAccess(auth, buildingId));

  return withTx(async (trx) => {
    const locked = await lockLiveSpaceType(trx, spaceTypeId);
    const access = await loadBuildingAccess(auth, buildingId, trx);
    assertBuildingEditable(access);
    return applyVacantCount(trx, locked, count === 'current' ? locked.vacant_count : count, actorFor(auth, access));
  });
}

/** FR-AVL-001: set the vacant count (a Fully let space type can be raised above 0 here). */
export const setVacantCount = (auth: AuthContext, spaceTypeId: string, vacantCount: number) =>
  changeCount(auth, spaceTypeId, vacantCount);

/** FR-AVL-003: "Still N vacant", optionally adjusting N first. */
export const confirmVacantCount = (auth: AuthContext, spaceTypeId: string, vacantCount?: number) =>
  changeCount(auth, spaceTypeId, vacantCount ?? 'current');

/** FR-AVL-003: "Now fully let" sets the count to 0. */
export const markFullyLet = (auth: AuthContext, spaceTypeId: string) => changeCount(auth, spaceTypeId, 0);

// ---- bulk confirm (TX-02) -----------------------------------------------------------------------

export type BulkSkipReason = 'CHANGED' | 'REMOVED' | 'BUILDING_UNAVAILABLE';

export interface BulkConfirmResult {
  confirmed: Array<{ spaceTypeId: string; vacantCount: number; lastConfirmedAt: string }>;
  skipped: Array<{ spaceTypeId: string; reason: BulkSkipReason }>;
}

/**
 * FR-AVL-004: confirm many space types at the counts the screen showed. Each row is a
 * compare-and-swap on `last_confirmed_at` and `vacant_count`: any confirmation in between changes
 * `last_confirmed_at`, so a 3 -> 2 -> 3 sequence is still detected. A row that changed meanwhile
 * (or was removed, or sits in a withdrawn building) is skipped and reported; the rest go through.
 * Rows are updated in ascending id order so two overlapping bulk requests cannot deadlock.
 */
export async function bulkConfirm(auth: AuthContext, items: BulkConfirmItem[]): Promise<BulkConfirmResult> {
  const known = (await db('space_types')
    .whereIn('id', items.map((i) => i.spaceTypeId))
    .select('id', 'building_id', 'removed_at')) as Array<{ id: string; building_id: string; removed_at: Date | null }>;
  const byId = new Map(known.map((row) => [row.id, row]));
  for (const item of items) {
    if (!byId.has(item.spaceTypeId)) {
      throw notFound('Space type not found.', { code: 'SPACE_TYPE_NOT_FOUND', data: { spaceTypeId: item.spaceTypeId } });
    }
  }

  // Every building must be one the caller maintains (BR-003); one stranger fails the whole request.
  const accessByBuilding = new Map<string, BuildingAccess>();
  for (const buildingId of [...new Set(known.map((row) => row.building_id))].sort()) {
    accessByBuilding.set(buildingId, await loadBuildingAccess(auth, buildingId));
  }
  const unavailable = (access: BuildingAccess) =>
    access.status === 'withdrawn' || (access.status === 'suspended' && !access.isAdmin);

  const ordered = [...items].sort((a, b) => (a.spaceTypeId < b.spaceTypeId ? -1 : 1));
  return withTx(async (trx) => {
    const result: BulkConfirmResult = { confirmed: [], skipped: [] };
    for (const item of ordered) {
      const row = byId.get(item.spaceTypeId)!;
      const access = accessByBuilding.get(row.building_id)!;
      if (row.removed_at) {
        result.skipped.push({ spaceTypeId: item.spaceTypeId, reason: 'REMOVED' });
        continue;
      }
      if (unavailable(access)) {
        result.skipped.push({ spaceTypeId: item.spaceTypeId, reason: 'BUILDING_UNAVAILABLE' });
        continue;
      }
      // TX-02: `last_confirmed_at` is matched as the text the client was shown (microseconds intact).
      const updated = (await trx.raw(
        `UPDATE space_types SET last_confirmed_at = clock_timestamp()
          WHERE id = ? AND last_confirmed_at = ?::timestamptz AND vacant_count = ? AND removed_at IS NULL
          RETURNING ${isoMicros('last_confirmed_at')} AS last_confirmed_at`,
        [item.spaceTypeId, item.lastConfirmedAt, item.vacantCount],
      )) as { rows: Array<{ last_confirmed_at: string }> };
      if (updated.rows.length === 0) {
        result.skipped.push({ spaceTypeId: item.spaceTypeId, reason: 'CHANGED' });
        continue;
      }
      await trx('availability_events').insert({
        space_type_id: item.spaceTypeId,
        event_type: 'confirmed',
        old_count: item.vacantCount,
        new_count: item.vacantCount,
        actor_user_id: auth.user.id,
        acted_as_staff: access.actsAsStaff,
        source: 'bulk_confirm',
      });
      result.confirmed.push({
        spaceTypeId: item.spaceTypeId,
        vacantCount: item.vacantCount,
        lastConfirmedAt: updated.rows[0]!.last_confirmed_at,
      });
    }
    return result;
  });
}

// ---- history (FR-AVL-008) ------------------------------------------------------------------------

export interface AvailabilityEventItem {
  id: string;
  eventType: string;
  oldCount: number | null;
  newCount: number | null;
  actorUserId: string | null;
  actorName: string | null;
  actedAsStaff: boolean;
  source: string;
  createdAt: string;
}

export interface AvailabilityEventPage {
  items: AvailabilityEventItem[];
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
}

interface EventRow {
  id: string;
  event_type: string;
  old_count: number | null;
  new_count: number | null;
  actor_user_id: string | null;
  actor_name: string | null;
  acted_as_staff: boolean;
  source: string;
  created_at: string;
  created_at_text: string;
}

/** Newest first. The history of a removed space type stays readable. Keyset on `(created_at, id)`. */
export async function listAvailabilityEvents(
  auth: AuthContext,
  spaceTypeId: string,
  { limit, cursor }: KeysetQuery,
): Promise<AvailabilityEventPage> {
  await loadBuildingAccess(auth, await buildingOfSpaceType(db, spaceTypeId));

  const query = db('availability_events as e')
    .leftJoin('profiles as p', 'p.user_id', 'e.actor_user_id')
    .where('e.space_type_id', spaceTypeId)
    .orderBy('e.created_at', 'desc')
    .orderBy('e.id', 'desc')
    .limit(limit + 1)
    .select(
      'e.id',
      'e.event_type',
      'e.old_count',
      'e.new_count',
      'e.actor_user_id',
      'p.display_name as actor_name',
      'e.acted_as_staff',
      'e.source',
      db.raw(`${isoMicros('e.created_at')} AS created_at`),
      db.raw('e.created_at::text AS created_at_text'),
    );
  if (cursor) query.whereRaw('(e.created_at, e.id) < (?::timestamptz, ?::uuid)', [cursor.t, cursor.id]);

  const rows = (await query) as EventRow[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      id: r.id,
      eventType: r.event_type,
      oldCount: r.old_count,
      newCount: r.new_count,
      actorUserId: r.actor_user_id,
      actorName: r.actor_name,
      actedAsStaff: r.acted_as_staff,
      source: r.source,
      createdAt: r.created_at,
    })),
    nextCursor: rows.length > limit && last ? encodeCursor({ t: last.created_at_text, id: last.id }) : null,
  };
}
