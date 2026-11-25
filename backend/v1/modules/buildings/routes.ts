import express, { type RequestHandler, type Router } from 'express';
import { created, ok } from '../../lib/respond.js';
import { requireRole, requireSession } from '../../middlewares/auth.js';
import { parseUuidParam } from '../files/schemas.js';
import { parseCreateBuildingBody, parsePatchBuildingBody, parseUserBody } from './schemas.js';
import {
  addMaintainer,
  createBuilding,
  getBuilding,
  getPublishBlockers,
  listMyBuildings,
  publishBuilding,
  removeMaintainer,
  reopenBuilding,
  setContact,
  updateBuilding,
  withdrawBuilding,
} from './service.js';

export interface BuildingsRouterDeps {
  requireAuth?: RequestHandler;
  requireLister?: RequestHandler;
  createBuilding?: typeof createBuilding;
  listMyBuildings?: typeof listMyBuildings;
  getBuilding?: typeof getBuilding;
  updateBuilding?: typeof updateBuilding;
  withdrawBuilding?: typeof withdrawBuilding;
  reopenBuilding?: typeof reopenBuilding;
  getPublishBlockers?: typeof getPublishBlockers;
  publishBuilding?: typeof publishBuilding;
  addMaintainer?: typeof addMaintainer;
  removeMaintainer?: typeof removeMaintainer;
  setContact?: typeof setContact;
}

/**
 * Buildings (FR-UNT-001, -005 to -008, FR-VER-008, FR-RPT-003). Access to one building (maintainer
 * or Admin, BR-003) is checked in the service; the router only needs a session, and a lister
 * role to create or list. Public search and pages are Phase 7.
 */
export function createBuildingsRouter(deps: BuildingsRouterDeps = {}): Router {
  const router = express.Router();
  const auth = deps.requireAuth ?? requireSession();
  const listers = deps.requireLister ?? requireRole('landlord', 'agent', 'admin');

  const createFn = deps.createBuilding ?? createBuilding;
  const mineFn = deps.listMyBuildings ?? listMyBuildings;
  const getFn = deps.getBuilding ?? getBuilding;
  const updateFn = deps.updateBuilding ?? updateBuilding;
  const withdrawFn = deps.withdrawBuilding ?? withdrawBuilding;
  const reopenFn = deps.reopenBuilding ?? reopenBuilding;
  const blockersFn = deps.getPublishBlockers ?? getPublishBlockers;
  const publishFn = deps.publishBuilding ?? publishBuilding;
  const addMaintainerFn = deps.addMaintainer ?? addMaintainer;
  const removeMaintainerFn = deps.removeMaintainer ?? removeMaintainer;
  const setContactFn = deps.setContact ?? setContact;

  router.post('/buildings', auth, listers, async (req, res) => {
    const input = parseCreateBuildingBody(req.body);
    created(res, await createFn(req.auth!, input), 'Building created as a draft');
  });

  // Declared before /buildings/:buildingId so "mine" is not read as an id.
  router.get('/buildings/mine', auth, listers, async (req, res) => {
    ok(res, await mineFn(req.auth!), 'My buildings');
  });

  router.get('/buildings/:buildingId', auth, async (req, res) => {
    const buildingId = parseUuidParam(req.params.buildingId, 'buildingId');
    ok(res, await getFn(req.auth!, buildingId), 'Building');
  });

  router.patch('/buildings/:buildingId', auth, async (req, res) => {
    const buildingId = parseUuidParam(req.params.buildingId, 'buildingId');
    const patch = parsePatchBuildingBody(req.body);
    ok(res, await updateFn(req.auth!, buildingId, patch), 'Building updated');
  });

  router.post('/buildings/:buildingId/withdraw', auth, async (req, res) => {
    const buildingId = parseUuidParam(req.params.buildingId, 'buildingId');
    ok(res, await withdrawFn(req.auth!, buildingId), 'Building withdrawn');
  });

  router.post('/buildings/:buildingId/reopen', auth, async (req, res) => {
    const buildingId = parseUuidParam(req.params.buildingId, 'buildingId');
    ok(res, await reopenFn(req.auth!, buildingId), 'Building reopened as a draft');
  });

  router.get('/buildings/:buildingId/publish-blockers', auth, async (req, res) => {
    const buildingId = parseUuidParam(req.params.buildingId, 'buildingId');
    ok(res, await blockersFn(req.auth!, buildingId), 'Publish blockers');
  });

  router.post('/buildings/:buildingId/publish', auth, async (req, res) => {
    const buildingId = parseUuidParam(req.params.buildingId, 'buildingId');
    const result = await publishFn(req.auth!, buildingId);
    ok(
      res,
      result,
      result.outcome === 'published'
        ? 'Building published'
        : 'Building saved as pending until the lister is verified',
    );
  });

  router.post('/buildings/:buildingId/maintainers', auth, async (req, res) => {
    const buildingId = parseUuidParam(req.params.buildingId, 'buildingId');
    const { userId } = parseUserBody(req.body);
    created(res, await addMaintainerFn(req.auth!, buildingId, userId), 'Maintainer added');
  });

  router.delete('/buildings/:buildingId/maintainers/:userId', auth, async (req, res) => {
    const buildingId = parseUuidParam(req.params.buildingId, 'buildingId');
    const userId = parseUuidParam(req.params.userId, 'userId');
    ok(res, await removeMaintainerFn(req.auth!, buildingId, userId), 'Maintainer removed');
  });

  router.put('/buildings/:buildingId/contact', auth, async (req, res) => {
    const buildingId = parseUuidParam(req.params.buildingId, 'buildingId');
    const { userId } = parseUserBody(req.body);
    ok(res, await setContactFn(req.auth!, buildingId, userId), 'Designated contact set');
  });

  return router;
}

export default createBuildingsRouter();
