import type { Knex } from 'knex';
import { addChecks, dropTables, fk, oneOf, pk, timestamps, touchUpdatedAt, tstz } from '../db/helpers.js';

const VERIFICATION = ['unverified', 'pending', 'verified', 'rejected', 'revoked'];

// buildings and building_maintainers (design §5.3). The publish gate (T5), verification guards
// (T6, T7) and phone guard (T8) are added in the triggers migration.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('buildings', (t) => {
    pk(knex, t);
    t.text('name').notNullable();
    fk(t, 'area_id', 'areas');
    t.decimal('latitude', 9, 6).notNullable();
    t.decimal('longitude', 9, 6).notNullable();
    t.text('description');
    t.text('management_type').notNullable();
    fk(t, 'managing_agent_id', 'auth_users', { optional: true });
    fk(t, 'landlord_user_id', 'auth_users', { optional: true });
    t.text('landlord_name');
    t.uuid('contact_user_id'); // FK is composite, added below once building_maintainers exists
    fk(t, 'lister_id', 'auth_users');
    fk(t, 'created_by', 'auth_users');
    t.text('status').notNullable().defaultTo('draft');
    t.text('status_before_suspension');
    t.text('suspension_cause');
    t.text('suspended_reason');
    tstz(t, 'suspended_at');
    fk(t, 'suspended_by', 'auth_users', { optional: true });
    t.text('verification_status').notNullable().defaultTo('unverified');
    tstz(t, 'published_at');
    t.integer('version').notNullable().defaultTo(1);
    timestamps(knex, t);
    t.index(['lister_id'], 'ix_buildings_lister_id');
    t.index(['managing_agent_id'], 'ix_buildings_managing_agent_id');
    t.index(['landlord_user_id'], 'ix_buildings_landlord_user_id');
    t.index(['contact_user_id', 'id'], 'ix_buildings_contact_user_id');
    t.index(['created_by'], 'ix_buildings_created_by');
    t.index(['suspended_by'], 'ix_buildings_suspended_by');
  });
  await addChecks(knex, 'buildings', {
    ck_buildings_name_len: 'length(name) BETWEEN 1 AND 150',
    ck_buildings_lat: 'latitude BETWEEN -90 AND 90',
    ck_buildings_lng: 'longitude BETWEEN -180 AND 180',
    ck_buildings_status: oneOf('status', ['draft', 'pending', 'published', 'suspended', 'withdrawn']),
    ck_buildings_verification_status: oneOf('verification_status', VERIFICATION),
    ck_buildings_suspension_cause: `suspension_cause IS NULL OR ${oneOf('suspension_cause', ['admin', 'owner_suspended'])}`,
    ck_buildings_management: `
      (management_type = 'agent' AND managing_agent_id IS NOT NULL)
      OR (management_type = 'landlord' AND managing_agent_id IS NULL
          AND (landlord_user_id IS NOT NULL OR landlord_name IS NOT NULL))`,
    ck_buildings_published_contact:
      "status <> 'published' OR (published_at IS NOT NULL AND contact_user_id IS NOT NULL)",
    ck_buildings_suspension: `
      (status = 'suspended'
        AND status_before_suspension IN ('draft', 'pending', 'published')
        AND suspended_reason IS NOT NULL AND suspended_at IS NOT NULL AND suspension_cause IS NOT NULL)
      OR (status <> 'suspended'
        AND status_before_suspension IS NULL AND suspended_reason IS NULL
        AND suspended_at IS NULL AND suspension_cause IS NULL)`,
  });
  await knex.raw(`CREATE INDEX ix_buildings_area_published ON buildings (area_id) WHERE status = 'published'`);
  await knex.raw(`CREATE INDEX ix_buildings_published_latlng ON buildings (latitude, longitude)
                  WHERE status = 'published'`);
  await knex.raw(`CREATE INDEX ix_buildings_status_updated ON buildings (status, updated_at DESC)
                  WHERE status IN ('pending', 'suspended')`);
  await touchUpdatedAt(knex, 'buildings');

  await knex.schema.createTable('building_maintainers', (t) => {
    pk(knex, t);
    fk(t, 'building_id', 'buildings');
    fk(t, 'user_id', 'auth_users');
    fk(t, 'added_by', 'auth_users');
    tstz(t, 'added_at').notNullable().defaultTo(knex.fn.now());
    // Also the target of fk_buildings_contact_is_maintainer.
    t.unique(['building_id', 'user_id'], { indexName: 'ux_maintainers_building_user' });
    t.index(['user_id', 'building_id'], 'ix_maintainers_user_building');
    t.index(['added_by'], 'ix_maintainers_added_by');
  });

  // The designated contact must be a maintainer of this building and cannot be removed while
  // assigned. MATCH SIMPLE: not checked while contact_user_id is NULL. Must stay NOT DEFERRABLE.
  await knex.raw(`ALTER TABLE buildings ADD CONSTRAINT fk_buildings_contact_is_maintainer
                  FOREIGN KEY (id, contact_user_id) REFERENCES building_maintainers (building_id, user_id)
                  ON DELETE RESTRICT`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE buildings DROP CONSTRAINT IF EXISTS fk_buildings_contact_is_maintainer');
  await dropTables(knex, ['building_maintainers', 'buildings']);
}
