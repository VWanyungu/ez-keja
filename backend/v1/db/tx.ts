import type { Knex } from 'knex';
import db from './knex.js';
import { notFound } from '../lib/http-error.js';

/**
 * LOCK ORDER (design §9.3). Every transaction that touches more than one row of the catalogue
 * takes its locks in this order, so two of them can never wait on each other:
 *
 *   1. the `buildings` row (`FOR UPDATE`), then
 *   2. that building's space types, ascending by `id`, then
 *   3. child rows (photos, enquiries, viewings, maintainers).
 *
 * Operations over several buildings lock the buildings ascending by `id`. Single-row count
 * confirmations lock only their own space type row (no building lock; no parent cache exists).
 * Use `lockBuildingRow` and `lockLiveSpaceTypes` below rather than writing the SELECT again.
 */

const RETRYABLE_SQLSTATES = new Set(['40P01', '40001']); // deadlock_detected, serialization_failure

export type TxRunner = Pick<Knex, 'transaction'>;

/**
 * Runs `fn` in one transaction and, if PostgreSQL aborts it with a deadlock or serialization
 * failure, runs it once more from the start (design §9.3). `fn` must therefore be safe to run
 * twice: do database work only, and send notifications or call other services after it returns.
 */
export async function withTx<T>(
  fn: (trx: Knex.Transaction) => Promise<T>,
  conn: TxRunner = db,
): Promise<T> {
  try {
    return await conn.transaction(fn);
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && RETRYABLE_SQLSTATES.has(code)) {
      return await conn.transaction(fn);
    }
    throw err;
  }
}

export interface LockedBuildingRow {
  id: string;
  status: string;
  status_before_suspension: string | null;
  version: number;
}

/** Step 1 of the lock order. Throws 404 when the building does not exist. */
export async function lockBuildingRow(
  trx: Knex.Transaction,
  buildingId: string,
): Promise<LockedBuildingRow> {
  const row = (await trx('buildings')
    .where({ id: buildingId })
    .forUpdate()
    .first('id', 'status', 'status_before_suspension', 'version')) as LockedBuildingRow | undefined;
  if (!row) throw notFound('Building not found.', { code: 'BUILDING_NOT_FOUND' });
  return row;
}

/** Step 2 of the lock order: the building's live (not removed) space types, ascending by id. */
export async function lockLiveSpaceTypes(
  trx: Knex.Transaction,
  buildingId: string,
): Promise<Array<{ id: string; name: string; vacant_count: number }>> {
  return (await trx('space_types')
    .where({ building_id: buildingId })
    .whereNull('removed_at')
    .orderBy('id')
    .forUpdate()
    .select('id', 'name', 'vacant_count')) as Array<{ id: string; name: string; vacant_count: number }>;
}
