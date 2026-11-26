import type { Knex } from 'knex';
import db from '../../db/knex.js';
import { lockLiveSpaceTypes, withTx } from '../../db/tx.js';
import { writeAudit } from '../../lib/audit.js';
import {
  actorTypeOf,
  assertBuildingEditable,
  diffChanges,
  eventSourceOf,
  fetchPublishBlockers,
  onlyListerUnverified,
  rolesByUser,
  staleVersion,
  withBuildingLock,
} from '../../lib/catalogue.js';
import {
  freshnessOf,
  isoMicros,
  outdatedSql,
  summariseBuildingFreshness,
  type FreshnessState,
} from '../../lib/freshness.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/http-error.js';
import { loadBuildingAccess } from '../../lib/maintainer.js';
import type { AuthContext, UserRole } from '../../middlewares/auth.js';
import { listSpaceTypeRows, type SpaceTypeItem } from '../space-types/service.js';
import { recordBuildingReopened } from '../verification/service.js';
import {
  assertManagement,
  canTransition,
  type BuildingStatus,
  type CreateBuildingInput,
  type Management,
  type ManagementType,
  type PatchBuildingInput,
} from './schemas.js';

type Conn = Knex | Knex.Transaction;

/** ASM-10: only these roles may be the lister of a building, or a maintainer of one. */
const LISTER_ROLES: readonly UserRole[] = ['landlord', 'agent', 'admin'];

