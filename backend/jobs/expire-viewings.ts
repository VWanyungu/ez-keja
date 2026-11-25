import { closeDb } from '../v1/db/knex.js';
import { expireViewings } from '../v1/modules/availability/expire-viewings.js';

// Run from cron or PM2 (separate process from the API), e.g. daily: `bun jobs/expire-viewings.ts`.
try {
  const result = await expireViewings();
  console.log(JSON.stringify({ job: 'expire-viewings', ...result }));
} catch (err) {
  console.error('expire-viewings failed', err);
  process.exitCode = 1;
} finally {
  await closeDb();
}
