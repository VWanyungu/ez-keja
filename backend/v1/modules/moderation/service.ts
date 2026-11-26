import type { Knex } from 'knex';
import { withTx } from '../../db/tx.js';
import { writeAudit } from '../../lib/audit.js';
import { conflict, forbidden, HttpError, notFound } from '../../lib/http-error.js';
import { EVENT_MODERATION, maintainerRecipients, notifyEach } from '../../lib/notify.js';
import { revokeAllUserTokens } from '../../lib/tokens.js';
import type { AuthContext } from '../../middlewares/auth.js';
import { mapGateViolation } from '../buildings/service.js';

/**
 * Moderation (FR-ADM-003): suspend and reinstate users and buildings.
 *
 * Lock order (design §9.3): building rows ascending by id come first, then the profile row. The
 * buildings a user maintains are read once without a lock to know which rows to take, locked
 * `ORDER BY id FOR UPDATE`, and every decision is made again from the locked rows ("evaluated after
 * the lock", TX-09). A maintainer added to a building in the few milliseconds between that read and
 * the lock is not seen: the building keeps its status until the next moderation action.
 */

const LIVE_STATUSES = ['draft', 'pending', 'published'] as const;

export interface BuildingRef {
  id: string;
  name: string;
}

export interface UserModerationResult {
  userId: string;
  accountStatus: 'active' | 'suspended';
  buildings: {
    /** Suspended with `suspension_cause = 'owner_suspended'` (suspend only). */
    suspended: Array<BuildingRef & { from: string }>;
    /** Co-maintained and kept as it was, with a new designated contact (suspend only). */
    contactReassigned: Array<BuildingRef & { newContactUserId: string }>;
    /** Already suspended or withdrawn: untouched (suspend only). */
    skipped: Array<BuildingRef & { status: string }>;
    /** Back to the status they had before (reinstate only). */
    restored: Array<BuildingRef & { to: string }>;
    /** The publish gate refused the restore: still suspended (reinstate only). */
    blocked: Array<BuildingRef & { blockers: string[] }>;
  };
}

export interface BuildingModerationResult {
  buildingId: string;
  status: string;
  suspensionCause: string | null;
}

interface LockedBuilding {
  id: string;
  name: string;
  status: string;
  status_before_suspension: string | null;
  suspension_cause: string | null;
  contact_user_id: string | null;
}

/** `ORDER BY id FOR UPDATE`: the locks are taken in ascending id order (design §9.3). */
async function lockBuildings(trx: Knex.Transaction, ids: string[]): Promise<LockedBuilding[]> {
  if (ids.length === 0) return [];
  return (await trx('buildings')
    .whereIn('id', ids)
    .orderBy('id')
    .forUpdate()
    .select('id', 'name', 'status', 'status_before_suspension', 'suspension_cause', 'contact_user_id')) as LockedBuilding[];
}

/** Maintainers whose account is active and not erased, oldest first; `exceptUserId` is left out. */
async function activeMaintainers(
  trx: Knex.Transaction,
  buildingId: string,
  exceptUserId?: string,
): Promise<Array<{ user_id: string; phone: string | null }>> {
  const qb = trx('building_maintainers as m')
    .join('profiles as p', 'p.user_id', 'm.user_id')
    .where('m.building_id', buildingId)
    .where('p.account_status', 'active')
    .whereNull('p.erased_at')
    .orderBy('m.added_at')
    .orderBy('m.user_id')
    .select('m.user_id', 'p.phone');
  if (exceptUserId) qb.whereNot('m.user_id', exceptUserId);
  return (await qb) as Array<{ user_id: string; phone: string | null }>;
}

const CLEARED_SUSPENSION = {
  status_before_suspension: null,
  suspension_cause: null,
  suspended_reason: null,
  suspended_at: null,
  suspended_by: null,
} as const;

async function suspendBuildingRow(
  trx: Knex.Transaction,
  b: LockedBuilding,
  cause: 'admin' | 'owner_suspended',
  reason: string,
  actorId: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await trx('buildings').where({ id: b.id }).update({
    status: 'suspended',
    status_before_suspension: b.status,
    suspension_cause: cause,
    suspended_reason: reason,
    suspended_at: trx.fn.now(),
    suspended_by: actorId,
  });
  await writeAudit(trx, {
    actorUserId: actorId,
    actorType: 'staff',
    action: 'building.suspend',
    objectType: 'building',
    objectId: b.id,
    buildingId: b.id,
    changes: { from: b.status, to: 'suspended', cause, reason, ...extra },
  });
}

