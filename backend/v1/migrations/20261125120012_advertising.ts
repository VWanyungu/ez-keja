import type { Knex } from 'knex';
import { E164, addChecks, dropTables, fk, oneOf, pk, timestamps, touchUpdatedAt } from '../db/helpers.js';

const AD_STATUS = ['draft', 'active', 'paused', 'ended'];

// Advertising (Release 2, design §5.6, ASM-12). Touches no Release 1 table except `areas` and
// `files`, so it can be deferred or shipped on its own. Includes the two ad reference tables.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('service_categories', (t) => {
    pk(knex, t);
    t.text('code').notNullable();
    t.text('name_en').notNullable();
    t.text('name_sw').notNullable();
    t.smallint('sort_order').notNullable().defaultTo(0);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.unique(['code'], { indexName: 'ux_service_categories_code' });
  });

  await knex.schema.createTable('banner_slots', (t) => {
    pk(knex, t);
    t.text('code').notNullable();
    t.text('name').notNullable();
    t.integer('width_px').notNullable();
    t.integer('height_px').notNullable();
    t.boolean('is_active').notNullable().defaultTo(true);
    t.unique(['code'], { indexName: 'ux_banner_slots_code' });
  });
  await addChecks(knex, 'banner_slots', {
    ck_banner_slots_size: 'width_px > 0 AND height_px > 0',
  });

  await knex.schema.createTable('service_providers', (t) => {
    pk(knex, t);
    t.text('name').notNullable();
    fk(t, 'category_id', 'service_categories');
    t.text('description');
    t.text('phone').notNullable();
    t.specificType('languages', 'text[]').notNullable().defaultTo(knex.raw("'{en}'"));
    t.date('starts_on');
    t.date('ends_on');
    t.text('status').notNullable().defaultTo('draft');
    fk(t, 'created_by', 'auth_users');
    timestamps(knex, t);
    t.index(['created_by'], 'ix_sp_created_by');
  });
  await addChecks(knex, 'service_providers', {
    ck_sp_name_len: 'length(name) BETWEEN 1 AND 150',
    ck_sp_phone: `phone ~ ${E164}`,
    ck_sp_status: oneOf('status', AD_STATUS),
    ck_sp_dates: 'starts_on IS NULL OR ends_on IS NULL OR ends_on >= starts_on',
    ck_sp_active_complete: "status NOT IN ('active', 'paused') OR (starts_on IS NOT NULL AND ends_on IS NOT NULL)",
    ck_sp_languages: "languages <@ ARRAY['en', 'sw']::text[] AND cardinality(languages) >= 1",
  });
  await knex.raw(`CREATE INDEX ix_sp_active_window ON service_providers (category_id, starts_on, ends_on)
                  WHERE status = 'active'`);
  await touchUpdatedAt(knex, 'service_providers');

  await knex.schema.createTable('provider_areas', (t) => {
    pk(knex, t);
    fk(t, 'provider_id', 'service_providers', { cascade: true });
    fk(t, 'area_id', 'areas');
    t.unique(['provider_id', 'area_id'], { indexName: 'ux_provider_areas' });
    t.index(['area_id', 'provider_id'], 'ix_provider_areas_area');
  });

  await knex.schema.createTable('ad_campaigns', (t) => {
    pk(knex, t);
    fk(t, 'slot_id', 'banner_slots');
    t.text('advertiser_name').notNullable();
    fk(t, 'image_file_id', 'files', { optional: true });
    t.text('destination_url');
    t.text('language').notNullable().defaultTo('any');
    t.date('starts_on');
    t.date('ends_on');
    t.text('status').notNullable().defaultTo('draft');
    fk(t, 'created_by', 'auth_users');
    timestamps(knex, t);
    t.index(['image_file_id'], 'ix_ac_image_file_id');
    t.index(['created_by'], 'ix_ac_created_by');
  });
  await addChecks(knex, 'ad_campaigns', {
    ck_ac_status: oneOf('status', AD_STATUS),
    ck_ac_language: oneOf('language', ['en', 'sw', 'any']),
    ck_ac_url: "destination_url IS NULL OR destination_url ~ '^https://'",
    ck_ac_dates: 'starts_on IS NULL OR ends_on IS NULL OR ends_on >= starts_on',
    ck_ac_active_complete: `
      status NOT IN ('active', 'paused')
      OR (image_file_id IS NOT NULL AND destination_url IS NOT NULL
          AND starts_on IS NOT NULL AND ends_on IS NOT NULL)`,
  });
  await knex.raw(`CREATE INDEX ix_ac_slot_active ON ad_campaigns (slot_id, starts_on, ends_on)
                  WHERE status = 'active'`);
  await touchUpdatedAt(knex, 'ad_campaigns');

  // No user column on purpose: personal identifiers cannot be stored (BR-024).
  await knex.schema.createTable('ad_daily_metrics', (t) => {
    pk(knex, t);
    fk(t, 'campaign_id', 'ad_campaigns', { optional: true });
    fk(t, 'provider_id', 'service_providers', { optional: true });
    t.date('metric_date').notNullable();
    t.integer('impressions').notNullable().defaultTo(0);
    t.integer('clicks').notNullable().defaultTo(0);
    t.integer('phone_taps').notNullable().defaultTo(0);
  });
  await addChecks(knex, 'ad_daily_metrics', {
    ck_adm_subject: 'num_nonnulls(campaign_id, provider_id) = 1',
    ck_adm_counts: 'impressions >= 0 AND clicks >= 0 AND phone_taps >= 0',
  });
  // Upserts must repeat the predicate: ON CONFLICT (campaign_id, metric_date) WHERE campaign_id IS NOT NULL.
  await knex.raw(`CREATE UNIQUE INDEX ux_adm_campaign_day ON ad_daily_metrics (campaign_id, metric_date)
                  WHERE campaign_id IS NOT NULL`);
  await knex.raw(`CREATE UNIQUE INDEX ux_adm_provider_day ON ad_daily_metrics (provider_id, metric_date)
                  WHERE provider_id IS NOT NULL`);
}

export async function down(knex: Knex): Promise<void> {
  await dropTables(knex, [
    'ad_daily_metrics', 'ad_campaigns', 'provider_areas', 'service_providers', 'banner_slots', 'service_categories',
  ]);
}
