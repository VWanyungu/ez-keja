import express, { type Router } from 'express';
import { error, ok } from '../../lib/respond.js';
import { parseHealthQuery, type HealthCheckResult, type HealthQuery } from './schemas.js';
import { getHealthStatus } from './service.js';

export type HealthStatusProvider = (query: HealthQuery) => Promise<HealthCheckResult>;

export function createHealthRouter(
  resolveHealth: HealthStatusProvider = getHealthStatus,
): Router {
  const router = express.Router();

  router.get('/', async (req, res) => {
    const query = parseHealthQuery(req.query as Record<string, unknown>);
    const result = await resolveHealth(query);

    if (result.healthy) {
      ok(res, result.data, 'Service is healthy');
      return;
    }

    error(res, 503, 'Service unavailable', result.data);
  });

  return router;
}

export default createHealthRouter();
