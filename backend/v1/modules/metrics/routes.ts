import express, { type RequestHandler, type Router } from 'express';
import { sendCsv } from '../../lib/csv.js';
import { ok } from '../../lib/respond.js';
import { requireRole, requireSession } from '../../middlewares/auth.js';
import { parseExportQuery, parseMetricFilters } from './schemas.js';
import { exportMetricCsv, getMetrics } from './service.js';

export interface MetricsRouterDeps {
  requireAuth?: RequestHandler;
  requireAdmin?: RequestHandler;
  getMetrics?: typeof getMetrics;
  exportMetric?: typeof exportMetricCsv;
}

/** Admin dashboard metrics (FR-RPT-001) and CSV export (FR-RPT-002): `/admin/metrics`. */
export function createMetricsRouter(deps: MetricsRouterDeps = {}): Router {
  const router = express.Router();
  const auth = deps.requireAuth ?? requireSession();
  const adminOnly = deps.requireAdmin ?? requireRole('admin');
  const metricsFn = deps.getMetrics ?? getMetrics;
  const exportFn = deps.exportMetric ?? exportMetricCsv;

  router.get('/admin/metrics', auth, adminOnly, async (req, res) => {
    ok(res, await metricsFn(parseMetricFilters(req.query)), 'Metrics');
  });

  // Registered before nothing that could shadow it: `/admin/metrics/export` is its own path.
  router.get('/admin/metrics/export', auth, adminOnly, async (req, res) => {
    const { metric, filters } = parseExportQuery(req.query);
    const { csv, filename } = await exportFn(req.auth!, metric, filters);
    sendCsv(res, filename, csv);
  });

  return router;
}

export default createMetricsRouter();