class NoActiveContact extends Error {}

/** A restore to `published` needs a designated contact who is active and has a phone (TX-15, T8). */
async function ensureActiveContact(trx: Knex.Transaction, b: LockedBuilding, actorId: string): Promise<void> {
  const active = await activeMaintainers(trx, b.id);
  if (b.contact_user_id && active.some((m) => m.user_id === b.contact_user_id)) return;
  const pick = active.find((m) => m.phone);
  if (!pick) throw new NoActiveContact();
  await trx('buildings').where({ id: b.id }).update({ contact_user_id: pick.user_id });
  await writeAudit(trx, {
    actorUserId: actorId,
    actorType: 'staff',
    action: 'building.contact.set',
    objectType: 'building',
    objectId: b.id,
    buildingId: b.id,
    changes: { before: { contactUserId: b.contact_user_id }, after: { contactUserId: pick.user_id }, cause: 'reinstatement' },
  });
}

type RestoreOutcome = { restored: true; to: string } | { restored: false; blockers: string[] };

/**
 * Puts a suspended building back to `status_before_suspension`. A restore to `published` runs the
 * T5 gate; it runs inside a savepoint so a refusal undoes only this building and the caller's
 * transaction carries on (the blockers come back in the outcome).
 */
async function restoreBuilding(
  trx: Knex.Transaction,
  b: LockedBuilding,
  actorId: string,
  reason: string,
  extra: Record<string, unknown> = {},
): Promise<RestoreOutcome> {
  const to = b.status_before_suspension!;
  try {
    await trx.transaction(async (sp) => {
      if (to === 'published') await ensureActiveContact(sp, b, actorId);
      await sp('buildings')
        .where({ id: b.id })
        .update({ status: to, ...CLEARED_SUSPENSION });
    });
  } catch (err) {
    if (err instanceof NoActiveContact) {
      return { restored: false, blockers: ['needs a designated contact who is active and has a phone number'] };
    }
    const mapped = mapGateViolation(err);
    if (mapped instanceof HttpError && mapped.code === 'PUBLISH_BLOCKED') {
      return { restored: false, blockers: (mapped.data as { blockers: string[] }).blockers };
    }
    throw mapped;
  }
  await writeAudit(trx, {
    actorUserId: actorId,
    actorType: 'staff',
    action: 'building.reinstate',
    objectType: 'building',
    objectId: b.id,
    buildingId: b.id,
    changes: { from: 'suspended', to, cause: b.suspension_cause, reason, ...extra },
  });
  return { restored: true, to };
}

const emptyBuildings = (): UserModerationResult['buildings'] => ({
  suspended: [], contactReassigned: [], skipped: [], restored: [], blocked: [],
});

/**
 * TX-09, suspend (FR-ADM-003, G-12). One transaction: lock the user's buildings, update the
 * profile, remove every session and refresh token (`revokeAllUserTokens`, run as a savepoint
 * inside this transaction), then, for each Draft, Pending or Published building left with no
 * other active maintainer, suspend it as `owner_suspended`. A co-maintained building stays as it
 * is; if the suspended user was its designated contact, the contact moves to another active
 * maintainer with a phone, and the building is suspended when there is none.
 */
