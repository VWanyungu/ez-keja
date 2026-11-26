import type { Knex } from 'knex';
import { addChecks, tstz } from '../db/helpers.js';

// Phase 11 (design §5.1, §5.3, §10.6): the requester's note, the "completion e-mail sent" record for
// deletion requests, one open request per type, and the "delete requested" marker on files that the
// purge job must destroy after an erasure (it cannot reuse `purged_at`: the job only touches files
// whose `purged_at` is still NULL and sets it itself after the Cloudinary call succeeded).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('data_subject_requests', (t) => {
    t.text('note');
    // Lease taken before the mail call, so two concurrent completions cannot both send it.
    tstz(t, 'completion_email_claimed_at');
    tstz(t, 'completion_email_sent_at');
  });
  await addChecks(knex, 'data_subject_requests', { ck_dsr_note_len: 'note IS NULL OR length(note) <= 1000' });
  await knex.raw(`CREATE UNIQUE INDEX ux_dsr_one_open_per_type ON data_subject_requests (user_id, request_type)
                  WHERE status IN ('open', 'in_progress')`);

  await knex.schema.alterTable('files', (t) => {
    tstz(t, 'purge_requested_at');
  });
  await knex.raw(`CREATE INDEX ix_files_purge_requested ON files (purge_requested_at)
                  WHERE purge_requested_at IS NOT NULL AND purged_at IS NULL`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS ix_files_purge_requested');
  await knex.schema.alterTable('files', (t) => {
    t.dropColumn('purge_requested_at');
  });
  await knex.raw('DROP INDEX IF EXISTS ux_dsr_one_open_per_type');
  await knex.raw('ALTER TABLE data_subject_requests DROP CONSTRAINT IF EXISTS ck_dsr_note_len');
  await knex.schema.alterTable('data_subject_requests', (t) => {
    t.dropColumn('completion_email_sent_at');
    t.dropColumn('completion_email_claimed_at');
    t.dropColumn('note');
  });
}
