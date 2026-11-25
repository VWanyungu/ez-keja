import { closeDb } from '../v1/db/knex.js';
import { sendReminders } from '../v1/modules/availability/reminders.js';

// Run hourly from cron or PM2 (separate process from the API): `bun jobs/send-reminders.ts`.
// Safe to overlap with itself: the reminder_log unique key and SKIP LOCKED decide who sends.
try {
  const result = await sendReminders();
  console.log(JSON.stringify({ job: 'send-reminders', ...result }));
} catch (err) {
  console.error('send-reminders failed', err);
  process.exitCode = 1;
} finally {
  await closeDb();
}