export async function suspendUser(auth: AuthContext, userId: string, reason: string): Promise<UserModerationResult> {
  if (userId === auth.user.id) {
    throw forbidden('You cannot suspend your own account.', { code: 'CANNOT_SUSPEND_SELF' });
  }
  return withTx(async (trx) => {
    const maintained = (await trx('building_maintainers').where({ user_id: userId }).pluck('building_id')) as string[];
    const buildings = await lockBuildings(trx, maintained);

    const profile = (await trx('profiles').where({ user_id: userId }).forUpdate().first('account_status', 'erased_at')) as
      | { account_status: string; erased_at: Date | null }
      | undefined;
    if (!profile) throw notFound('User not found.', { code: 'USER_NOT_FOUND' });
    if (profile.erased_at) throw conflict('An erased account cannot be suspended.', { code: 'USER_ERASED' });
    if (profile.account_status === 'suspended') {
      throw conflict('This account is already suspended.', { code: 'ALREADY_SUSPENDED' });
    }

    const isAdmin = Boolean(await trx('user_roles').where({ user_id: userId, role: 'admin' }).first('id'));
    if (isAdmin) {
      // Two Admins suspending each other at once must not both pass the check below.
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', ['admin-set']);
      const others = (await trx('user_roles as r')
        .join('profiles as p', 'p.user_id', 'r.user_id')
        .where('r.role', 'admin')
        .whereNot('r.user_id', userId)
        .where('p.account_status', 'active')
        .whereNull('p.erased_at')
        .count({ n: 'r.id' })
        .first()) as { n: string | number };
      if (Number(others.n) === 0) {
        throw conflict('This is the last active Admin and cannot be suspended.', { code: 'LAST_ADMIN' });
      }
    }

    const result: UserModerationResult = { userId, accountStatus: 'suspended', buildings: emptyBuildings() };
    for (const b of buildings) {
      const ref = { id: b.id, name: b.name };
      if (!(LIVE_STATUSES as readonly string[]).includes(b.status)) {
        result.buildings.skipped.push({ ...ref, status: b.status });
        continue;
      }
      const others = await activeMaintainers(trx, b.id, userId);
      if (others.length > 0 && b.contact_user_id !== userId) continue; // someone else still runs it
      const replacement = others.find((m) => m.phone);
      if (replacement) {
        await trx('buildings').where({ id: b.id }).update({ contact_user_id: replacement.user_id });
        await writeAudit(trx, {
          actorUserId: auth.user.id,
          actorType: 'staff',
          action: 'building.contact.set',
          objectType: 'building',
          objectId: b.id,
          buildingId: b.id,
          changes: { before: { contactUserId: userId }, after: { contactUserId: replacement.user_id }, cause: 'owner_suspended' },
        });
        result.buildings.contactReassigned.push({ ...ref, newContactUserId: replacement.user_id });
        continue;
      }
      await suspendBuildingRow(trx, b, 'owner_suspended', reason, auth.user.id, { userId });
      result.buildings.suspended.push({ ...ref, from: b.status });
    }

    await trx('profiles').where({ user_id: userId }).update({
      account_status: 'suspended',
      suspended_reason: reason,
      suspended_at: trx.fn.now(),
      suspended_by: auth.user.id,
    });
    await revokeAllUserTokens(userId, 'account_suspended', trx);

    await writeAudit(trx, {
      actorUserId: auth.user.id,
      actorType: 'staff',
      action: 'user.suspend',
      objectType: 'user',
      objectId: userId,
      changes: {
        reason,
        buildingsSuspended: result.buildings.suspended.length,
        contactsReassigned: result.buildings.contactReassigned.length,
        buildingsSkipped: result.buildings.skipped.length,
      },
    });
    await notifyEach(trx, [userId], EVENT_MODERATION, {
      subject: 'account',
      action: 'suspended',
      reason,
      buildingsAffected: result.buildings.suspended.length,
    });
    return result;
  });
}

/**
 * TX-09, reinstate. Restores ONLY the buildings suspended as `owner_suspended` (G-12), each to
 * `status_before_suspension`; a restore to `published` re-runs T5 and, when it refuses, that
 * building stays suspended and is reported in `blocked` (the reinstatement itself still succeeds).
 * Buildings an Admin suspended directly (`suspension_cause = 'admin'`) stay suspended.
 */
