import { badRequest } from '../../lib/http-error.js';

export const HEALTH_DB_TIMEOUT_MS = 2_000;

export type HealthCheckMode = 'all' | 'live';
export type HealthStatus = 'ok' | 'degraded';
export type DependencyStatus = 'up' | 'down';

export interface DatabaseHealth {
  status: DependencyStatus;
  latencyMs: number | null;
}

export interface HealthPayload {
  status: HealthStatus;
  uptime: number;
  timestamp: string;
  checks: {
    database?: DatabaseHealth;
  };
}

export interface HealthCheckResult {
  healthy: boolean;
  data: HealthPayload;
}

export interface HealthQuery {
  check: HealthCheckMode;
}

export function parseHealthQuery(rawQuery: Record<string, unknown>): HealthQuery {
  const rawCheck = rawQuery.check;
  if (rawCheck === undefined || rawCheck === '') {
    return { check: 'all' };
  }
  if (rawCheck === 'all' || rawCheck === 'live') {
    return { check: rawCheck };
  }
  throw badRequest('Invalid check parameter. Expected "all" or "live".');
}
