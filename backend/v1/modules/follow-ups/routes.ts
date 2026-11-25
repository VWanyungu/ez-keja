import express, { type RequestHandler, type Router } from 'express';
import { created, ok } from '../../lib/respond.js';
import { requireRole, requireSession } from '../../middlewares/auth.js';
import { parseUuidParam } from '../files/schemas.js';
import { parseRecordFollowUpBody } from './schemas.js';
import { listFollowUpQueue, recordFollowUp } from './service.js';

export interface FollowUpsRouterDeps {
  requireAuth?: RequestHandler;
  requireAdmin?: RequestHandler;
  listFollowUpQueue?: typeof listFollowUpQueue;
  recordFollowUp?: typeof recordFollowUp;
}

/** The Admin follow-up queue (FR-ADM-002). Admin only; absolute paths, like the catalogue routers. */
export function createFollowUpsRouter(deps: FollowUpsRouterDeps = {}): Router {
  const router = express.Router();
  const auth = deps.requireAuth ?? requireSession();
  const adminOnly = deps.requireAdmin ?? requireRole('admin');
  const queueFn = deps.listFollowUpQueue ?? listFollowUpQueue;
  const recordFn = deps.recordFollowUp ?? recordFollowUp;

  router.get('/admin/follow-ups', auth, adminOnly, async (_req, res) => {
    ok(res, await queueFn(), 'Follow-up queue');
  });

  router.post('/admin/space-types/:spaceTypeId/follow-ups', auth, adminOnly, async (req, res) => {
    const spaceTypeId = parseUuidParam(req.params.spaceTypeId, 'spaceTypeId');
    const input = parseRecordFollowUpBody(req.body);
    created(res, await recordFn(req.auth!, spaceTypeId, input), 'Follow-up recorded');
  });

  return router;
}

export default createFollowUpsRouter();