export async function reinstateUser(auth: AuthContext, userId: string, reason: string): Promise<UserModerationResult> {
  return withTx(async (trx) => {
    const suspended = (await trx('buildings as b')
      .join('building_maintainers as m', 'm.building_id', 'b.id')
      .where('m.user_id', userId)
      .where('b.status', 'suspended')
      .where('b.suspension_cause', 'owner_suspended')
      .pluck('b.id')) as string[];
    const buildings = await lockBuildings(trx, suspended);

    const profile = (await trx('profiles').where({ user_id: userId }).forUpdate().first('account_status', 'erased_at')) as
      | { account_status: string; erased_at: Date | null }
      | undefined;
    if (!profile) throw notFound('User not found.', { code: 'USER_NOT_FOUND' });
    if (profile.erased_at) throw conflict('An erased account cannot be reinstated.', { code: 'USER_ERASED' });
    if (profile.account_status !== 'suspended') {
      throw conflict('This account is not suspended.', { code: 'NOT_SUSPENDED' });
    }

    await trx('profiles').where({ user_id: userId }).update({
      account_status: 'active',
      suspended_reason: null,
      suspended_at: null,
      suspended_by: null,
    });

    const result: UserModerationResult = { userId, accountStatus: 'active', buildings: emptyBuildings() };
    for (const b of buildings) {
      if (b.status !== 'suspended' || b.suspension_cause !== 'owner_suspended') continue; // changed while we waited
      const outcome = await restoreBuilding(trx, b, auth.user.id, reason, { userId });
      if (outcome.restored) result.buildings.restored.push({ id: b.id, name: b.name, to: outcome.to });
      else result.buildings.blocked.push({ id: b.id, name: b.name, blockers: outcome.blockers });
    }

    await writeAudit(trx, {
      actorUserId: auth.user.id,
      actorType: 'staff',
      action: 'user.reinstate',
      objectType: 'user',
      objectId: userId,
      changes: {
        reason,
        buildingsRestored: result.buildings.restored.length,
        buildingsBlocked: result.buildings.blocked.map((b) => ({ id: b.id, blockers: b.blockers })),
      },
    });
    await notifyEach(trx, [userId], EVENT_MODERATION, {
      subject: 'account',
      action: 'reinstated',
      reason,
      buildingsRestored: result.buildings.restored.length,
    });
    return result;
  });
}

/** FR-ADM-003: an Admin suspends a Draft, Pending or Published building (`suspension_cause = 'admin'`). */
export async function suspendBuilding(auth: AuthContext, buildingId: string, reason: string): Promise<BuildingModerationResult> {
  return withTx(async (trx) => {
    const [b] = await lockBuildings(trx, [buildingId]);
    if (!b) throw notFound('Building not found.', { code: 'BUILDING_NOT_FOUND' });
    if (b.status === 'suspended') throw conflict('This building is already suspended.', { code: 'ALREADY_SUSPENDED' });
    if (!(LIVE_STATUSES as readonly string[]).includes(b.status)) {
      throw conflict(`A ${b.status} building cannot be suspended.`, { code: 'INVALID_TRANSITION' });
    }
    await suspendBuildingRow(trx, b, 'admin', reason, auth.user.id);
    await notifyEach(trx, await maintainerRecipients(trx, buildingId), EVENT_MODERATION, {
      subject: 'building', action: 'suspended', buildingId, buildingName: b.name, reason,
    });
    return { buildingId, status: 'suspended', suspensionCause: 'admin' };
  });
}

/**
 * Back to `status_before_suspension`; a restore to `published` re-runs T5 and answers 409 with the
 * blockers when it refuses. A building suspended because its owner was suspended cannot come back
 * while it has no active maintainer: reinstate the owner (TX-09) instead.
 */
export async function reinstateBuilding(auth: AuthContext, buildingId: string, reason: string): Promise<BuildingModerationResult> {
  return withTx(async (trx) => {
    const [b] = await lockBuildings(trx, [buildingId]);
    if (!b) throw notFound('Building not found.', { code: 'BUILDING_NOT_FOUND' });
    if (b.status !== 'suspended') throw conflict('This building is not suspended.', { code: 'NOT_SUSPENDED' });
    if (b.suspension_cause === 'owner_suspended' && (await activeMaintainers(trx, buildingId)).length === 0) {
      throw conflict('This building was suspended because its owner was suspended. Reinstate the owner first.', {
        code: 'OWNER_SUSPENDED',
      });
    }
    const outcome = await restoreBuilding(trx, b, auth.user.id, reason);
    if (!outcome.restored) {
      throw conflict(`The building cannot be restored yet: ${outcome.blockers.join('; ')}.`, {
        code: 'PUBLISH_BLOCKED',
        data: { blockers: outcome.blockers },
      });
    }
    await notifyEach(trx, await maintainerRecipients(trx, buildingId), EVENT_MODERATION, {
      subject: 'building', action: 'reinstated', buildingId, buildingName: b.name, reason,
    });
    return { buildingId, status: outcome.to, suspensionCause: null };
  });
}
