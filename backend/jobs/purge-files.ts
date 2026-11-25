import { closeDb } from '../v1/db/knex.js';
import { purgeFiles } from '../v1/modules/files/purge.js';

// Run from cron or PM2 (separate process from the API), e.g. nightly: `bun jobs/purge-files.ts`.
try {
  const result = await purgeFiles();
  console.log(JSON.stringify({ job: 'purge-files', ...result }));
  process.exitCode = result.failures > 0 ? 1 : 0;
} catch (err) {
  console.error('purge-files failed', err);
  process.exitCode = 1;
} finally {
  await closeDb();
}
