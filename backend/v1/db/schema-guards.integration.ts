import { afterAll, describe, expect, it } from 'bun:test';
import type { Knex } from 'knex';
import db, { closeDb } from './knex.js';

// Schema and policy guards (design 7.2 triggers, 7.3 index policy, 10.2 protections, 16.3 step 5).
// Read-only against the throwaway database the integration runner migrated.

afterAll(async () => {
  await closeDb();
});

// A real Promise around a transaction: Knex returns a thenable that `expect(...).rejects` does not accept.
async function inTx(fn: (trx: Knex.Transaction) => PromiseLike<unknown>): Promise<void> {
  await db.transaction(async (trx) => {
    await fn(trx);
  });
}

// pg_trigger.tgtype bits: ROW 1, BEFORE 2, INSERT 4, DELETE 8, UPDATE 16, TRUNCATE 32.
const BEFORE_ROW_UPDATE_DELETE = 1 + 2 + 8 + 16;
const BEFORE_TRUNCATE_STATEMENT = 2 + 32;

interface ExpectedTrigger {
  id: string;
  table: string;
  trigger: string;
  fn: string;
  tgtype: number;
}

const EXPECTED_TRIGGERS: ExpectedTrigger[] = [
  // T2: append-only history. Two triggers per table: row-level UPDATE/DELETE and statement-level TRUNCATE.
  ...['availability_events', 'audit_log', 'consent_records'].flatMap((table) => [
    { id: 'T2', table, trigger: `trg_${table}_no_mutation`, fn: 'forbid_mutation', tgtype: BEFORE_ROW_UPDATE_DELETE },
    { id: 'T2', table, trigger: `trg_${table}_no_truncate`, fn: 'forbid_mutation', tgtype: BEFORE_TRUNCATE_STATEMENT },
  ]),
  // T3: verification cache kept in step with the newest case.
  { id: 'T3', table: 'verification_cases', trigger: 'trg_vc_guard', fn: 'sync_verification_status', tgtype: 1 + 2 + 4 + 16 },
  { id: 'T3', table: 'verification_cases', trigger: 'trg_vc_sync', fn: 'sync_verification_status', tgtype: 1 + 4 + 16 },
  // T5: publish gate (on insert, and on a status change).
  { id: 'T5', table: 'buildings', trigger: 'trg_buildings_publish_gate_insert', fn: 'enforce_publish_gate', tgtype: 1 + 2 + 4 },
  { id: 'T5', table: 'buildings', trigger: 'trg_buildings_publish_gate_update', fn: 'enforce_publish_gate', tgtype: 1 + 2 + 16 },
  // T6: re-verification on a material change.
  { id: 'T6', table: 'buildings', trigger: 'trg_buildings_reverify', fn: 'reverify_on_material_change', tgtype: 1 + 16 },
  // T7: verification_status writable only through T3/T6.
  { id: 'T7', table: 'profiles', trigger: 'trg_profiles_guard_verification', fn: 'guard_verification_columns', tgtype: 1 + 2 + 4 + 16 },
  { id: 'T7', table: 'buildings', trigger: 'trg_buildings_guard_verification', fn: 'guard_verification_columns', tgtype: 1 + 2 + 4 + 16 },
  // T8: the designated contact keeps a phone.
  { id: 'T8', table: 'profiles', trigger: 'trg_profiles_guard_contact_phone', fn: 'guard_contact_phone', tgtype: 1 + 2 + 16 },
  { id: 'T8', table: 'buildings', trigger: 'trg_buildings_guard_contact_phone', fn: 'guard_contact_phone', tgtype: 1 + 2 + 16 },
];

interface TriggerRow {
  relname: string;
  tgname: string;
  tgenabled: string;
  tgtype: number;
  proname: string;
}

