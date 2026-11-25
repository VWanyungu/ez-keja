import type { Knex } from 'knex';
import { addChecks, createdAt, dropTables, fk, oneOf, pk, timestamps, touchUpdatedAt, tstz } from '../db/helpers.js';

// In-app notifications and their per-channel deliveries (design §5.5). Created before
// reminder_log, which references notifications.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('notifications', (t) => {
    pk(knex, t);
    fk(t, 'user_id', 'auth_users');
    t.text('event_code').notNullable();
    t.jsonb('payload').notNullable().defaultTo('{}');
    tstz(t, 'read_at');
    createdAt(knex, t);
  });
  await addChecks(knex, 'notifications', {
    ck_notif_event: "event_code ~ '^N-(0[1-9]|1[0-4])$'",
  });
  await knex.raw('CREATE INDEX ix_notif_user_time ON notifications (user_id, created_at DESC)');
  await knex.raw('CREATE INDEX ix_notif_unread ON notifications (user_id) WHERE read_at IS NULL');

  await knex.schema.createTable('notification_deliveries', (t) => {
    pk(knex, t);
    fk(t, 'notification_id', 'notifications');
    t.text('channel').notNullable();
    t.text('status').notNullable().defaultTo('pending');
    t.smallint('attempts').notNullable().defaultTo(0);
    tstz(t, 'next_attempt_at');
    t.text('last_error');
    tstz(t, 'sent_at');
    timestamps(knex, t);
    t.unique(['notification_id', 'channel'], { indexName: 'ux_deliveries_channel' });
  });
  await addChecks(knex, 'notification_deliveries', {
    ck_deliveries_channel: oneOf('channel', ['email', 'sms', 'whatsapp']),
    ck_deliveries_status: oneOf('status', ['pending', 'sent', 'failed', 'abandoned']),
    ck_deliveries_attempts: 'attempts >= 0',
  });
  await knex.raw(`CREATE INDEX ix_deliveries_work ON notification_deliveries (COALESCE(next_attempt_at, created_at))
                  WHERE status IN ('pending', 'failed')`);
  await touchUpdatedAt(knex, 'notification_deliveries');
}

export async function down(knex: Knex): Promise<void> {
  await dropTables(knex, ['notification_deliveries', 'notifications']);
}
