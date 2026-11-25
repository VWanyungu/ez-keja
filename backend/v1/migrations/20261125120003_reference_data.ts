import type { Knex } from 'knex';
import { addChecks, dropTables, fk, oneOf, pk, timestamps, touchUpdatedAt, tstz } from '../db/helpers.js';

// Reference data used by the catalogue (design §5.2). service_categories and banner_slots live
// in the advertising migration, which can ship separately (ASM-12).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('areas', (t) => {
    pk(knex, t);
    t.text('name').notNullable();
    t.text('slug').notNullable();
    t.decimal('centre_lat', 9, 6).notNullable();
    t.decimal('centre_lng', 9, 6).notNullable();
    t.boolean('is_active').notNullable().defaultTo(true);
    timestamps(knex, t);
    t.unique(['slug'], { indexName: 'ux_areas_slug' });
  });
  await knex.raw('CREATE UNIQUE INDEX ux_areas_name_lower ON areas (lower(name))');
  await addChecks(knex, 'areas', {
    ck_areas_name_len: 'length(name) BETWEEN 1 AND 100',
    ck_areas_slug: "slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'",
    ck_areas_lat: 'centre_lat BETWEEN -90 AND 90',
    ck_areas_lng: 'centre_lng BETWEEN -180 AND 180',
  });
  await touchUpdatedAt(knex, 'areas');

  await knex.schema.createTable('currencies', (t) => {
    pk(knex, t);
    t.specificType('code', 'char(3)').notNullable();
    t.text('name').notNullable();
    t.boolean('is_active').notNullable().defaultTo(true);
    t.smallint('sort_order').notNullable().defaultTo(0);
    t.unique(['code'], { indexName: 'ux_currencies_code' });
  });
  await addChecks(knex, 'currencies', { ck_currencies_code: "code ~ '^[A-Z]{3}$'" });

  await knex.schema.createTable('space_categories', (t) => {
    pk(knex, t);
    t.text('code').notNullable();
    t.text('name_en').notNullable();
    t.text('name_sw').notNullable();
    t.text('kind').notNullable();
    t.smallint('sort_order').notNullable().defaultTo(0);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.unique(['code'], { indexName: 'ux_space_categories_code' });
  });
  await addChecks(knex, 'space_categories', {
    ck_space_categories_kind: oneOf('kind', ['residential', 'commercial']),
  });

  await knex.schema.createTable('settings', (t) => {
    pk(knex, t);
    t.text('key').notNullable();
    t.integer('value').notNullable();
    t.integer('min_value').notNullable().defaultTo(1);
    t.integer('max_value');
    t.text('description').notNullable();
    fk(t, 'updated_by', 'auth_users', { optional: true });
    tstz(t, 'updated_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['key'], { indexName: 'ux_settings_key' });
    t.index(['updated_by'], 'ix_settings_updated_by');
  });
  await addChecks(knex, 'settings', {
    ck_settings_range: 'value >= min_value AND (max_value IS NULL OR value <= max_value)',
  });
  await touchUpdatedAt(knex, 'settings');
}

export async function down(knex: Knex): Promise<void> {
  await dropTables(knex, ['settings', 'space_categories', 'currencies', 'areas']);
}
