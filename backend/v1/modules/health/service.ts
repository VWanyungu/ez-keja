import db from '../../db/knex.js';
import {
  HEALTH_DB_TIMEOUT_MS,
  type DatabaseHealth,
  type HealthCheckResult,
  type HealthQuery,
} from './schemas.js';

export interface HealthDependencies {
  pingDb?: () => Promise<unknown>;
  timeoutMs?: number;
}

const defaultPingDb = () => db.raw('SELECT 1');

export async function checkDatabase(
  pingDb: () => Promise<unknown> = defaultPingDb,
  timeoutMs: number = HEALTH_DB_TIMEOUT_MS,
): Promise<DatabaseHealth> {
  const startedAt = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const pingPromise = pingDb();
    // Prevent an unhandled rejection if the ping settles after the timeout wins the race.
    pingPromise.catch(() => {});

    await Promise.race([
      pingPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Database health check timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);

    const latencyMs = Math.round((performance.now() - startedAt) * 100) / 100;
    return { status: 'up', latencyMs };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error('[health] database check failed:', reason);
    return { status: 'down', latencyMs: null };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function getHealthStatus(
  query: HealthQuery = { check: 'all' },
  deps: HealthDependencies = {},
): Promise<HealthCheckResult> {
  const uptime = Math.floor(process.uptime());
  const timestamp = new Date().toISOString();

  if (query.check === 'live') {
    return {
      healthy: true,
      data: {
        status: 'ok',
        uptime,
        timestamp,
        checks: {},
      },
    };
  }

  const database = await checkDatabase(deps.pingDb, deps.timeoutMs);
  const healthy = database.status === 'up';

  return {
    healthy,
    data: {
      status: healthy ? 'ok' : 'degraded',
      uptime,
      timestamp,
      checks: { database },
    },
  };
}
