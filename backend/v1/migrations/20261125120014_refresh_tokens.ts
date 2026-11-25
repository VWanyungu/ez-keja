import type { Knex } from 'knex';
import { addChecks, dropTables, fk, pk, timestamps, touchUpdatedAt, tstz } from '../db/helpers.js';

// Access-token revocation counter (profiles.token_version) and rotating refresh tokens.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('profiles', (t) => {
    t.integer('token_version').notNullable().defaultTo(1);
  });
  await addChecks(knex, 'profiles', {
    ck_profiles_token_version: 'token_version >= 1',
  });

  await knex.schema.createTable('auth_refresh_tokens', (t) => {
    pk(knex, t);
    fk(t, 'user_id', 'auth_users', { cascade: true });
    fk(t, 'session_id', 'auth_sessions', { optional: true, cascade: true });
    t.uuid('family_id').notNullable();
    t.text('token_hash').notNullable();
    t.uuid('replaced_by_id').references('id').inTable('auth_refresh_tokens').onDelete('SET NULL');
    tstz(t, 'expires_at').notNullable();
    tstz(t, 'revoked_at');
    t.text('revoked_reason');
    t.text('ip_address');
    t.text('user_agent');
    timestamps(knex, t);

    t.unique(['token_hash'], { indexName: 'ux_auth_refresh_tokens_token_hash' });
    t.index(['user_id'], 'ix_auth_refresh_tokens_user_id');
    t.index(['session_id'], 'ix_auth_refresh_tokens_session_id');
    t.index(['family_id'], 'ix_auth_refresh_tokens_family_id');
    t.index(['replaced_by_id'], 'ix_auth_refresh_tokens_replaced_by_id');
  });

  await addChecks(knex, 'auth_refresh_tokens', {
    ck_auth_refresh_tokens_revoked_reason: 'revoked_at IS NULL OR revoked_reason IS NOT NULL',
  });

  await touchUpdatedAt(knex, 'auth_refresh_tokens');
}

export async function down(knex: Knex): Promise<void> {
  await dropTables(knex, ['auth_refresh_tokens']);
  await knex.raw('ALTER TABLE profiles DROP CONSTRAINT IF EXISTS ck_profiles_token_version');
  await knex.schema.alterTable('profiles', (t) => {
    t.dropColumn('token_version');
  });
}
