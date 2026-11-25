import express, { type RequestHandler, type Router } from 'express';
import { parseKeysetQuery } from '../../lib/keyset.js';
import { ok } from '../../lib/respond.js';
import { requireSession } from '../../middlewares/auth.js';
import { parseUuidParam } from '../files/schemas.js';
import { parseBulkConfirmBody, parseConfirmBody, parseSetCountBody } from './schemas.js';
import {
  bulkConfirm,
  confirmVacantCount,
  listAvailabilityEvents,
  markFullyLet,
  setVacantCount,
} from './service.js';

export interface AvailabilityRouterDeps {
  requireAuth?: RequestHandler;
  setVacantCount?: typeof setVacantCount;
  confirmVacantCount?: typeof confirmVacantCount;
  markFullyLet?: typeof markFullyLet;
  bulkConfirm?: typeof bulkConfirm;
  listAvailabilityEvents?: typeof listAvailabilityEvents;
}

/**
 * Vacant counts and their history (FR-AVL-001, -003, -004, -008). Every route is for the
 * building's maintainers or an Admin (BR-003); the service checks that, so the router only needs a
 * session. Notifying clients when a space type becomes Fully let is Phase 9.
 */
export function createAvailabilityRouter(deps: AvailabilityRouterDeps = {}): Router {
  const router = express.Router();
  const auth = deps.requireAuth ?? requireSession();

  const setFn = deps.setVacantCount ?? setVacantCount;
  const confirmFn = deps.confirmVacantCount ?? confirmVacantCount;
  const fullyLetFn = deps.markFullyLet ?? markFullyLet;
  const bulkFn = deps.bulkConfirm ?? bulkConfirm;
  const eventsFn = deps.listAvailabilityEvents ?? listAvailabilityEvents;

  router.put('/space-types/:spaceTypeId/vacant-count', auth, async (req, res) => {
    const spaceTypeId = parseUuidParam(req.params.spaceTypeId, 'spaceTypeId');
    const { vacantCount } = parseSetCountBody(req.body);
    ok(res, await setFn(req.auth!, spaceTypeId, vacantCount), 'Vacant count set');
  });

  router.post('/space-types/:spaceTypeId/confirm', auth, async (req, res) => {
    const spaceTypeId = parseUuidParam(req.params.spaceTypeId, 'spaceTypeId');
    const { vacantCount } = parseConfirmBody(req.body);
    ok(res, await confirmFn(req.auth!, spaceTypeId, vacantCount), 'Vacant count confirmed');
  });

  router.post('/space-types/:spaceTypeId/fully-let', auth, async (req, res) => {
    const spaceTypeId = parseUuidParam(req.params.spaceTypeId, 'spaceTypeId');
    ok(res, await fullyLetFn(req.auth!, spaceTypeId), 'Space type marked fully let');
  });

  router.post('/availability/bulk-confirm', auth, async (req, res) => {
    const { items } = parseBulkConfirmBody(req.body);
    ok(res, await bulkFn(req.auth!, items), 'Vacant counts confirmed');
  });

  router.get('/space-types/:spaceTypeId/availability-events', auth, async (req, res) => {
    const spaceTypeId = parseUuidParam(req.params.spaceTypeId, 'spaceTypeId');
    ok(res, await eventsFn(req.auth!, spaceTypeId, parseKeysetQuery(req.query)), 'Availability history');
  });

  return router;
}

export default createAvailabilityRouter();
