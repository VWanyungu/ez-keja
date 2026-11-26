import { closeDb } from '../v1/db/knex.js';
import { purgeExpiredAuth } from '../v1/modules/data-requests/purge-expired-auth.js';

// Run from cron or PM2 (separate process from the API), nightly: `bun jobs/purge-expired-auth.ts`.
try {
  const result = await purgeExpiredAuth();
  console.log(JSON.stringify({ job: 'purge-expired-auth', ...result }));
} catch (err) {
  console.error('purge-expired-auth failed', err);
  process.exitCode = 1;
} finally {
  await closeDb();
}
