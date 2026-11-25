import type { Knex } from 'knex';
import db from '../../db/knex.js';
import { lockLiveSpaceTypes } from '../../db/tx.js';
import { writeAudit } from '../../lib/audit.js';
import {
  actorTypeOf,
  assertBuildingEditable,
  diffChanges,
  eventSourceOf,
  guardPublishingMinimums,
  staleVersion,
  withBuildingLock,
} from '../../lib/catalogue.js';
import { badRequest, conflict, notFound } from '../../lib/http-error.js';
import { loadBuildingAccess } from '../../lib/maintainer.js';
import type { AuthContext } from '../../middlewares/auth.js';
import {
  resolveRent,
  type CreateSpaceTypeInput,
  type PatchSpaceTypeInput,
  type RentMode,
  type RestoreSpaceTypeInput,
} from './schemas.js';

/**
 * What removing a space type closes and cancels. The brief and TX-01 use 'fully_let'; the schema
 * also allows 'space_type_removed' for both columns, which is the more exact word. Change these
 * two constants to switch (the notification wording is Phase 9).
 */
const ENQUIRY_CLOSED_REASON = 'fully_let';
const VIEWING_CANCEL_REASON = 'fully_let';

type Conn = Knex | Knex.Transaction;

export interface SpaceTypeItem {
  id: string;
  buildingId: string;
  name: string;
  categoryId: string;
  sizeSqm: number | null;
  rentMode: RentMode;
  currencyId: string;
  rentAmount: number | null;
  depositAmount: number;
  vacantCount: number;
  lastConfirmedAt: Date;
  removedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

interface SpaceTypeRow {
  id: string;
  building_id: string;
  name: string;
  category_id: string;
  size_sqm: string | null;
  rent_mode: RentMode;
  currency_id: string;
  rent_amount: string | null;
  deposit_amount: string;
  vacant_count: number;
  last_confirmed_at: Date;
  removed_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export const SPACE_TYPE_COLUMNS = [
  'id', 'building_id', 'name', 'category_id', 'size_sqm', 'rent_mode', 'currency_id', 'rent_amount',
  'deposit_amount', 'vacant_count', 'last_confirmed_at', 'removed_at', 'version', 'created_at', 'updated_at',
] as const;

const num = (value: string | number | null): number | null => (value === null ? null : Number(value));

export function toSpaceTypeItem(row: SpaceTypeRow): SpaceTypeItem {
  return {
    id: row.id,
    buildingId: row.building_id,
    name: row.name,
    categoryId: row.category_id,
    sizeSqm: num(row.size_sqm),
    rentMode: row.rent_mode,
    currencyId: row.currency_id,
    rentAmount: num(row.rent_amount),
    depositAmount: Number(row.deposit_amount),
    vacantCount: row.vacant_count,
    lastConfirmedAt: row.last_confirmed_at,
    removedAt: row.removed_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Live space types of a building, or all of them with `includeRemoved`. No access check. */
export async function listSpaceTypeRows(
  conn: Conn,
  buildingId: string,
  includeRemoved = false,
): Promise<SpaceTypeItem[]> {
  const qb = conn('space_types').where({ building_id: buildingId });
  if (!includeRemoved) qb.whereNull('removed_at');
  const rows = (await qb.orderBy('created_at').orderBy('id').select(...SPACE_TYPE_COLUMNS)) as SpaceTypeRow[];
  return rows.map(toSpaceTypeItem);
}

export async function listSpaceTypes(
  auth: AuthContext,
  buildingId: string,
  includeRemoved: boolean,
): Promise<SpaceTypeItem[]> {
  await loadBuildingAccess(auth, buildingId);
  return listSpaceTypeRows(db, buildingId, includeRemoved);
}

async function buildingOfSpaceType(conn: Conn, spaceTypeId: string): Promise<string> {
  const row = (await conn('space_types').where({ id: spaceTypeId }).first('building_id')) as
    | { building_id: string }
    | undefined;
  if (!row) throw notFound('Space type not found.', { code: 'SPACE_TYPE_NOT_FOUND' });
  return row.building_id;
}

async function assertActiveReferences(
  trx: Knex.Transaction,
  refs: { categoryId?: string | undefined; currencyId?: string | undefined },
): Promise<void> {
  if (refs.categoryId !== undefined) {
    const found = await trx('space_categories').where({ id: refs.categoryId, is_active: true }).first('id');
    if (!found) throw badRequest('Category not found or no longer available.', { code: 'INVALID_CATEGORY' });
  }
  if (refs.currencyId !== undefined) {
    const found = await trx('currencies').where({ id: refs.currencyId, is_active: true }).first('id');
    if (!found) throw badRequest('Currency not found or no longer available.', { code: 'INVALID_CURRENCY' });
  }
}

const nameTaken = (name: string) =>
  conflict(`A space type named "${name}" already exists in this building.`, { code: 'NAME_TAKEN' });

/** The unique index is the backstop for the same-name check; a clash becomes a 409. */
function mapDbError(err: unknown, name: string | undefined): unknown {
  const pg = err as { code?: string; constraint?: string };
  if (pg?.code === '23505' && pg.constraint === 'ux_space_types_building_name') {
    return nameTaken(name ?? 'this name');
  }
  return err;
}

async function loadLocked(trx: Knex.Transaction, id: string): Promise<SpaceTypeRow> {
  const row = (await trx('space_types').where({ id }).forUpdate().first(...SPACE_TYPE_COLUMNS)) as
    | SpaceTypeRow
    | undefined;
  if (!row) throw notFound('Space type not found.', { code: 'SPACE_TYPE_NOT_FOUND' });
  return row;
}

/** FR-UNT-002: create a space type. On a published building it must arrive with its photos (TX-13). */
export async function createSpaceType(
  auth: AuthContext,
  buildingId: string,
  input: CreateSpaceTypeInput,
): Promise<SpaceTypeItem> {
  try {
    return await withBuildingLock(auth, buildingId, async ({ trx, access }) => {
      assertBuildingEditable(access);
      await assertActiveReferences(trx, input);

      let id = '';
      await guardPublishingMinimums(
        trx,
        access,
        async () => {
          const [row] = (await trx('space_types')
            .insert({
              building_id: buildingId,
              name: input.name,
              category_id: input.categoryId,
              size_sqm: input.sizeSqm,
              rent_mode: input.rentMode,
              currency_id: input.currencyId,
              rent_amount: input.rentAmount,
              deposit_amount: input.depositAmount,
              vacant_count: input.vacantCount,
              created_by: auth.user.id,
            })
            .returning('id')) as { id: string }[];
          id = row!.id;
          await trx('availability_events').insert({
            space_type_id: id,
            event_type: 'created',
            old_count: null,
            new_count: input.vacantCount,
            actor_user_id: auth.user.id,
            acted_as_staff: access.actsAsStaff,
            source: eventSourceOf(access),
          });
        },
        'A space type cannot be added to a published building without its photos (BR-018). Add it while the building is a draft, or withdraw and reopen the building first',
      );

      await writeAudit(trx, {
        actorUserId: auth.user.id,
        actorType: actorTypeOf(access),
        action: 'space_type.create',
        objectType: 'space_type',
        objectId: id,
        buildingId,
        changes: { name: input.name, rentMode: input.rentMode, vacantCount: input.vacantCount },
      });
      return toSpaceTypeItem(await loadLocked(trx, id));
    });
  } catch (err) {
    throw mapDbError(err, input.name);
  }
}

/** FR-UNT-007 / TX-04: edit with an optimistic lock and a before/after audit row. */
export async function updateSpaceType(
  auth: AuthContext,
  id: string,
  patch: PatchSpaceTypeInput,
): Promise<SpaceTypeItem> {
  const buildingId = await buildingOfSpaceType(db, id);
  try {
    return await withBuildingLock(auth, buildingId, async ({ trx, access }) => {
      assertBuildingEditable(access);
      const row = await loadLocked(trx, id);
      if (row.removed_at) {
        throw conflict('This space type is removed. Restore it first.', { code: 'SPACE_TYPE_REMOVED' });
      }
      const before = toSpaceTypeItem(row);
      await assertActiveReferences(trx, patch);

      const rent = resolveRent(before, patch);
      const next = {
        name: patch.name ?? before.name,
        categoryId: patch.categoryId ?? before.categoryId,
        currencyId: patch.currencyId ?? before.currencyId,
        sizeSqm: patch.sizeSqm === undefined ? before.sizeSqm : patch.sizeSqm,
        rentMode: rent.rentMode,
        rentAmount: rent.rentAmount,
        depositAmount: patch.depositAmount ?? before.depositAmount,
      };
      const changes = diffChanges({ ...before }, next);
      if (Object.keys(changes.after).length === 0) {
        if (before.version !== patch.version) throw staleVersion('space type', before.version);
        return before;
      }

      const updated = (await trx('space_types')
        .where({ id, version: patch.version })
        .whereNull('removed_at')
        .update({
          name: next.name,
          category_id: next.categoryId,
          currency_id: next.currencyId,
          size_sqm: next.sizeSqm,
          rent_mode: next.rentMode,
          rent_amount: next.rentAmount,
          deposit_amount: next.depositAmount,
          version: trx.raw('version + 1'),
        })
        .returning([...SPACE_TYPE_COLUMNS])) as SpaceTypeRow[];
      if (updated.length === 0) throw staleVersion('space type', before.version);

      await writeAudit(trx, {
        actorUserId: auth.user.id,
        actorType: actorTypeOf(access),
        action: 'space_type.update',
        objectType: 'space_type',
        objectId: id,
        buildingId,
        changes,
      });
      return toSpaceTypeItem(updated[0]!);
    });
  } catch (err) {
    throw mapDbError(err, patch.name);
  }
}

export interface RemovedSpaceType {
  id: string;
  removedAt: Date;
  closedEnquiries: number;
  cancelledViewings: number;
}

/**
 * TX-13: soft-remove a space type, write the `removed` event, close its open enquiries and cancel
 * its future viewings in the same transaction, and refuse if that would leave a published
 * building without a live space type. Notifying clients is Phase 9.
 */
export async function removeSpaceType(auth: AuthContext, id: string): Promise<RemovedSpaceType> {
  const buildingId = await buildingOfSpaceType(db, id);
  return withBuildingLock(auth, buildingId, async ({ trx, access }) => {
    assertBuildingEditable(access);
    await lockLiveSpaceTypes(trx, buildingId); // lock order step 2 (design §9.3)
    const row = await loadLocked(trx, id);
    if (row.removed_at) throw conflict('This space type is already removed.', { code: 'SPACE_TYPE_REMOVED' });

    let removedAt = new Date();
    let closedEnquiries = 0;
    let cancelledViewings = 0;
    await guardPublishingMinimums(
      trx,
      access,
      async () => {
        const [removed] = (await trx('space_types')
          .where({ id })
          .update({ removed_at: trx.fn.now(), removed_by: auth.user.id })
          .returning('removed_at')) as { removed_at: Date }[];
        removedAt = removed!.removed_at;
        await trx('availability_events').insert({
          space_type_id: id,
          event_type: 'removed',
          old_count: row.vacant_count,
          new_count: null,
          actor_user_id: auth.user.id,
          acted_as_staff: access.actsAsStaff,
          source: eventSourceOf(access),
        });
        closedEnquiries = await trx('enquiries')
          .where({ space_type_id: id })
          .whereNot({ status: 'closed' })
          .update({ status: 'closed', closed_reason: ENQUIRY_CLOSED_REASON, closed_at: trx.fn.now() });
        cancelledViewings = await trx('viewing_requests')
          .where({ space_type_id: id })
          .whereIn('status', ['requested', 'accepted', 'counter_proposed'])
          .whereRaw('COALESCE(counter_for, requested_for) > now()')
          .update({
            status: 'cancelled',
            cancelled_by: auth.user.id,
            cancelled_at: trx.fn.now(),
            cancel_reason: VIEWING_CANCEL_REASON,
          });
      },
      'This space type cannot be removed from a published building',
    );

    await writeAudit(trx, {
      actorUserId: auth.user.id,
      actorType: actorTypeOf(access),
      action: 'space_type.remove',
      objectType: 'space_type',
      objectId: id,
      buildingId,
      changes: { name: row.name, vacantCount: row.vacant_count, closedEnquiries, cancelledViewings },
    });
    return { id, removedAt, closedEnquiries, cancelledViewings };
  });
}

/**
 * TX-14: bring a removed space type back. It needs an explicit count, and a new name when a live
 * space type has taken its old one.
 */
export async function restoreSpaceType(
  auth: AuthContext,
  id: string,
  input: RestoreSpaceTypeInput,
): Promise<SpaceTypeItem> {
  const buildingId = await buildingOfSpaceType(db, id);
  try {
    return await withBuildingLock(auth, buildingId, async ({ trx, access }) => {
      assertBuildingEditable(access);
      await lockLiveSpaceTypes(trx, buildingId);
      const row = await loadLocked(trx, id);
      if (!row.removed_at) throw conflict('This space type is not removed.', { code: 'SPACE_TYPE_NOT_REMOVED' });

      const name = input.name ?? row.name;
      const clash = await trx('space_types')
        .where({ building_id: buildingId })
        .whereNull('removed_at')
        .whereRaw('lower(name) = lower(?)', [name])
        .first('id');
      if (clash) {
        throw conflict(
          `A space type named "${name}" already exists in this building. Send a new "name" to restore this one.`,
          { code: 'NAME_TAKEN' },
        );
      }

      await guardPublishingMinimums(
        trx,
        access,
        async () => {
          await trx('space_types')
            .where({ id })
            .update({
              name,
              vacant_count: input.vacantCount,
              last_confirmed_at: trx.raw('clock_timestamp()'),
              removed_at: null,
              removed_by: null,
              version: trx.raw('version + 1'),
            });
          await trx('availability_events').insert({
            space_type_id: id,
            event_type: 'restored',
            old_count: null,
            new_count: input.vacantCount,
            actor_user_id: auth.user.id,
            acted_as_staff: access.actsAsStaff,
            source: eventSourceOf(access),
          });
        },
        'This space type cannot be restored on a published building',
      );

      await writeAudit(trx, {
        actorUserId: auth.user.id,
        actorType: actorTypeOf(access),
        action: 'space_type.restore',
        objectType: 'space_type',
        objectId: id,
        buildingId,
        changes: { name, vacantCount: input.vacantCount, previousName: row.name },
      });
      return toSpaceTypeItem(await loadLocked(trx, id));
    });
  } catch (err) {
    throw mapDbError(err, input.name ?? undefined);
  }
}
