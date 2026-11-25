import type { Knex } from 'knex';
import { addChecks, dropTables, fk, pk, timestamps, touchUpdatedAt, tstz } from '../db/helpers.js';

// Admin invite tokens for FR-ADM-006 (only an Admin can create Admin accounts, and the invitee
// must set their own credentials and accept the privacy notice).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('admin_invites', (t) => {
    pk(knex, t);
    t.text('email').notNullable();
    t.text('display_name').notNullable();
    t.text('token_hash').notNullable();
    fk(t, 'invited_by', 'auth_users');
    tstz(t, 'expires_at').notNullable();
    tstz(t, 'accepted_at');
    fk(t, 'accepted_user_id', 'auth_users', { optional: true });
    tstz(t, 'revoked_at');
    fk(t, 'revoked_by', 'auth_users', { optional: true });
    timestamps(knex, t);

    t.unique(['token_hash'], { indexName: 'ux_admin_invites_token_hash' });
    t.index(['invited_by'], 'ix_admin_invites_invited_by');
    t.index(['accepted_user_id'], 'ix_admin_invites_accepted_user_id');
    t.index(['revoked_by'], 'ix_admin_invites_revoked_by');
  });

  await addChecks(knex, 'admin_invites', {
    ck_admin_invites_email_lower: 'email = lower(email)',
    ck_admin_invites_display_name: 'length(display_name) BETWEEN 1 AND 120',
    ck_admin_invites_terminal: 'NOT (accepted_at IS NOT NULL AND revoked_at IS NOT NULL)',
    ck_admin_invites_accepted_user: '(accepted_at IS NULL) = (accepted_user_id IS NULL)',
    ck_admin_invites_revoked_by: '(revoked_at IS NULL) = (revoked_by IS NULL)',
  });

  await knex.raw(`
    CREATE UNIQUE INDEX ux_admin_invites_pending_email
    ON admin_invites (email)
    WHERE accepted_at IS NULL AND revoked_at IS NULL
  `);

  await touchUpdatedAt(knex, 'admin_invites');
}

export async function down(knex: Knex): Promise<void> {
  await dropTables(knex, ['admin_invites']);
}
