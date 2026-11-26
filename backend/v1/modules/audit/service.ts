import type { Knex } from 'knex';
import db from '../../db/knex.js';
import { withTx } from '../../db/tx.js';
import { writeAudit } from '../../lib/audit.js';
import { toCsv } from '../../lib/csv.js';
import { isoMicros } from '../../lib/freshness.js';
import { keysetPage, keysetWhere, type KeysetCursor } from '../../lib/keyset.js';
import type { AuthContext } from '../../middlewares/auth.js';
import type { AuditFilters } from './schemas.js';

/** A CSV export holds at most this many rows; the response says when more matched (`X-Export-Truncated`). */
export const AUDIT_EXPORT_ROW_CAP = 10_000;

export interface AuditRecord {
  id: string;
  occurredAt: string;
  actorUserId: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
  buildingId: string | null;
  changes: Record<string, unknown>;
}

interface Row {
  id: string;
  occurred_at: string;
  cursor_t: string;
  actor_user_id: string | null;
  action: string;
  object_type: string;
  object_id: string | null;
  building_id: string | null;
  changes: Record<string, unknown>;
}

/**
 * The filters over `audit_trail_v`. `userId` matches what the user DID (they are the actor) and what
 * was done TO them (a user object with that id), so one search shows the whole story of an account.
 */
function searchQuery(conn: Knex | Knex.Transaction, f: AuditFilters): Knex.QueryBuilder {
  const qb = conn('audit_trail_v')
    .select(
      'id', 'actor_user_id', 'action', 'object_type', 'object_id', 'building_id', 'changes',
      conn.raw(`${isoMicros('occurred_at')} AS occurred_at`),
      conn.raw('occurred_at::text AS cursor_t'),
    )
    .orderBy('occurred_at', 'desc')
    .orderBy('id', 'desc');
  if (f.userId) {
    qb.where((w) =>
      w.where('actor_user_id', f.userId!).orWhere((o) => o.where('object_type', 'user').where('object_id', f.userId!)),
    );
  }
  if (f.buildingId) qb.where('building_id', f.buildingId);
  if (f.action) qb.where('action', f.action);
  if (f.from) qb.where('occurred_at', '>=', f.from.toISOString());
  if (f.toExclusive) qb.where('occurred_at', '<', f.toExclusive.toISOString());
  return qb;
}

const toRecord = (r: Row): AuditRecord => ({
  id: r.id,
  occurredAt: r.occurred_at,
  actorUserId: r.actor_user_id,
  action: r.action,
  objectType: r.object_type,
  objectId: r.object_id,
  buildingId: r.building_id,
  changes: r.changes,
});

/** FR-ADM-007: newest first, keyset paged by `(occurred_at, id)`. No match is an empty page, not an error. */
export async function searchAudit(
  filters: AuditFilters,
  page: { limit: number; cursor: KeysetCursor | null },
): Promise<{ items: AuditRecord[]; nextCursor: string | null }> {
  const qb = searchQuery(db, filters).limit(page.limit + 1);
  const where = keysetWhere('occurred_at', 'id', page.cursor);
  if (where) qb.whereRaw(where[0], where[1]);
  const result = keysetPage((await qb) as Row[], page.limit);
  return { items: result.items.map(toRecord), nextCursor: result.nextCursor };
}

const CSV_HEADERS = ['occurred_at', 'actor_user_id', 'action', 'object_type', 'object_id', 'building_id', 'changes'] as const;

/** FR-RPT-002: the same search as a CSV file. The `export.run` audit row is written in the same transaction. */
export async function exportAuditCsv(
  auth: AuthContext,
  filters: AuditFilters,
): Promise<{ csv: string; rowCount: number; truncated: boolean }> {
  return withTx(async (trx) => {
    const rows = (await searchQuery(trx, filters).limit(AUDIT_EXPORT_ROW_CAP + 1)) as Row[];
    const truncated = rows.length > AUDIT_EXPORT_ROW_CAP;
    const kept = truncated ? rows.slice(0, AUDIT_EXPORT_ROW_CAP) : rows;
    await writeAudit(trx, {
      actorUserId: auth.user.id,
      actorType: 'staff',
      action: 'export.run',
      objectType: 'export',
      changes: {
        export: 'audit',
        filters: {
          userId: filters.userId,
          buildingId: filters.buildingId,
          action: filters.action,
          from: filters.from?.toISOString() ?? null,
          toExclusive: filters.toExclusive?.toISOString() ?? null,
        },
        rowCount: kept.length,
        truncated,
      },
    });
    const csv = toCsv(
      CSV_HEADERS,
      kept.map((r) => [r.occurred_at, r.actor_user_id, r.action, r.object_type, r.object_id, r.building_id, r.changes]),
    );
    return { csv, rowCount: kept.length, truncated };
  });
}
