import { closeDb } from '../v1/db/knex.js';
import { snapshotMetrics } from '../v1/modules/metrics/snapshots.js';

// Run weekly from cron or PM2 (separate process from the API): `bun jobs/snapshot-metrics.ts`,
// for example Mondays 00:30 UTC: `30 0 * * 1`. Running it again in the same week writes nothing:
// the unique key `ux_snapshots_key` and an advisory lock decide, so two instances are safe.
try {
  const result = await snapshotMetrics();
  console.log(JSON.stringify({ job: 'snapshot-metrics', ...result }));
} catch (err) {
  console.error('snapshot-metrics failed', err);
  process.exitCode = 1;
} finally {
  await closeDb();
}
