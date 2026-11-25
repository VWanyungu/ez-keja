import type { Knex } from 'knex';
import db from '../../db/knex.js';

export interface ExpireViewingsOptions {
  conn?: Knex;
}

/**
 * TX-01 (design): a viewing still `requested` whose time has passed is cancelled with
 * `cancel_reason = 'expired'`. Nobody answered it, so there is no `cancelled_by`. One statement
 * that tests `status = 'requested'` itself (the TX-07 compare-and-swap), so a maintainer
 * accepting it at the same moment wins or loses cleanly, and running the job twice is harmless.
 * Run it daily from cron/PM2 (jobs/expire-viewings.ts), never from a request handler.
 */
export async function expireViewings(options: ExpireViewingsOptions = {}): Promise<{ expired: number }> {
  const conn = options.conn ?? db;
  const expired = await conn('viewing_requests')
    .where({ status: 'requested' })
    .where('requested_for', '<', conn.fn.now())
    .update({ status: 'cancelled', cancelled_at: conn.fn.now(), cancel_reason: 'expired' });
  return { expired };
}
