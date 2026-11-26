import express, { type RequestHandler, type Router } from 'express';
import { created, ok } from '../../lib/respond.js';
import { requireRole, requireSession } from '../../middlewares/auth.js';
import { parseUuidParam } from '../files/schemas.js';
import { parseCreateReportBody, parseListReportsQuery, parseResolveReportBody } from './schemas.js';
import { createReport, listReports, resolveReport } from './service.js';

export interface ReportsRouterDeps {
  requireAuth?: RequestHandler;
  requireAdmin?: RequestHandler;
  createReport?: typeof createReport;
  listReports?: typeof listReports;
  resolveReport?: typeof resolveReport;
}

/**
 * Reports on buildings and space types (FR-AVL-010) and the Admin queue (FR-ADM-005). Reporting
 * needs a signed-in user (BR-008): a Guest gets 401 and the screen prompts for login.
 */
export function createReportsRouter(deps: ReportsRouterDeps = {}): Router {
  const router = express.Router();
  const auth = deps.requireAuth ?? requireSession();
  const adminOnly = deps.requireAdmin ?? requireRole('admin');
  const createFn = deps.createReport ?? createReport;
  const listFn = deps.listReports ?? listReports;
  const resolveFn = deps.resolveReport ?? resolveReport;

  for (const [segment, type] of [['buildings', 'building'], ['space-types', 'space_type']] as const) {
    router.post(`/${segment}/:id/reports`, auth, async (req, res) => {
      const receipt = await createFn(req.auth!, { type, id: parseUuidParam(req.params.id, 'id') }, parseCreateReportBody(req.body));
      // A repeat report is not an error: the existing one is returned with 200 and counted once.
      if (receipt.duplicate) ok(res, receipt, 'You have already reported this; it counts once');
      else created(res, receipt, 'Report received');
    });
  }

  router.get('/admin/reports', auth, adminOnly, async (req, res) => {
    ok(res, await listFn(req.auth!, parseListReportsQuery(req.query)), 'Reports');
  });

  router.post('/admin/reports/:id/resolve', auth, adminOnly, async (req, res) => {
    ok(res, await resolveFn(req.auth!, parseUuidParam(req.params.id, 'id'), parseResolveReportBody(req.body)), 'Report resolved');
  });

  return router;
}

export default createReportsRouter();
