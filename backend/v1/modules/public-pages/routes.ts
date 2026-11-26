import express, { type RequestHandler, type Router } from 'express';
import { created, ok } from '../../lib/respond.js';
import { optionalSession } from '../../middlewares/auth.js';
import { parseUuidParam } from '../files/schemas.js';
import { parseContactEventBody } from './schemas.js';
import { getPublicBuilding, getPublicSpaceType, recordContactEvent } from './service.js';

export interface PublicPagesRouterDeps {
  optionalAuth?: RequestHandler;
  getPublicBuilding?: typeof getPublicBuilding;
  getPublicSpaceType?: typeof getPublicSpaceType;
  recordContactEvent?: typeof recordContactEvent;
}

/**
 * The public building and space-type pages (FR-SRC-007, FR-SRC-008) and tap-to-call events
 * (FR-ENQ-004). Open to Guests; the phone number needs a session (BR-009). A building that is not
 * on display answers 404 (unknown, draft, pending) or 410 `BUILDING_UNAVAILABLE` (was public).
 */
export function createPublicPagesRouter(deps: PublicPagesRouterDeps = {}): Router {
  const router = express.Router();
  const auth = deps.optionalAuth ?? optionalSession();
  const buildingFn = deps.getPublicBuilding ?? getPublicBuilding;
  const spaceTypeFn = deps.getPublicSpaceType ?? getPublicSpaceType;
  const contactEventFn = deps.recordContactEvent ?? recordContactEvent;

  router.get('/buildings/:buildingId/public', auth, async (req, res) => {
    const buildingId = parseUuidParam(req.params.buildingId, 'buildingId');
    ok(res, await buildingFn(req.auth, buildingId), 'Building');
  });

  router.get('/space-types/:spaceTypeId/public', auth, async (req, res) => {
    const spaceTypeId = parseUuidParam(req.params.spaceTypeId, 'spaceTypeId');
    ok(res, await spaceTypeFn(req.auth, spaceTypeId), 'Space type');
  });

  router.post('/buildings/:buildingId/contact-events', auth, async (req, res) => {
    const buildingId = parseUuidParam(req.params.buildingId, 'buildingId');
    const input = parseContactEventBody(req.body);
    await contactEventFn(req.auth, buildingId, input);
    created(res, null, 'Contact event recorded');
  });

  return router;
}

export default createPublicPagesRouter();
