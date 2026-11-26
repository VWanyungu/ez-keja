import { closeDb } from '../v1/db/knex.js';
import { DEFAULT_BATCH_SIZE, deliverNotifications } from '../v1/modules/notifications/deliver.js';

// Run every minute from cron or PM2 (separate process from the API): `bun jobs/deliver-notifications.ts`.
// Safe to overlap with itself or to run on two instances: deliveries are claimed with SKIP LOCKED.
const MAX_PASSES = 20; // at most 20 x batch size per run; the next run carries on

try {
  const total = { claimed: 0, sent: 0, failed: 0, abandoned: 0 };
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const result = await deliverNotifications();
    for (const key of Object.keys(total) as Array<keyof typeof total>) total[key] += result[key];
    if (result.claimed < DEFAULT_BATCH_SIZE) break;
  }
  console.log(JSON.stringify({ job: 'deliver-notifications', ...total }));
} catch (err) {
  console.error('deliver-notifications failed', err);
  process.exitCode = 1;
} finally {
  await closeDb();
}
