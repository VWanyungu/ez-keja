import express, { type RequestHandler, type Router } from 'express';
import { sendCsv } from '../../lib/csv.js';
import { ok } from '../../lib/respond.js';
import { requireRole, requireSession } from '../../middlewares/auth.js';
import { parseAuditQuery } from './schemas.js';
import { exportAuditCsv, searchAudit } from './service.js';

export interface AuditRouterDeps {
  requireAuth?: RequestHandler;
  requireAdmin?: RequestHandler;
  search?: typeof searchAudit;
  exportCsv?: typeof exportAuditCsv;
}

/** FR-ADM-007 audit search (and its CSV export, FR-RPT-002): `GET /admin/audit`. */
export function createAuditRouter(deps: AuditRouterDeps = {}): Router {
  const router = express.Router();
  const auth = deps.requireAuth ?? requireSession();
  const adminOnly = deps.requireAdmin ?? requireRole('admin');
  const searchFn = deps.search ?? searchAudit;
  const exportFn = deps.exportCsv ?? exportAuditCsv;

  router.get('/admin/audit', auth, adminOnly, async (req, res) => {
    const query = parseAuditQuery(req.query);
    if (query.format === 'csv') {
      const { csv, truncated } = await exportFn(req.auth!, query.filters);
      sendCsv(res, 'audit.csv', csv, truncated ? { 'x-export-truncated': 'true' } : {});
      return;
    }
    ok(res, await searchFn(query.filters, query), 'Audit entries');
  });

  return router;
}

export default createAuditRouter();
