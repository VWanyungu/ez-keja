import type { Knex } from 'knex';
import { conflict, notFound } from './http-error.js';
import { hasActiveMaintainerSql } from './public-catalogue.js';

type Conn = Knex | Knex.Transaction;

export interface SpaceTypeContext {
  id: string;
  name: string;
  vacantCount: number;
  removed: boolean;
  buildingId: string;
  buildingName: string;
  buildingStatus: string;
  hasActiveMaintainer: boolean;
}

interface ContextRow {
  id: string;
  name: string;
  vacant_count: number;
  removed_at: Date | null;
  building_id: string;
  building_name: string;
  building_status: string;
  has_active_maintainer: boolean;
}

const toContext = (r: ContextRow): SpaceTypeContext => ({
  id: r.id,
  name: r.name,
  vacantCount: r.vacant_count,
  removed: r.removed_at !== null,
  buildingId: r.building_id,
  buildingName: r.building_name,
  buildingStatus: r.building_status,
  hasActiveMaintainer: r.has_active_maintainer,
});

const CONTEXT_SQL = `
  SELECT st.id, st.name, st.vacant_count, st.removed_at, b.id AS building_id, b.name AS building_name,
         b.status AS building_status, ${hasActiveMaintainerSql('b')} AS has_active_maintainer
    FROM space_types st JOIN buildings b ON b.id = st.building_id
   WHERE st.id = ?`;

/**
 * TX-06 / TX-07: the space type and its building, read with `FOR SHARE OF st` so a count change to
 * 0 or a removal (which take `FOR UPDATE`, TX-01 / TX-13) cannot slip in between this check and the
 * insert that follows. Lock order (design §9.3): the space type first, then the enquiry or viewing
 * rows. Throws 404 for an unknown id.
 */
export async function lockSpaceTypeContext(trx: Knex.Transaction, spaceTypeId: string): Promise<SpaceTypeContext> {
  const result = (await trx.raw(`${CONTEXT_SQL} FOR SHARE OF st`, [spaceTypeId])) as { rows: ContextRow[] };
  if (!result.rows[0]) throw notFound('Space type not found.', { code: 'SPACE_TYPE_NOT_FOUND' });
  return toContext(result.rows[0]);
}

/** Same shape without the lock: for the report target check and for reads. */
export async function loadSpaceTypeContext(conn: Conn, spaceTypeId: string): Promise<SpaceTypeContext> {
  const result = (await conn.raw(CONTEXT_SQL, [spaceTypeId])) as { rows: ContextRow[] };
  if (!result.rows[0]) throw notFound('Space type not found.', { code: 'SPACE_TYPE_NOT_FOUND' });
  return toContext(result.rows[0]);
}

/**
 * FR-ENQ-001 / FR-ENQ-002: a client can only start contact about a Vacant space type of a building
 * that is on public display. Anything else is a 409 with a notice the screen can show.
 */
export function assertOpenForContact(ctx: SpaceTypeContext, what: 'enquiry' | 'viewing request'): void {
  if (ctx.removed) {
    throw conflict(`This space type is no longer listed, so a new ${what} cannot be made.`, { code: 'SPACE_TYPE_REMOVED' });
  }
  if (ctx.buildingStatus !== 'published' || !ctx.hasActiveMaintainer) {
    throw conflict(`This building is not available, so a new ${what} cannot be made.`, { code: 'BUILDING_UNAVAILABLE' });
  }
  if (ctx.vacantCount === 0) {
    throw conflict(`This space type is fully let, so a new ${what} cannot be made.`, { code: 'SPACE_TYPE_FULLY_LET' });
  }
}

export async function isMaintainerOf(conn: Conn, buildingId: string, userId: string): Promise<boolean> {
  return Boolean(await conn('building_maintainers').where({ building_id: buildingId, user_id: userId }).first('id'));
}

/** Truncates a message for list previews. */
export const preview = (text: string, max = 160): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
