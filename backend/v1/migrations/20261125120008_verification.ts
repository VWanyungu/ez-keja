import type { Knex } from 'knex';
import { addChecks, createdAt, dropTables, fk, oneOf, pk, tstz } from '../db/helpers.js';

// verification_cases and verification_evidence (design §5.4). The case is the source of truth;
// the status caches on profiles and buildings are maintained by T3 (triggers migration).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('verification_cases', (t) => {
    pk(knex, t);
    t.text('subject_type').notNullable();
    fk(t, 'subject_user_id', 'auth_users', { optional: true });
    fk(t, 'subject_building_id', 'buildings', { optional: true });
    t.text('origin').notNullable().defaultTo('applicant');
    t.text('status').notNullable().defaultTo('pending');
    fk(t, 'submitted_by', 'auth_users', { optional: true });
    tstz(t, 'submitted_at').notNullable().defaultTo(knex.fn.now());
    fk(t, 'decided_by', 'auth_users', { optional: true });
    tstz(t, 'decided_at');
    t.text('decision_reason');
    fk(t, 'revoked_by', 'auth_users', { optional: true });
    tstz(t, 'revoked_at');
    t.text('revoke_reason');
    t.index(['submitted_by'], 'ix_vc_submitted_by');
    t.index(['decided_by'], 'ix_vc_decided_by');
    t.index(['revoked_by'], 'ix_vc_revoked_by');
  });
  await addChecks(knex, 'verification_cases', {
    ck_vc_subject_type: oneOf('subject_type', ['account', 'building']),
    ck_vc_origin: oneOf('origin', ['applicant', 'material_change']),
    ck_vc_status: oneOf('status', ['pending', 'approved', 'rejected', 'revoked', 'superseded']),
    ck_vc_subject: `
      (subject_type = 'account' AND subject_user_id IS NOT NULL AND subject_building_id IS NULL)
      OR (subject_type = 'building' AND subject_building_id IS NOT NULL AND subject_user_id IS NULL)`,
    ck_vc_submitter: "origin <> 'applicant' OR submitted_by IS NOT NULL",
    ck_vc_decision_shape: `
      (status = 'pending'
        AND decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL
        AND revoked_by IS NULL AND revoked_at IS NULL AND revoke_reason IS NULL)
      OR (status IN ('approved', 'superseded')
        AND decided_by IS NOT NULL AND decided_at IS NOT NULL
        AND revoked_by IS NULL AND revoked_at IS NULL AND revoke_reason IS NULL)
      OR (status = 'rejected'
        AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL
        AND revoked_by IS NULL AND revoked_at IS NULL AND revoke_reason IS NULL)
      OR (status = 'revoked'
        AND decided_by IS NOT NULL AND decided_at IS NOT NULL
        AND revoked_by IS NOT NULL AND revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)`,
    // BR-014, submitter part. The "edited the building" part is a service rule.
    ck_vc_separation: `
      decided_by IS NULL
      OR (decided_by IS DISTINCT FROM submitted_by AND decided_by IS DISTINCT FROM subject_user_id)`,
  });
  await knex.raw(`CREATE UNIQUE INDEX ux_vc_one_pending_account ON verification_cases (subject_user_id)
                  WHERE status = 'pending' AND subject_type = 'account'`);
  await knex.raw(`CREATE UNIQUE INDEX ux_vc_one_pending_building ON verification_cases (subject_building_id)
                  WHERE status = 'pending' AND subject_type = 'building'`);
  await knex.raw(`CREATE UNIQUE INDEX ux_vc_one_approved_account ON verification_cases (subject_user_id)
                  WHERE status = 'approved' AND subject_type = 'account'`);
  await knex.raw(`CREATE UNIQUE INDEX ux_vc_one_approved_building ON verification_cases (subject_building_id)
                  WHERE status = 'approved' AND subject_type = 'building'`);
  await knex.raw(`CREATE INDEX ix_vc_queue ON verification_cases (submitted_at) WHERE status = 'pending'`);
  await knex.raw('CREATE INDEX ix_vc_subject_user ON verification_cases (subject_user_id, submitted_at DESC)');
  await knex.raw('CREATE INDEX ix_vc_subject_building ON verification_cases (subject_building_id, submitted_at DESC)');

  // file_visibility is generated so evidence can only reference 'restricted' files (R-15, V-1).
  // MATCH SIMPLE: the pair is checked only when file_id is set.
  await knex.schema.createTable('verification_evidence', (t) => {
    pk(knex, t);
    fk(t, 'case_id', 'verification_cases');
    t.text('evidence_type').notNullable();
    t.uuid('file_id');
    t.specificType('file_visibility', "text GENERATED ALWAYS AS ('restricted'::text) STORED NOT NULL");
    tstz(t, 'phone_confirmed_at');
    createdAt(knex, t);
    t.index(['case_id'], 'ix_ve_case_id');
    t.index(['file_id'], 'ix_ve_file_id');
  });
  await knex.raw(`ALTER TABLE verification_evidence ADD CONSTRAINT fk_ve_restricted_file
                  FOREIGN KEY (file_id, file_visibility) REFERENCES files (id, visibility) ON DELETE RESTRICT`);
  await addChecks(knex, 'verification_evidence', {
    ck_ve_type_len: 'length(evidence_type) BETWEEN 1 AND 50',
    ck_ve_has_content: 'file_id IS NOT NULL OR phone_confirmed_at IS NOT NULL',
  });
}

export async function down(knex: Knex): Promise<void> {
  await dropTables(knex, ['verification_evidence', 'verification_cases']);
}
