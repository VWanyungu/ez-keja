import type { Knex } from 'knex';
import {
  E164, addChecks, appendOnly, createdAt, dropTables, fk, oneOf, pk, timestamps, touchUpdatedAt, tstz,
} from '../db/helpers.js';

// files, profiles, roles, privacy notice, consent, data subject requests (design §5.1, §5.3 files).
// Verification-status and phone guards (T3, T6, T7, T8) are added in the triggers migration.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('files', (t) => {
    pk(knex, t);
    t.text('drive_id').notNullable();
    t.text('item_id').notNullable();
    t.text('original_name').notNullable();
    t.text('mime_type').notNullable();
    t.bigInteger('size_bytes').notNullable();
    t.integer('width_px');
    t.integer('height_px');
    t.text('visibility').notNullable();
    fk(t, 'uploaded_by', 'auth_users', { optional: true });
    tstz(t, 'purged_at');
    createdAt(knex, t);
    t.unique(['drive_id', 'item_id'], { indexName: 'ux_files_drive_item' });
    // Target of the composite FKs that pin photos to public and evidence to restricted files.
    t.unique(['id', 'visibility'], { indexName: 'ux_files_id_visibility' });
    t.index(['uploaded_by'], 'ix_files_uploaded_by');
  });
  await addChecks(knex, 'files', {
    ck_files_visibility: oneOf('visibility', ['public', 'restricted']),
    ck_files_mime: oneOf('mime_type', ['image/jpeg', 'image/png', 'application/pdf']),
    ck_files_size: 'size_bytes > 0',
  });
  await knex.raw(`CREATE INDEX ix_files_purge_candidates ON files (created_at)
                  WHERE visibility = 'restricted' AND purged_at IS NULL`);

  await knex.schema.createTable('profiles', (t) => {
    t.uuid('user_id').primary().notNullable().references('id').inTable('auth_users').onDelete('RESTRICT');
    t.text('display_name').notNullable();
    t.text('phone');
    t.text('language').notNullable().defaultTo('en');
    t.text('agent_type');
    fk(t, 'photo_file_id', 'files', { optional: true });
    t.text('account_status').notNullable().defaultTo('active');
    t.text('suspended_reason');
    tstz(t, 'suspended_at');
    fk(t, 'suspended_by', 'auth_users', { optional: true });
    t.text('verification_status').notNullable().defaultTo('unverified');
    tstz(t, 'last_login_at');
    tstz(t, 'erased_at');
    timestamps(knex, t);
    t.index(['photo_file_id'], 'ix_profiles_photo_file_id');
    t.index(['suspended_by'], 'ix_profiles_suspended_by');
  });
  await addChecks(knex, 'profiles', {
    ck_profiles_display_name: 'length(display_name) BETWEEN 1 AND 120',
    ck_profiles_phone: `phone IS NULL OR phone ~ ${E164}`,
    ck_profiles_language: oneOf('language', ['en', 'sw']),
    ck_profiles_agent_type: `agent_type IS NULL OR ${oneOf('agent_type', ['agent', 'caretaker'])}`,
    ck_profiles_account_status: oneOf('account_status', ['active', 'suspended']),
    ck_profiles_suspended:
      "account_status = 'active' OR (suspended_reason IS NOT NULL AND suspended_at IS NOT NULL)",
    ck_profiles_verification_status: oneOf('verification_status', [
      'unverified', 'pending', 'verified', 'rejected', 'revoked',
    ]),
  });
  await touchUpdatedAt(knex, 'profiles');

  await knex.schema.createTable('user_roles', (t) => {
    pk(knex, t);
    fk(t, 'user_id', 'auth_users');
    t.text('role').notNullable();
    fk(t, 'granted_by', 'auth_users', { optional: true });
    tstz(t, 'granted_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['user_id', 'role'], { indexName: 'ux_user_roles_user_role' });
    t.index(['role', 'user_id'], 'ix_user_roles_role_user');
    t.index(['granted_by'], 'ix_user_roles_granted_by');
  });
  await addChecks(knex, 'user_roles', {
    ck_user_roles_role: oneOf('role', ['client', 'landlord', 'agent', 'admin']),
    ck_user_roles_admin_granted:
      "role <> 'admin' OR (granted_by IS NOT NULL AND granted_by <> user_id)",
  });

  await knex.schema.createTable('privacy_notice_versions', (t) => {
    pk(knex, t);
    t.text('version').notNullable();
    tstz(t, 'effective_at').notNullable();
    createdAt(knex, t);
    t.unique(['version'], { indexName: 'ux_privacy_notice_versions_version' });
  });

  await knex.schema.createTable('consent_records', (t) => {
    pk(knex, t);
    fk(t, 'user_id', 'auth_users');
    fk(t, 'notice_version_id', 'privacy_notice_versions');
    tstz(t, 'accepted_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['user_id', 'notice_version_id'], { indexName: 'ux_consent_user_version' });
    t.index(['notice_version_id'], 'ix_consent_notice_version_id');
  });
  await appendOnly(knex, 'consent_records');

  await knex.schema.createTable('data_subject_requests', (t) => {
    pk(knex, t);
    fk(t, 'user_id', 'auth_users');
    t.text('request_type').notNullable();
    t.text('status').notNullable().defaultTo('open');
    tstz(t, 'requested_at').notNullable().defaultTo(knex.fn.now());
    fk(t, 'handled_by', 'auth_users', { optional: true });
    tstz(t, 'completed_at');
    t.text('outcome');
    timestamps(knex, t);
    t.index(['user_id'], 'ix_dsr_user_id');
    t.index(['handled_by'], 'ix_dsr_handled_by');
  });
  await addChecks(knex, 'data_subject_requests', {
    ck_dsr_type: oneOf('request_type', ['access', 'correction', 'export', 'deletion']),
    ck_dsr_status: oneOf('status', ['open', 'in_progress', 'completed', 'rejected']),
    ck_dsr_closed: "(status IN ('completed', 'rejected')) = (completed_at IS NOT NULL)",
  });
  await knex.raw(`CREATE INDEX ix_dsr_open ON data_subject_requests (requested_at)
                  WHERE status IN ('open', 'in_progress')`);
  await touchUpdatedAt(knex, 'data_subject_requests');
}

export async function down(knex: Knex): Promise<void> {
  await dropTables(knex, [
    'data_subject_requests', 'consent_records', 'privacy_notice_versions', 'user_roles', 'profiles', 'files',
  ]);
}
