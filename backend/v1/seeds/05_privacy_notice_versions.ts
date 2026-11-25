import type { Knex } from 'knex';

// FR-PRV-001: registration records acceptance of a notice version, so one must exist.
// PLACEHOLDER version and date (the design doc's example): replace with the real notice's version
// and effective date once legal has approved it (OQ-15). Idempotent insert-if-missing.
export async function seed(knex: Knex): Promise<void> {
  await knex('privacy_notice_versions')
    .insert({ version: '2026-12-01', effective_at: '2026-12-01T00:00:00+03:00' })
    .onConflict('version')
    .ignore();
}