export interface BuildingItem {
  id: string;
  name: string;
  areaId: string;
  latitude: number;
  longitude: number;
  description: string | null;
  managementType: ManagementType;
  managingAgentId: string | null;
  landlordUserId: string | null;
  landlordName: string | null;
  contactUserId: string | null;
  listerId: string;
  createdBy: string;
  status: BuildingStatus;
  verificationStatus: string;
  publishedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

interface BuildingRow {
  id: string;
  name: string;
  area_id: string;
  latitude: string;
  longitude: string;
  description: string | null;
  management_type: ManagementType;
  managing_agent_id: string | null;
  landlord_user_id: string | null;
  landlord_name: string | null;
  contact_user_id: string | null;
  lister_id: string;
  created_by: string;
  status: BuildingStatus;
  verification_status: string;
  published_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const BUILDING_COLUMNS = [
  'id', 'name', 'area_id', 'latitude', 'longitude', 'description', 'management_type', 'managing_agent_id',
  'landlord_user_id', 'landlord_name', 'contact_user_id', 'lister_id', 'created_by', 'status',
  'verification_status', 'published_at', 'version', 'created_at', 'updated_at',
] as const;

function toBuildingItem(row: BuildingRow): BuildingItem {
  return {
    id: row.id,
    name: row.name,
    areaId: row.area_id,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    description: row.description,
    managementType: row.management_type,
    managingAgentId: row.managing_agent_id,
    landlordUserId: row.landlord_user_id,
    landlordName: row.landlord_name,
    contactUserId: row.contact_user_id,
    listerId: row.lister_id,
    createdBy: row.created_by,
    status: row.status,
    verificationStatus: row.verification_status,
    publishedAt: row.published_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadBuilding(conn: Conn, id: string): Promise<BuildingItem> {
  const row = (await conn('buildings').where({ id }).first(...BUILDING_COLUMNS)) as BuildingRow | undefined;
  if (!row) throw notFound('Building not found.', { code: 'BUILDING_NOT_FOUND' });
  return toBuildingItem(row);
}

async function assertActiveArea(conn: Conn, areaId: string): Promise<void> {
  const area = await conn('areas').where({ id: areaId, is_active: true }).first('id');
  if (!area) {
    throw badRequest('Choose an area from the area list.', { code: 'INVALID_AREA' });
  }
}

/** The agent must hold the agent role and the landlord account the landlord role (FR-UNT-005). */
async function assertManagementUsers(
  conn: Conn,
  m: Management,
  check: { agent: boolean; landlord: boolean },
): Promise<void> {
  const ids = [check.agent ? m.managingAgentId : null, check.landlord ? m.landlordUserId : null].filter(
    (id): id is string => id !== null,
  );
  if (ids.length === 0) return;
  const roles = await rolesByUser(conn, ids);
  if (check.agent && m.managingAgentId && !roles.get(m.managingAgentId)?.has('agent')) {
    throw badRequest('"managingAgentId" must be an Agent account.', { code: 'MANAGING_AGENT_INVALID' });
  }
  if (check.landlord && m.landlordUserId && !roles.get(m.landlordUserId)?.has('landlord')) {
    throw badRequest('"landlordUserId" must be a Landlord account.', { code: 'LANDLORD_INVALID' });
  }
}

// ---- create ---------------------------------------------------------------------------------

/**
 * FR-UNT-001: create a Draft. An Admin may create on behalf of a lister (G-15): `created_by` is
 * the Admin and `lister_id` the lister, who becomes the maintainer. Otherwise the creator is the
 * lister and the first maintainer.
 */
export async function createBuilding(auth: AuthContext, input: CreateBuildingInput): Promise<BuildingItem> {
  const isAdmin = auth.roles.includes('admin');
  if (input.listerId && input.listerId !== auth.user.id && !isAdmin) {
    throw forbidden('Only an Admin can create a building on behalf of another lister.', { code: 'ADMIN_ONLY' });
  }
  const listerId = input.listerId ?? auth.user.id;
  const onBehalf = listerId !== auth.user.id;

  const listerRoles = (await rolesByUser(db, [listerId])).get(listerId)!;
  if (!LISTER_ROLES.some((role) => listerRoles.has(role))) {
    throw badRequest('The lister must be a Landlord, Agent or Admin account.', { code: 'LISTER_NOT_ELIGIBLE' });
  }

  const management: Management = {
    managementType: input.managementType,
    managingAgentId: input.managingAgentId,
    landlordUserId: input.landlordUserId,
    landlordName: input.landlordName,
  };
  // A lister who is the agent (or the landlord) need not name themselves again.
  if (management.managementType === 'agent' && !management.managingAgentId && listerRoles.has('agent')) {
    management.managingAgentId = listerId;
  }
  if (
    management.managementType === 'landlord' &&
    !management.landlordUserId &&
    !management.landlordName &&
    listerRoles.has('landlord')
  ) {
    management.landlordUserId = listerId;
  }
  assertManagement(management);
  await assertManagementUsers(db, management, { agent: true, landlord: true });
  await assertActiveArea(db, input.areaId);

  const id = await withTx(async (trx) => {
    const [row] = (await trx('buildings')
      .insert({
        name: input.name,
        area_id: input.areaId,
        latitude: input.latitude,
        longitude: input.longitude,
        description: input.description,
        management_type: management.managementType,
        managing_agent_id: management.managingAgentId,
        landlord_user_id: management.landlordUserId,
        landlord_name: management.landlordName,
        lister_id: listerId,
        created_by: auth.user.id,
      })
      .returning('id')) as { id: string }[];
    const buildingId = row!.id;
    await trx('building_maintainers').insert({
      building_id: buildingId,
      user_id: listerId,
      added_by: auth.user.id,
    });
    await writeAudit(trx, {
      actorUserId: auth.user.id,
      actorType: onBehalf ? 'staff' : 'user',
      action: 'building.create',
      objectType: 'building',
      objectId: buildingId,
      buildingId,
      changes: { name: input.name, areaId: input.areaId, listerId, createdBy: auth.user.id },
    });
    return buildingId;
  });
  return loadBuilding(db, id);
}

// ---- read -----------------------------------------------------------------------------------

export interface MaintainerItem {
  userId: string;
  displayName: string;
  hasPhone: boolean;
  isContact: boolean;
  addedAt: Date;
}

async function listMaintainers(conn: Conn, buildingId: string): Promise<MaintainerItem[]> {
  const rows = (await conn('building_maintainers as m')
    .join('profiles as p', 'p.user_id', 'm.user_id')
    .join('buildings as b', 'b.id', 'm.building_id')
    .where('m.building_id', buildingId)
    .orderBy('m.added_at')
    .orderBy('m.id')
    .select(
      'm.user_id',
      'p.display_name',
      'm.added_at',
      conn.raw('(p.phone IS NOT NULL) AS has_phone'),
      conn.raw('(b.contact_user_id = m.user_id) AS is_contact'),
    )) as Array<{ user_id: string; display_name: string; added_at: Date; has_phone: boolean; is_contact: boolean }>;
  return rows.map((r) => ({
    userId: r.user_id,
    displayName: r.display_name,
    hasPhone: r.has_phone,
    isContact: r.is_contact,
    addedAt: r.added_at,
  }));
}

export interface BuildingDetail extends BuildingItem {
  spaceTypes: SpaceTypeItem[];
  maintainers: MaintainerItem[];
}

/** The maintainer's view of one building (SCR-08). The public page is Phase 7. */
export async function getBuilding(auth: AuthContext, id: string): Promise<BuildingDetail> {
  await loadBuildingAccess(auth, id);
  const [building, spaceTypes, maintainers] = await Promise.all([
    loadBuilding(db, id),
    listSpaceTypeRows(db, id),
    listMaintainers(db, id),
  ]);
  return { ...building, spaceTypes, maintainers };
}

export interface MyBuildingItem {
  id: string;
  name: string;
  areaId: string;
  status: BuildingStatus;
  verificationStatus: string;
  version: number;
  updatedAt: Date;
  /** BR-030: the building's latest update among its Vacant space types, and its freshness. */
  latestUpdate: string | null;
  freshness: FreshnessState;
  /** FR-RPT-003: enquiries on this building's space types that no maintainer has answered yet (`status = 'new'`, Q-D7). */
  awaitingReplyCount: number;
  spaceTypes: Array<{
    id: string;
    name: string;
    vacantCount: number;
    /** ISO-8601 with microseconds: send it back unchanged in a bulk confirm (TX-02). */
    lastConfirmedAt: string;
    daysSinceConfirmed: number;
    /** BR-001 / FR-AVL-005, from `lib/freshness.ts`. */
    freshness: FreshnessState;
  }>;
}

/**
 * FR-RPT-003 "My buildings": the buildings the signed-in user maintains, each space type with its
 * vacant count and days since `last_confirmed_at`, plus the enquiries awaiting a reply.
 */
export async function listMyBuildings(auth: AuthContext): Promise<MyBuildingItem[]> {
  const buildings = (await db('buildings as b')
    .join('building_maintainers as m', 'm.building_id', 'b.id')
    .where('m.user_id', auth.user.id)
    .orderBy('b.updated_at', 'desc')
    .orderBy('b.id')
    .select('b.id', 'b.name', 'b.area_id', 'b.status', 'b.verification_status', 'b.version', 'b.updated_at')) as Array<{
    id: string;
    name: string;
    area_id: string;
    status: BuildingStatus;
    verification_status: string;
    version: number;
    updated_at: Date;
  }>;
  if (buildings.length === 0) return [];

  const types = (await db('space_types')
    .whereIn('building_id', buildings.map((b) => b.id))
    .whereNull('removed_at')
    .orderBy('created_at')
    .orderBy('id')
    .select(
      'id',
      'building_id',
      'name',
      'vacant_count',
      db.raw(`${isoMicros('space_types.last_confirmed_at')} AS last_confirmed_at`),
      db.raw('floor(extract(epoch FROM (clock_timestamp() - last_confirmed_at)) / 86400)::int AS days_since_confirmed'),
      db.raw(`${outdatedSql('space_types')} AS outdated`),
    )) as Array<{
    id: string;
    building_id: string;
    name: string;
    vacant_count: number;
    last_confirmed_at: string;
    days_since_confirmed: number;
    outdated: boolean;
  }>;

  const awaiting = (await db('enquiries as e')
    .join('space_types as st', 'st.id', 'e.space_type_id')
    .whereIn('st.building_id', buildings.map((b) => b.id))
    .where('e.status', 'new')
    .groupBy('st.building_id')
    .select('st.building_id', db.raw('count(*)::int AS n'))) as Array<{ building_id: string; n: number }>;
  const awaitingOf = new Map(awaiting.map((row) => [row.building_id, row.n]));

  return buildings.map((b) => {
    const own = types
      .filter((t) => t.building_id === b.id)
      .map((t) => ({
        id: t.id,
        name: t.name,
        vacantCount: t.vacant_count,
        lastConfirmedAt: t.last_confirmed_at,
        daysSinceConfirmed: t.days_since_confirmed,
        outdated: t.outdated,
      }));
    const { state, latestUpdate } = summariseBuildingFreshness(own);
    return {
      id: b.id,
      name: b.name,
      areaId: b.area_id,
      status: b.status,
      verificationStatus: b.verification_status,
      version: b.version,
      updatedAt: b.updated_at,
      latestUpdate,
      freshness: state,
      awaitingReplyCount: awaitingOf.get(b.id) ?? 0,
      spaceTypes: own.map(({ outdated, ...rest }) => ({ ...rest, freshness: freshnessOf(rest.vacantCount, outdated) })),
    };
  });
}

// ---- edit -----------------------------------------------------------------------------------

/** FR-UNT-007 / TX-04: edit with an optimistic lock and a before/after audit row. */
export async function updateBuilding(
  auth: AuthContext,
  id: string,
  patch: PatchBuildingInput,
): Promise<BuildingItem> {
  return withBuildingLock(auth, id, async ({ trx, access }) => {
    assertBuildingEditable(access);
    const before = await loadBuilding(trx, id);

    const management: Management = {
      managementType: patch.managementType ?? before.managementType,
      managingAgentId: patch.managingAgentId !== undefined ? patch.managingAgentId : before.managingAgentId,
      landlordUserId: patch.landlordUserId !== undefined ? patch.landlordUserId : before.landlordUserId,
      landlordName: patch.landlordName !== undefined ? patch.landlordName : before.landlordName,
    };
    // Switching to landlord management drops the agent link unless the caller sets it explicitly.
    if (management.managementType === 'landlord' && patch.managingAgentId === undefined) {
      management.managingAgentId = null;
    }
    assertManagement(management);

    const next = {
      name: patch.name ?? before.name,
      areaId: patch.areaId ?? before.areaId,
      latitude: patch.latitude ?? before.latitude,
      longitude: patch.longitude ?? before.longitude,
      description: patch.description === undefined ? before.description : patch.description,
      ...management,
    };
    const changes = diffChanges({ ...before }, next);
    if (Object.keys(changes.after).length === 0) {
      if (before.version !== patch.version) throw staleVersion('building', before.version);
      return before;
    }

    if (next.areaId !== before.areaId) await assertActiveArea(trx, next.areaId);
    await assertManagementUsers(trx, management, {
      agent: management.managingAgentId !== before.managingAgentId,
      landlord: management.landlordUserId !== before.landlordUserId,
    });

    const updated = (await trx('buildings')
      .where({ id, version: patch.version })
      .update({
        name: next.name,
        area_id: next.areaId,
        latitude: next.latitude,
        longitude: next.longitude,
        description: next.description,
        management_type: management.managementType,
        managing_agent_id: management.managingAgentId,
        landlord_user_id: management.landlordUserId,
        landlord_name: management.landlordName,
        version: trx.raw('version + 1'),
      })
      .returning([...BUILDING_COLUMNS])) as BuildingRow[];
    if (updated.length === 0) throw staleVersion('building', before.version);

    await writeAudit(trx, {
      actorUserId: auth.user.id,
      actorType: actorTypeOf(access),
      action: 'building.update',
      objectType: 'building',
      objectId: id,
      buildingId: id,
      changes,
    });

    // FR-VER-007: T6 (an AFTER trigger, so RETURNING above cannot show it) sends a Verified building
    // back to Pending when its area or pin moves. Re-read it, then tell maintainers and Admins.
    const after = await loadBuilding(trx, id);
    if (before.verificationStatus === 'verified' && after.verificationStatus !== 'verified') {
      await recordBuildingReopened(trx, {
        buildingId: id,
        actorUserId: auth.user.id,
        actorType: actorTypeOf(access),
        changed: [
          ...('areaId' in changes.after ? ['area'] : []),
          ...('latitude' in changes.after || 'longitude' in changes.after ? ['pin'] : []),
        ],
      });
    }
    return after;
  });
}

// ---- status ---------------------------------------------------------------------------------

async function changeStatus(
  auth: AuthContext,
  id: string,
  to: 'withdrawn' | 'draft',
  action: 'building.withdraw' | 'building.reopen',
): Promise<BuildingItem> {
  return withBuildingLock(auth, id, async ({ trx, access }) => {
    if (!canTransition(access.status, to)) {
      throw conflict(
        `A ${access.status} building cannot be ${to === 'withdrawn' ? 'withdrawn' : 'reopened'}.`,
        { code: 'INVALID_TRANSITION' },
      );
    }
    await trx('buildings').where({ id }).update({ status: to });
    await writeAudit(trx, {
      actorUserId: auth.user.id,
      actorType: actorTypeOf(access),
      action,
      objectType: 'building',
      objectId: id,
      buildingId: id,
      changes: { from: access.status, to },
    });
    return loadBuilding(trx, id);
  });
}

/** FR-UNT-008: withdrawn buildings leave search and keep all their history; never deleted (BR-021). */
export const withdrawBuilding = (auth: AuthContext, id: string) =>
  changeStatus(auth, id, 'withdrawn', 'building.withdraw');

/** FR-UNT-008: a withdrawn building comes back as a Draft and must pass the gate again to publish. */
export const reopenBuilding = (auth: AuthContext, id: string) =>
  changeStatus(auth, id, 'draft', 'building.reopen');

export interface PublishBlockers {
  blockers: string[];
  canPublish: boolean;
  /** True when the lister's verification is the only thing missing: publishing would park it as Pending. */
  wouldBePending: boolean;
}

/** The T5 blocker list for the editor's checklist (FR-MED-003). Maintainers and Admin only. */
export async function getPublishBlockers(auth: AuthContext, id: string): Promise<PublishBlockers> {
  await loadBuildingAccess(auth, id);
  const blockers = await fetchPublishBlockers(db, id, true);
  return { blockers, canPublish: blockers.length === 0, wouldBePending: onlyListerUnverified(blockers) };
}

export interface PublishResult {
  /** 'published', or 'pending' when only the lister's verification is missing (FR-VER-008). */
  outcome: 'published' | 'pending';
  blockers: string[];
  building: BuildingItem;
}

const blockedError = (blockers: string[]) =>
  conflict(`The building cannot be published yet: ${blockers.join('; ')}.`, {
    code: 'PUBLISH_BLOCKED',
    data: { blockers },
  });

/** The T5 trigger raises "Building cannot be published: a; b" (check_violation). Turn it into a 409. */
export function mapGateViolation(err: unknown): unknown {
  const pg = err as { code?: string; message?: string };
  const match = pg?.code === '23514' ? /Building cannot be published: (.*)$/s.exec(pg.message ?? '') : null;
  return match ? blockedError(match[1]!.split('; ').map((b) => b.trim())) : err;
}

/**
 * TX-03: lock the building, then its live space types ascending; stamp `last_confirmed_at` and
 * write a `published` event on each; then set the status. T5 is the gate. If the lister's
 * verification is the only blocker, the building becomes Pending instead (FR-VER-008).
 */
export async function publishBuilding(auth: AuthContext, id: string): Promise<PublishResult> {
  try {
    return await withBuildingLock(auth, id, async ({ trx, access }): Promise<PublishResult> => {
      if (access.status === 'published') {
        throw conflict('This building is already published.', { code: 'ALREADY_PUBLISHED' });
      }
      if (!canTransition(access.status, 'published')) {
        throw conflict(`A ${access.status} building cannot be published.`, { code: 'INVALID_TRANSITION' });
      }

      const spaceTypes = await lockLiveSpaceTypes(trx, id);
      const blockers = await fetchPublishBlockers(trx, id, true);
      if (blockers.length > 0) {
        if (!onlyListerUnverified(blockers)) throw blockedError(blockers);
        if (access.status === 'draft') {
          await trx('buildings').where({ id }).update({ status: 'pending' });
          await writeAudit(trx, {
            actorUserId: auth.user.id,
            actorType: actorTypeOf(access),
            action: 'building.pending',
            objectType: 'building',
            objectId: id,
            buildingId: id,
            changes: { from: 'draft', to: 'pending', blockers },
          });
        }
        return { outcome: 'pending', blockers, building: await loadBuilding(trx, id) };
      }

      await trx('space_types')
        .where({ building_id: id })
        .whereNull('removed_at')
        .update({ last_confirmed_at: trx.raw('clock_timestamp()') });
      if (spaceTypes.length > 0) {
        await trx('availability_events').insert(
          spaceTypes.map((st) => ({
            space_type_id: st.id,
            event_type: 'published',
            old_count: null,
            new_count: st.vacant_count,
            actor_user_id: auth.user.id,
            acted_as_staff: access.actsAsStaff,
            source: eventSourceOf(access),
          })),
        );
      }
      await trx('buildings')
        .where({ id })
        .update({ status: 'published', published_at: trx.raw('COALESCE(published_at, now())') });
      await writeAudit(trx, {
        actorUserId: auth.user.id,
        actorType: actorTypeOf(access),
        action: 'building.publish',
        objectType: 'building',
        objectId: id,
        buildingId: id,
        changes: { from: access.status, to: 'published', spaceTypes: spaceTypes.length },
      });
      return { outcome: 'published', blockers: [], building: await loadBuilding(trx, id) };
    });
  } catch (err) {
    throw mapGateViolation(err);
  }
}

// ---- maintainers and contact (TX-15) --------------------------------------------------------

/** FR-UNT-006, BR-031: add a maintainer. The new maintainer must hold a lister role (ASM-10). */
export async function addMaintainer(auth: AuthContext, id: string, userId: string): Promise<MaintainerItem[]> {
  return withBuildingLock(auth, id, async ({ trx, access }) => {
    const roles = (await rolesByUser(trx, [userId])).get(userId)!;
    if (roles.size === 0) throw notFound('User not found.', { code: 'USER_NOT_FOUND' });
    if (!LISTER_ROLES.some((role) => roles.has(role))) {
      throw badRequest('A maintainer must be a Landlord, Agent or Admin account.', { code: 'NOT_A_LISTER' });
    }
    const existing = await trx('building_maintainers').where({ building_id: id, user_id: userId }).first('id');
    if (existing) throw conflict('This user already maintains the building.', { code: 'ALREADY_MAINTAINER' });

    await trx('building_maintainers').insert({ building_id: id, user_id: userId, added_by: auth.user.id });
    await writeAudit(trx, {
      actorUserId: auth.user.id,
      actorType: actorTypeOf(access),
      action: 'maintainer.add',
      objectType: 'building_maintainer',
      objectId: userId,
      buildingId: id,
      changes: { userId },
    });
    return listMaintainers(trx, id);
  });
}

/** Removes a maintainer; access ends at once. The designated contact and the last maintainer stay. */
export async function removeMaintainer(auth: AuthContext, id: string, userId: string): Promise<MaintainerItem[]> {
  return withBuildingLock(auth, id, async ({ trx, access }) => {
    const target = await trx('building_maintainers').where({ building_id: id, user_id: userId }).first('id');
    if (!target) throw notFound('That user does not maintain this building.', { code: 'MAINTAINER_NOT_FOUND' });

    const building = (await trx('buildings').where({ id }).first('contact_user_id')) as {
      contact_user_id: string | null;
    };
    if (building.contact_user_id === userId) {
      throw conflict('This maintainer is the designated contact. Set another contact first.', {
        code: 'MAINTAINER_IS_CONTACT',
      });
    }
    const { n } = (await trx('building_maintainers').where({ building_id: id }).count('* as n').first()) as {
      n: string | number;
    };
    if (Number(n) <= 1) {
      throw conflict('A building needs at least one maintainer. Add another before removing this one.', {
        code: 'LAST_MAINTAINER',
      });
    }

    await trx('building_maintainers').where({ building_id: id, user_id: userId }).delete();
    await writeAudit(trx, {
      actorUserId: auth.user.id,
      actorType: actorTypeOf(access),
      action: 'maintainer.remove',
      objectType: 'building_maintainer',
      objectId: userId,
      buildingId: id,
      changes: { userId },
    });
    return listMaintainers(trx, id);
  });
}

/** BR-018 / FR-ENQ-003: the contact must be a maintainer of this building with a phone number. */
export async function setContact(auth: AuthContext, id: string, userId: string): Promise<BuildingItem> {
  return withBuildingLock(auth, id, async ({ trx, access }) => {
    const maintainer = await trx('building_maintainers').where({ building_id: id, user_id: userId }).first('id');
    if (!maintainer) {
      throw badRequest('The contact must be a maintainer of this building. Add them as a maintainer first.', {
        code: 'CONTACT_NOT_MAINTAINER',
      });
    }
    const profile = (await trx('profiles').where({ user_id: userId }).first('phone')) as
      | { phone: string | null }
      | undefined;
    if (!profile?.phone) {
      throw conflict('The designated contact needs a phone number on their profile.', {
        code: 'CONTACT_PHONE_REQUIRED',
      });
    }

    const before = (await trx('buildings').where({ id }).first('contact_user_id')) as {
      contact_user_id: string | null;
    };
    await trx('buildings').where({ id }).update({ contact_user_id: userId });
    await writeAudit(trx, {
      actorUserId: auth.user.id,
      actorType: actorTypeOf(access),
      action: 'building.contact.set',
      objectType: 'building',
      objectId: id,
      buildingId: id,
      changes: { before: { contactUserId: before.contact_user_id }, after: { contactUserId: userId } },
    });
    return loadBuilding(trx, id);
  });
}
