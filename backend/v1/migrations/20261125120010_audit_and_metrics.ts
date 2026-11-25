import type { Knex } from 'knex';
import { addChecks, appendOnly, createdAt, dropTables, fk, oneOf, pk } from '../db/helpers.js';

// audit_log, metric_snapshots and the audit_trail_v view (design §5.7, §7.2).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('audit_log', (t) => {
    pk(knex, t);
    fk(t, 'actor_user_id', 'auth_users', { optional: true });
    t.text('actor_type').notNullable();
    t.text('action').notNullable();
    t.text('object_type').notNullable();
    t.uuid('object_id');
    // Deliberate denormalisation so FR-ADM-007 can search by building without joins.
    fk(t, 'building_id', 'buildings', { optional: true });
    t.jsonb('changes').notNullable().defaultTo('{}');
    createdAt(knex, t);
  });
  await addChecks(knex, 'audit_log', {
    ck_audit_actor_type: oneOf('actor_type', ['user', 'staff', 'system']),
    ck_audit_actor: "actor_type = 'system' OR actor_user_id IS NOT NULL",
  });
  await knex.raw('CREATE INDEX ix_audit_actor_time ON audit_log (actor_user_id, created_at DESC)');
  await knex.raw(`CREATE INDEX ix_audit_building_time ON audit_log (building_id, created_at DESC)
                  WHERE building_id IS NOT NULL`);
  await knex.raw('CREATE INDEX ix_audit_object ON audit_log (object_type, object_id, created_at DESC)');
  await knex.raw('CREATE INDEX ix_audit_created_at ON audit_log (created_at)');
  await appendOnly(knex, 'audit_log');

  await knex.schema.createTable('metric_snapshots', (t) => {
    pk(knex, t);
    t.date('snapshot_date').notNullable();
    t.text('metric_code').notNullable();
    fk(t, 'area_id', 'areas', { optional: true });
    fk(t, 'category_id', 'space_categories', { optional: true });
    t.text('management_type');
    t.decimal('numerator');
    t.decimal('denominator');
    t.decimal('value').notNullable();
    createdAt(knex, t);
    t.index(['area_id'], 'ix_snapshots_area_id');
    t.index(['category_id'], 'ix_snapshots_category_id');
  });
  await addChecks(knex, 'metric_snapshots', {
    ck_snapshots_metric: oneOf('metric_code', ['RPT-M02', 'RPT-M03', 'RPT-M04', 'RPT-M09']),
    ck_snapshots_management: `management_type IS NULL OR ${oneOf('management_type', ['agent', 'landlord'])}`,
  });
  // NULL area, category or management type means "all"; COALESCE makes NULLs collide in the key.
  await knex.raw(`CREATE UNIQUE INDEX ux_snapshots_key ON metric_snapshots (
                    snapshot_date, metric_code,
                    COALESCE(area_id, '00000000-0000-0000-0000-000000000000'::uuid),
                    COALESCE(category_id, '00000000-0000-0000-0000-000000000000'::uuid),
                    COALESCE(management_type, ''))`);

  // One timeline of changes: audit rows plus availability events (counts are not written twice).
  await knex.raw(`
    CREATE VIEW audit_trail_v AS
    SELECT a.created_at AS occurred_at, a.actor_user_id, a.action, a.object_type, a.object_id,
           a.building_id, a.changes
    FROM audit_log a
    UNION ALL
    SELECT e.created_at, e.actor_user_id, 'availability.' || e.event_type, 'space_type'::text,
           e.space_type_id, s.building_id,
           jsonb_build_object('old_count', e.old_count, 'new_count', e.new_count,
                              'source', e.source, 'acted_as_staff', e.acted_as_staff)
    FROM availability_events e
    JOIN space_types s ON s.id = e.space_type_id`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP VIEW IF EXISTS audit_trail_v');
  await dropTables(knex, ['metric_snapshots', 'audit_log']);
}
