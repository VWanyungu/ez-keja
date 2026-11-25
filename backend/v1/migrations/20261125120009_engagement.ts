import type { Knex } from 'knex';
import { addChecks, createdAt, dropTables, fk, oneOf, pk, timestamps, touchUpdatedAt, tstz } from '../db/helpers.js';

// enquiries, enquiry_messages, viewing_requests, reports, contact_events (design §5.5).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('enquiries', (t) => {
    pk(knex, t);
    fk(t, 'space_type_id', 'space_types');
    fk(t, 'client_id', 'auth_users');
    t.text('status').notNullable().defaultTo('new');
    t.text('closed_reason');
    tstz(t, 'closed_at');
    tstz(t, 'first_response_at');
    tstz(t, 'last_message_at').notNullable().defaultTo(knex.fn.now());
    timestamps(knex, t);
    t.index(['client_id', 'last_message_at'], 'ix_enq_client_last');
    t.index(['space_type_id', 'status'], 'ix_enq_space_type_status');
  });
  await addChecks(knex, 'enquiries', {
    ck_enq_status: oneOf('status', ['new', 'responded', 'closed']),
    ck_enq_closed_reason: `closed_reason IS NULL OR ${oneOf('closed_reason', [
      'fully_let', 'space_type_removed', 'building_unavailable', 'manual',
    ])}`,
    ck_enq_closed: `
      (status = 'closed' AND closed_at IS NOT NULL AND closed_reason IS NOT NULL)
      OR (status <> 'closed' AND closed_at IS NULL AND closed_reason IS NULL)`,
    ck_enq_responded: "status <> 'responded' OR first_response_at IS NOT NULL",
  });
  // One open thread per client and space type; a new thread is allowed after closure (Q-D12).
  await knex.raw(`CREATE UNIQUE INDEX ux_enq_open_thread ON enquiries (client_id, space_type_id)
                  WHERE status <> 'closed'`);
  await touchUpdatedAt(knex, 'enquiries');

  await knex.schema.createTable('enquiry_messages', (t) => {
    pk(knex, t);
    fk(t, 'enquiry_id', 'enquiries');
    fk(t, 'sender_id', 'auth_users');
    t.text('body').notNullable();
    createdAt(knex, t);
    t.index(['enquiry_id', 'created_at', 'id'], 'ix_msg_enquiry_id');
    t.index(['sender_id'], 'ix_msg_sender_id');
  });
  await addChecks(knex, 'enquiry_messages', {
    ck_msg_body_len: 'length(btrim(body)) BETWEEN 1 AND 4000',
  });

  await knex.schema.createTable('viewing_requests', (t) => {
    pk(knex, t);
    fk(t, 'space_type_id', 'space_types');
    fk(t, 'client_id', 'auth_users');
    tstz(t, 'requested_for').notNullable();
    tstz(t, 'counter_for');
    t.text('status').notNullable().defaultTo('requested');
    fk(t, 'responded_by', 'auth_users', { optional: true });
    tstz(t, 'responded_at');
    fk(t, 'cancelled_by', 'auth_users', { optional: true });
    tstz(t, 'cancelled_at');
    t.text('cancel_reason');
    timestamps(knex, t);
    t.index(['responded_by'], 'ix_vr_responded_by');
    t.index(['cancelled_by'], 'ix_vr_cancelled_by');
  });
  await addChecks(knex, 'viewing_requests', {
    ck_vr_status: oneOf('status', ['requested', 'accepted', 'declined', 'counter_proposed', 'cancelled']),
    ck_vr_cancel_reason: `cancel_reason IS NULL OR ${oneOf('cancel_reason', [
      'client', 'maintainer', 'client_declined_counter', 'fully_let', 'space_type_removed', 'expired',
    ])}`,
    ck_vr_counter: "status <> 'counter_proposed' OR counter_for IS NOT NULL",
    ck_vr_responded: `
      status NOT IN ('accepted', 'declined', 'counter_proposed')
      OR (responded_by IS NOT NULL AND responded_at IS NOT NULL)`,
    ck_vr_cancelled: `
      (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL)
      OR (status <> 'cancelled' AND cancelled_at IS NULL AND cancel_reason IS NULL)`,
  });
  await knex.raw(`CREATE INDEX ix_vr_open_by_space_type ON viewing_requests (space_type_id)
                  WHERE status IN ('requested', 'accepted', 'counter_proposed')`);
  await knex.raw('CREATE INDEX ix_vr_client_time ON viewing_requests (client_id, created_at DESC)');
  await touchUpdatedAt(knex, 'viewing_requests');

  // Exclusive arc: a report targets a building or a space type.
  await knex.schema.createTable('reports', (t) => {
    pk(knex, t);
    fk(t, 'building_id', 'buildings', { optional: true });
    fk(t, 'space_type_id', 'space_types', { optional: true });
    fk(t, 'client_id', 'auth_users');
    t.text('reason').notNullable();
    t.text('comment');
    t.text('status').notNullable().defaultTo('open');
    fk(t, 'resolved_by', 'auth_users', { optional: true });
    tstz(t, 'resolved_at');
    t.text('resolution_note');
    createdAt(knex, t);
    t.index(['building_id'], 'ix_reports_building_id');
    t.index(['space_type_id'], 'ix_reports_space_type_id');
    t.index(['resolved_by'], 'ix_reports_resolved_by');
    t.index(['client_id'], 'ix_reports_client_id');
  });
  await addChecks(knex, 'reports', {
    ck_reports_reason: oneOf('reason', ['unavailable', 'inaccurate', 'suspicious']),
    ck_reports_status: oneOf('status', ['open', 'actioned', 'dismissed']),
    ck_reports_comment_len: 'comment IS NULL OR length(comment) <= 2000',
    ck_reports_target: 'num_nonnulls(building_id, space_type_id) = 1',
    ck_reports_resolved: `
      (status = 'open' AND resolved_at IS NULL AND resolved_by IS NULL)
      OR (status IN ('actioned', 'dismissed') AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL)`,
  });
  // A repeat report by the same client is counted once (FR-AVL-010).
  await knex.raw(`CREATE UNIQUE INDEX ux_reports_open_building ON reports (client_id, building_id)
                  WHERE status = 'open' AND building_id IS NOT NULL`);
  await knex.raw(`CREATE UNIQUE INDEX ux_reports_open_space_type ON reports (client_id, space_type_id)
                  WHERE status = 'open' AND space_type_id IS NOT NULL`);
  await knex.raw(`CREATE INDEX ix_reports_open_queue ON reports (created_at) WHERE status = 'open'`);

  // user_id is NULL for Guests: no personal identifiers are stored (FR-ENQ-004).
  await knex.schema.createTable('contact_events', (t) => {
    pk(knex, t);
    fk(t, 'building_id', 'buildings');
    fk(t, 'space_type_id', 'space_types', { optional: true });
    fk(t, 'user_id', 'auth_users', { optional: true });
    createdAt(knex, t);
    t.index(['building_id', 'created_at'], 'ix_contact_building_time');
    t.index(['created_at'], 'ix_contact_created_at');
    t.index(['space_type_id'], 'ix_contact_space_type_id');
    t.index(['user_id'], 'ix_contact_user_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await dropTables(knex, ['contact_events', 'reports', 'viewing_requests', 'enquiry_messages', 'enquiries']);
}
