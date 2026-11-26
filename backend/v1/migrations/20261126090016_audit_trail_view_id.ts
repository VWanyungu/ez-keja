import type { Knex } from 'knex';

// Adds a stable `id` to audit_trail_v (design §7.2). Audit rows written in one transaction share
// `created_at` (now() is the transaction start), so keyset paging over `occurred_at` alone would
// skip or repeat rows at a page boundary; `(occurred_at, id)` is a total order. The new column is
// last, which CREATE OR REPLACE VIEW allows. Down drops and recreates the original definition.
const ORIGINAL = `
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
  JOIN space_types s ON s.id = e.space_type_id`;

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE OR REPLACE VIEW audit_trail_v AS
    SELECT a.created_at AS occurred_at, a.actor_user_id, a.action, a.object_type, a.object_id,
           a.building_id, a.changes, a.id
    FROM audit_log a
    UNION ALL
    SELECT e.created_at, e.actor_user_id, 'availability.' || e.event_type, 'space_type'::text,
           e.space_type_id, s.building_id,
           jsonb_build_object('old_count', e.old_count, 'new_count', e.new_count,
                              'source', e.source, 'acted_as_staff', e.acted_as_staff),
           e.id
    FROM availability_events e
    JOIN space_types s ON s.id = e.space_type_id`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP VIEW IF EXISTS audit_trail_v');
  await knex.raw(ORIGINAL);
}