describe('triggers T2, T3, T5, T6, T7, T8 (design 7.2, 10.2 item 2)', () => {
  it.each(EXPECTED_TRIGGERS)('$id: $table.$trigger exists, is enabled and calls $fn', async ({ table, trigger, fn, tgtype }) => {
    const { rows } = await db.raw<{ rows: TriggerRow[] }>(
      `SELECT c.relname, t.tgname, t.tgenabled, t.tgtype, p.proname
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace AND c.relname = ? AND t.tgname = ?`,
      [table, trigger],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tgenabled).toBe('O'); // 'O' = enabled in origin mode; 'D' means somebody disabled it
    expect(rows[0]?.proname).toBe(fn);
    expect(Number(rows[0]?.tgtype)).toBe(tgtype);
  });

  it('has no disabled trigger anywhere in the public schema', async () => {
    const { rows } = await db.raw<{ rows: Array<{ relname: string; tgname: string }> }>(
      `SELECT c.relname, t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace AND t.tgenabled <> 'O'`,
    );
    expect(rows).toEqual([]);
  });

  it.each(['availability_events', 'audit_log', 'consent_records'])('T2 refuses TRUNCATE on %s (nothing is removed)', async (table) => {
    await expect(inTx((trx) => trx.raw(`TRUNCATE ${table}`))).rejects.toThrow(/append-only/);
  });

  it.each(['availability_events', 'audit_log', 'consent_records'])('T2 refuses UPDATE and DELETE of an existing %s row', async (table) => {
    const row = await db(table).first('id');
    if (!row) return; // empty on a fresh database; the trigger definition is asserted above
    await expect(inTx((trx) => trx(table).where({ id: row.id }).update({ id: row.id }))).rejects.toThrow(/append-only/);
    await expect(inTx((trx) => trx(table).where({ id: row.id }).del())).rejects.toThrow(/append-only/);
  });
});

// Design 3.3 and 7.3: every foreign key column is indexed. A column whose only index is PARTIAL is a
// known, accepted exception: the parent rows are never deleted (BR-021, no delete in the data-access
// layer), so no ON DELETE RESTRICT check ever scans it. This list is those nine foreign keys. A new
// foreign key without a plain index must either get one or be added here on purpose, with a reason.
const PARTIAL_INDEX_ONLY_FKS: Record<string, string> = {
  ad_campaigns_slot_id_foreign: 'ix_ac_slot_active (status = active)',
  ad_daily_metrics_campaign_id_foreign: 'ux_adm_campaign_day (campaign_id IS NOT NULL)',
  ad_daily_metrics_provider_id_foreign: 'ux_adm_provider_day (provider_id IS NOT NULL)',
  audit_log_building_id_foreign: 'ix_audit_building_time (building_id IS NOT NULL)',
  buildings_area_id_foreign: 'ix_buildings_area_published (status = published)',
  photos_building_id_foreign: 'ix_photos_building_gallery, ux_photos_one_cover (removed_at IS NULL)',
  photos_space_type_id_foreign: 'ix_photos_space_type_gallery (removed_at IS NULL)',
  service_providers_category_id_foreign: 'ix_sp_active_window (status = active)',
  viewing_requests_space_type_id_foreign: 'ix_vr_open_by_space_type (open statuses)',
};

describe('foreign key index policy (design 7.3)', () => {
  // The postgres-patterns query, tightened the way design 3.3 describes it: the FK's first column must
  // LEAD a plain (non-partial) index. A composite FK is judged by its first column.
  const UNINDEXED_FK_QUERY = `
    SELECT c.conname, c.conrelid::regclass::text AS table_name, a.attname AS column_name,
           (SELECT count(*) FROM pg_index i
             WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1] AND i.indpred IS NOT NULL)::int AS partial_indexes
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
       AND NOT EXISTS (SELECT 1 FROM pg_index i
                        WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1] AND i.indpred IS NULL)
     ORDER BY c.conname`;

  it('finds exactly the nine known partial-index-only foreign keys and nothing else', async () => {
    const { rows } = await db.raw<{ rows: Array<{ conname: string; table_name: string; column_name: string; partial_indexes: number }> }>(UNINDEXED_FK_QUERY);
    const found = rows.map((r) => r.conname).sort();
    expect(found).toEqual(Object.keys(PARTIAL_INDEX_ONLY_FKS).sort());
  });

  it('every allow-listed foreign key is still served by at least one partial index (an unindexed FK is not an exception)', async () => {
    const { rows } = await db.raw<{ rows: Array<{ conname: string; partial_indexes: number }> }>(UNINDEXED_FK_QUERY);
    for (const row of rows) expect(row.partial_indexes).toBeGreaterThanOrEqual(1);
  });
});
