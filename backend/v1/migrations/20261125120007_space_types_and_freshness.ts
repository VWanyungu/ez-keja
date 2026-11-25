import type { Knex } from 'knex';
import {
  addChecks, appendOnly, createdAt, dropTables, fk, oneOf, pk, timestamps, touchUpdatedAt, tstz,
} from '../db/helpers.js';

// space_types, photos, availability_events, followups, reminder_log (design §5.3).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('space_types', (t) => {
    pk(knex, t);
    fk(t, 'building_id', 'buildings');
    t.text('name').notNullable();
    fk(t, 'category_id', 'space_categories');
    t.decimal('size_sqm', 8, 2);
    t.text('rent_mode').notNullable();
    fk(t, 'currency_id', 'currencies');
    t.decimal('rent_amount', 14, 2);
    t.decimal('deposit_amount', 14, 2).notNullable();
    t.integer('vacant_count').notNullable().defaultTo(0);
    tstz(t, 'last_confirmed_at').notNullable().defaultTo(knex.fn.now());
    fk(t, 'created_by', 'auth_users');
    tstz(t, 'removed_at');
    fk(t, 'removed_by', 'auth_users', { optional: true });
    t.integer('version').notNullable().defaultTo(1);
    timestamps(knex, t);
    t.index(['building_id'], 'ix_space_types_building_id');
    t.index(['category_id'], 'ix_space_types_category_id');
    t.index(['currency_id'], 'ix_space_types_currency_id');
    t.index(['created_by'], 'ix_space_types_created_by');
    t.index(['removed_by'], 'ix_space_types_removed_by');
  });
  await addChecks(knex, 'space_types', {
    ck_space_types_name_len: 'length(name) BETWEEN 1 AND 100',
    ck_space_types_rent_mode: oneOf('rent_mode', ['fixed', 'on_interest']),
    ck_space_types_rent: `
      (rent_mode = 'fixed' AND rent_amount IS NOT NULL AND rent_amount > 0)
      OR (rent_mode = 'on_interest' AND rent_amount IS NULL)`,
    ck_space_types_deposit: 'deposit_amount >= 0',
    ck_space_types_count: 'vacant_count >= 0',
    ck_space_types_size: 'size_sqm IS NULL OR size_sqm > 0',
    ck_space_types_removed: '(removed_at IS NULL) = (removed_by IS NULL)',
  });
  await knex.raw(`CREATE UNIQUE INDEX ux_space_types_building_name ON space_types (building_id, lower(name))
                  WHERE removed_at IS NULL`);
  // Covers the BR-002 "has a Vacant space type" test and the card rent range (QP-01, QP-04).
  await knex.raw(`CREATE INDEX ix_space_types_building_vacant ON space_types (building_id)
                  INCLUDE (category_id, currency_id, rent_mode, rent_amount)
                  WHERE vacant_count > 0 AND removed_at IS NULL`);
  await touchUpdatedAt(knex, 'space_types');

  // Exclusive arc: one owner, a building or a space type. file_visibility is generated so the
  // composite FK can only ever point at a 'public' file (design R-15, V-1).
  await knex.schema.createTable('photos', (t) => {
    pk(knex, t);
    fk(t, 'building_id', 'buildings', { optional: true });
    fk(t, 'space_type_id', 'space_types', { optional: true });
    t.text('category').notNullable();
    t.uuid('file_id').notNullable();
    t.specificType('file_visibility', "text GENERATED ALWAYS AS ('public'::text) STORED NOT NULL");
    t.smallint('sort_order').notNullable().defaultTo(0);
    fk(t, 'uploaded_by', 'auth_users');
    createdAt(knex, t);
    tstz(t, 'removed_at');
    fk(t, 'removed_by', 'auth_users', { optional: true });
    t.text('removal_reason');
    t.unique(['file_id'], { indexName: 'ux_photos_file_id' });
    t.index(['uploaded_by'], 'ix_photos_uploaded_by');
    t.index(['removed_by'], 'ix_photos_removed_by');
  });
  await knex.raw(`ALTER TABLE photos ADD CONSTRAINT fk_photos_public_file
                  FOREIGN KEY (file_id, file_visibility) REFERENCES files (id, visibility) ON DELETE RESTRICT`);
  await addChecks(knex, 'photos', {
    ck_photos_owner: 'num_nonnulls(building_id, space_type_id) = 1',
    ck_photos_category: `
      (space_type_id IS NOT NULL AND category = 'space_type')
      OR (building_id IS NOT NULL AND category IN ('cover', 'grounds', 'surroundings'))`,
    ck_photos_removed: '(removed_at IS NULL) = (removed_by IS NULL)',
  });
  await knex.raw(`CREATE UNIQUE INDEX ux_photos_one_cover ON photos (building_id)
                  WHERE category = 'cover' AND removed_at IS NULL`);
  await knex.raw(`CREATE INDEX ix_photos_building_gallery ON photos (building_id, category, sort_order)
                  WHERE removed_at IS NULL AND building_id IS NOT NULL`);
  await knex.raw(`CREATE INDEX ix_photos_space_type_gallery ON photos (space_type_id, sort_order)
                  WHERE removed_at IS NULL AND space_type_id IS NOT NULL`);

  await knex.schema.createTable('availability_events', (t) => {
    pk(knex, t);
    fk(t, 'space_type_id', 'space_types');
    t.text('event_type').notNullable();
    t.integer('old_count');
    t.integer('new_count');
    fk(t, 'actor_user_id', 'auth_users', { optional: true });
    t.boolean('acted_as_staff').notNullable();
    t.text('source').notNullable();
    createdAt(knex, t);
    t.index(['actor_user_id'], 'ix_avail_actor');
    t.index(['created_at'], 'ix_avail_created_at');
  });
  await addChecks(knex, 'availability_events', {
    ck_avail_event_type: oneOf('event_type', [
      'created', 'confirmed', 'count_changed', 'published', 'removed', 'restored',
    ]),
    ck_avail_source: oneOf('source', [
      'maintainer', 'admin', 'follow_up', 'bulk_confirm', 'import', 'system',
    ]),
    ck_avail_counts: `
      (old_count IS NULL OR old_count >= 0)
      AND (new_count IS NULL OR new_count >= 0)
      AND (event_type NOT IN ('created', 'confirmed', 'count_changed', 'published') OR new_count IS NOT NULL)
      AND (event_type <> 'count_changed' OR old_count IS NOT NULL)`,
    ck_avail_actor: "actor_user_id IS NOT NULL OR source = 'system'",
  });
  await knex.raw('CREATE INDEX ix_avail_space_type_time ON availability_events (space_type_id, created_at DESC)');
  await appendOnly(knex, 'availability_events');

  await knex.schema.createTable('followups', (t) => {
    pk(knex, t);
    fk(t, 'space_type_id', 'space_types');
    fk(t, 'staff_user_id', 'auth_users');
    t.text('outcome').notNullable();
    t.text('note');
    createdAt(knex, t);
    t.index(['staff_user_id'], 'ix_followups_staff');
  });
  await addChecks(knex, 'followups', {
    ck_followups_outcome: oneOf('outcome', ['confirmed', 'fully_let', 'unreachable']),
  });
  await knex.raw('CREATE INDEX ix_followups_space_type_time ON followups (space_type_id, created_at DESC)');

  await knex.schema.createTable('reminder_log', (t) => {
    pk(knex, t);
    fk(t, 'space_type_id', 'space_types');
    tstz(t, 'cycle_confirmed_at').notNullable();
    t.smallint('seq').notNullable();
    fk(t, 'notification_id', 'notifications', { optional: true });
    createdAt(knex, t);
    t.unique(['space_type_id', 'cycle_confirmed_at', 'seq'], { indexName: 'ux_reminder_cycle' });
    t.index(['notification_id'], 'ix_reminder_notification_id');
  });
  await addChecks(knex, 'reminder_log', { ck_reminder_seq: 'seq >= 0' });
}

export async function down(knex: Knex): Promise<void> {
  await dropTables(knex, ['reminder_log', 'followups', 'availability_events', 'photos', 'space_types']);
}
