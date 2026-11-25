import express, { type RequestHandler, type Router } from 'express';
import { created, ok } from '../../lib/respond.js';
import { requireSession } from '../../middlewares/auth.js';
import { parseUuidParam } from '../files/schemas.js';
import {
  parseCreateSpaceTypeBody,
  parseIncludeRemoved,
  parsePatchSpaceTypeBody,
  parseRestoreSpaceTypeBody,
} from './schemas.js';
import {
  createSpaceType,
  listSpaceTypes,
  removeSpaceType,
  restoreSpaceType,
  updateSpaceType,
} from './service.js';

export interface SpaceTypesRouterDeps {
  requireAuth?: RequestHandler;
  listSpaceTypes?: typeof listSpaceTypes;
  createSpaceType?: typeof createSpaceType;
  updateSpaceType?: typeof updateSpaceType;
  removeSpaceType?: typeof removeSpaceType;
  restoreSpaceType?: typeof restoreSpaceType;
}

/**
 * Space types of a building (FR-UNT-002 to -004, -007, -010, -011). Every route is for the
 * building's maintainers or an Admin; the service checks that, so the router only needs a session.
 * Public space-type pages are Phase 7.
 */
export function createSpaceTypesRouter(deps: SpaceTypesRouterDeps = {}): Router {
  const router = express.Router();
  const auth = deps.requireAuth ?? requireSession();

  const listFn = deps.listSpaceTypes ?? listSpaceTypes;
  const createFn = deps.createSpaceType ?? createSpaceType;
  const updateFn = deps.updateSpaceType ?? updateSpaceType;
  const removeFn = deps.removeSpaceType ?? removeSpaceType;
  const restoreFn = deps.restoreSpaceType ?? restoreSpaceType;

  router.get('/buildings/:buildingId/space-types', auth, async (req, res) => {
    const buildingId = parseUuidParam(req.params.buildingId, 'buildingId');
    const includeRemoved = parseIncludeRemoved(req.query.includeRemoved);
    ok(res, await listFn(req.auth!, buildingId, includeRemoved), 'Space types');
  });

  router.post('/buildings/:buildingId/space-types', auth, async (req, res) => {
    const buildingId = parseUuidParam(req.params.buildingId, 'buildingId');
    const input = parseCreateSpaceTypeBody(req.body);
    created(res, await createFn(req.auth!, buildingId, input), 'Space type created');
  });

  router.patch('/space-types/:spaceTypeId', auth, async (req, res) => {
    const spaceTypeId = parseUuidParam(req.params.spaceTypeId, 'spaceTypeId');
    const patch = parsePatchSpaceTypeBody(req.body);
    ok(res, await updateFn(req.auth!, spaceTypeId, patch), 'Space type updated');
  });

  router.delete('/space-types/:spaceTypeId', auth, async (req, res) => {
    const spaceTypeId = parseUuidParam(req.params.spaceTypeId, 'spaceTypeId');
    ok(res, await removeFn(req.auth!, spaceTypeId), 'Space type removed');
  });

  router.post('/space-types/:spaceTypeId/restore', auth, async (req, res) => {
    const spaceTypeId = parseUuidParam(req.params.spaceTypeId, 'spaceTypeId');
    const input = parseRestoreSpaceTypeBody(req.body);
    ok(res, await restoreFn(req.auth!, spaceTypeId, input), 'Space type restored');
  });

  return router;
}

export default createSpaceTypesRouter();
