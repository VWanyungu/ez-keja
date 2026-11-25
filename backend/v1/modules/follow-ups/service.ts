import db from '../../db/knex.js';
import { withTx } from '../../db/tx.js';
import { assertBuildingEditable } from '../../lib/catalogue.js';
import { isoMicros, outdatedSql } from '../../lib/freshness.js';
import { notFound } from '../../lib/http-error.js';
import type { AuthContext } from '../../middlewares/auth.js';
import { applyVacantCount, lockLiveSpaceType, type AvailabilityChange } from '../availability/service.js';
import type { FollowUpOutcome, RecordFollowUpInput } from './schemas.js';

export interface FollowUpContact {
  userId: string;
  displayName: string;
  email: string;
  phone: string | null;
}

export interface FollowUpNote {
  outcome: FollowUpOutcome;
  note: string | null;
  staffUserId: string;
  createdAt: string;
}

export interface FollowUpSpaceType {
  id: string;
  name: string;
  vacantCount: number;
  lastConfirmedAt: string;
  daysSinceLastUpdate: number;
  /** The latest follow-up said "unreachable" and nobody has confirmed since (FR-ADM-002). */
  unreachable: boolean;
  lastFollowUp: FollowUpNote | null;
}

export interface FollowUpBuilding {
  buildingId: string;
  buildingName: string;
  areaId: string;
  lister: FollowUpContact | null;
  designatedContact: FollowUpContact | null;
  /** No active maintainer can receive reminders: only a follow-up call reaches this building. */
  noActiveMaintainer: boolean;
  spaceTypes: FollowUpSpaceType[];
}

interface QueueRow {
  id: string;
  building_id: string;
  building_name: string;
  area_id: string;
  lister_id: string;
  contact_user_id: string | null;
  no_active_maintainer: boolean;
  name: string;
  vacant_count: number;
  last_confirmed_at: string;
  days_since: number;
  unreachable: boolean;
  f_outcome: FollowUpOutcome | null;
  f_note: string | null;
  f_staff_user_id: string | null;
  f_created_at: string | null;
}

/**
 * FR-ADM-002: Vacant space types past the BR-001 threshold, grouped by building, most overdue
 * first (buildings ordered by their most overdue space type). Only Published buildings are
 * listed: Draft, Pending, Suspended and Withdrawn ones are not on public display (design QP-05).
 */
export async function listFollowUpQueue(): Promise<FollowUpBuilding[]> {
  const rows = ((await db.raw(`
    SELECT st.id, st.building_id, b.name AS building_name, b.area_id, b.lister_id, b.contact_user_id,
           NOT EXISTS (SELECT 1 FROM building_maintainers m JOIN profiles mp ON mp.user_id = m.user_id
                        WHERE m.building_id = b.id AND mp.account_status = 'active' AND mp.erased_at IS NULL)
             AS no_active_maintainer,
           st.name, st.vacant_count, ${isoMicros('st.last_confirmed_at')} AS last_confirmed_at,
           floor(extract(epoch FROM (clock_timestamp() - st.last_confirmed_at)) / 86400)::int AS days_since,
           COALESCE(f.outcome = 'unreachable' AND f.created_at > st.last_confirmed_at, false) AS unreachable,
           f.outcome AS f_outcome, f.note AS f_note, f.staff_user_id AS f_staff_user_id,
           ${isoMicros('f.created_at')} AS f_created_at
      FROM space_types st
      JOIN buildings b ON b.id = st.building_id AND b.status = 'published'
      LEFT JOIN LATERAL (
        SELECT outcome, note, staff_user_id, created_at FROM followups
         WHERE space_type_id = st.id ORDER BY created_at DESC, id DESC LIMIT 1
      ) f ON true
     WHERE ${outdatedSql('st')}
     ORDER BY st.last_confirmed_at, st.id`)) as { rows: QueueRow[] }).rows;
  if (rows.length === 0) return [];

  const userIds = [...new Set(rows.flatMap((r) => [r.lister_id, r.contact_user_id].filter((id): id is string => !!id)))];
  const people = (await db('profiles as p')
    .join('auth_users as u', 'u.id', 'p.user_id')
    .whereIn('p.user_id', userIds)
    .select('p.user_id', 'p.display_name', 'p.phone', 'u.email')) as Array<{
    user_id: string;
    display_name: string;
    phone: string | null;
    email: string;
  }>;
  const contactOf = new Map<string, FollowUpContact>(
    people.map((p) => [p.user_id, { userId: p.user_id, displayName: p.display_name, email: p.email, phone: p.phone }]),
  );

  const buildings = new Map<string, FollowUpBuilding>();
  for (const r of rows) {
    let building = buildings.get(r.building_id);
    if (!building) {
      building = {
        buildingId: r.building_id,
        buildingName: r.building_name,
        areaId: r.area_id,
        lister: contactOf.get(r.lister_id) ?? null,
        designatedContact: r.contact_user_id ? (contactOf.get(r.contact_user_id) ?? null) : null,
        noActiveMaintainer: r.no_active_maintainer,
        spaceTypes: [],
      };
      buildings.set(r.building_id, building);
    }
    building.spaceTypes.push({
      id: r.id,
      name: r.name,
      vacantCount: r.vacant_count,
      lastConfirmedAt: r.last_confirmed_at,
      daysSinceLastUpdate: r.days_since,
      unreachable: r.unreachable,
      lastFollowUp: r.f_outcome
        ? { outcome: r.f_outcome, note: r.f_note, staffUserId: r.f_staff_user_id!, createdAt: r.f_created_at! }
        : null,
    });
  }
  return [...buildings.values()]; // rows were ordered most overdue first, and Map keeps insertion order
}

export interface RecordedFollowUp {
  id: string;
  spaceTypeId: string;
  outcome: FollowUpOutcome;
  note: string | null;
  /** The TX-01 result for `confirmed` and `fully_let`; null for `unreachable`. */
  change: AvailabilityChange | null;
}

/**
 * FR-ADM-002: record what the call found. `confirmed` and `fully_let` also apply TX-01 as staff
 * (FR-ADM-001), in the same transaction as the follow-up row, so the queue and the history never
 * disagree. `unreachable` only logs and flags. The router has already required the Admin role.
 */
export async function recordFollowUp(
  auth: AuthContext,
  spaceTypeId: string,
  input: RecordFollowUpInput,
): Promise<RecordedFollowUp> {
  return withTx(async (trx) => {
    const locked = await lockLiveSpaceType(trx, spaceTypeId);

    let change: AvailabilityChange | null = null;
    if (input.outcome !== 'unreachable') {
      const building = (await trx('buildings').where({ id: locked.building_id }).first('status')) as { status: string };
      assertBuildingEditable({ status: building.status, isAdmin: true });
      change = await applyVacantCount(trx, locked, input.outcome === 'confirmed' ? input.vacantCount! : 0, {
        userId: auth.user.id,
        actedAsStaff: true,
        source: 'follow_up',
      });
    }

    const [row] = (await trx('followups')
      .insert({ space_type_id: spaceTypeId, staff_user_id: auth.user.id, outcome: input.outcome, note: input.note })
      .returning('id')) as Array<{ id: string }>;
    if (!row) throw notFound('Space type not found.', { code: 'SPACE_TYPE_NOT_FOUND' });
    return { id: row.id, spaceTypeId, outcome: input.outcome, note: input.note, change };
  });
}
