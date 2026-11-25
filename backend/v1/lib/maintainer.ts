import type { Knex } from 'knex';
import db from '../db/knex.js';
import type { AuthContext } from '../middlewares/auth.js';
import { forbidden, notFound } from './http-error.js';

export interface BuildingAccess {
  buildingId: string;
  status: string;
  statusBeforeSuspension: string | null;
  isAdmin: boolean;
  isMaintainer: boolean;
  /** An Admin who does not maintain the building acts on behalf of its maintainers (FR-ADM-001). */
  actsAsStaff: boolean;
}

/**
 * Loads a building and proves the caller may maintain it (BR-003, FR-UNT-006): a maintainer of
 * that building, or an Admin. Throws 404 for an unknown building and 403 for anyone else.
 */
export async function loadBuildingAccess(
  auth: Pick<AuthContext, 'user' | 'roles'>,
  buildingId: string,
  conn: Knex | Knex.Transaction = db,
): Promise<BuildingAccess> {
  const building = (await conn('buildings')
    .where({ id: buildingId })
    .first('id', 'status', 'status_before_suspension')) as
    | { id: string; status: string; status_before_suspension: string | null }
    | undefined;
  if (!building) throw notFound('Building not found.', { code: 'BUILDING_NOT_FOUND' });

  const isAdmin = auth.roles.includes('admin');
  const isMaintainer = Boolean(
    await conn('building_maintainers')
      .where({ building_id: buildingId, user_id: auth.user.id })
      .first('id'),
  );
  if (!isAdmin && !isMaintainer) {
    throw forbidden('You do not maintain this building.', { code: 'NOT_A_MAINTAINER' });
  }

  return {
    buildingId: building.id,
    status: building.status,
    statusBeforeSuspension: building.status_before_suspension,
    isAdmin,
    isMaintainer,
    actsAsStaff: isAdmin && !isMaintainer,
  };
}

/** True while the building is, or was before an admin suspension, on public display. */
export function isPublishedLike(access: Pick<BuildingAccess, 'status' | 'statusBeforeSuspension'>): boolean {
  return (
    access.status === 'published' ||
    (access.status === 'suspended' && access.statusBeforeSuspension === 'published')
  );
}
