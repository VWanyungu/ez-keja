import express, { type RequestHandler, type Router } from 'express';
import { ok } from '../../lib/respond.js';
import { requireRole, requireSession } from '../../middlewares/auth.js';
import { parseUuidParam } from '../files/schemas.js';
import { parseModerationBody } from './schemas.js';
import { reinstateBuilding, reinstateUser, suspendBuilding, suspendUser } from './service.js';

export interface ModerationRouterDeps {
  requireAuth?: RequestHandler;
  requireAdmin?: RequestHandler;
  suspendUser?: typeof suspendUser;
  reinstateUser?: typeof reinstateUser;
  suspendBuilding?: typeof suspendBuilding;
  reinstateBuilding?: typeof reinstateBuilding;
}

/** Moderation (FR-ADM-003). Absolute paths: `/admin/users/:id/...` and `/admin/buildings/:id/...`. */
export function createModerationRouter(deps: ModerationRouterDeps = {}): Router {
  const router = express.Router();
  const auth = deps.requireAuth ?? requireSession();
  const adminOnly = deps.requireAdmin ?? requireRole('admin');
  const suspendUserFn = deps.suspendUser ?? suspendUser;
  const reinstateUserFn = deps.reinstateUser ?? reinstateUser;
  const suspendBuildingFn = deps.suspendBuilding ?? suspendBuilding;
  const reinstateBuildingFn = deps.reinstateBuilding ?? reinstateBuilding;

  router.post('/admin/users/:id/suspend', auth, adminOnly, async (req, res) => {
    const id = parseUuidParam(req.params.id, 'id');
    const { reason } = parseModerationBody(req.body);
    ok(res, await suspendUserFn(req.auth!, id, reason), 'User suspended');
  });

  router.post('/admin/users/:id/reinstate', auth, adminOnly, async (req, res) => {
    const id = parseUuidParam(req.params.id, 'id');
    const { reason } = parseModerationBody(req.body);
    ok(res, await reinstateUserFn(req.auth!, id, reason), 'User reinstated');
  });

  router.post('/admin/buildings/:id/suspend', auth, adminOnly, async (req, res) => {
    const id = parseUuidParam(req.params.id, 'id');
    const { reason } = parseModerationBody(req.body);
    ok(res, await suspendBuildingFn(req.auth!, id, reason), 'Building suspended');
  });

  router.post('/admin/buildings/:id/reinstate', auth, adminOnly, async (req, res) => {
    const id = parseUuidParam(req.params.id, 'id');
    const { reason } = parseModerationBody(req.body);
    ok(res, await reinstateBuildingFn(req.auth!, id, reason), 'Building reinstated');
  });

  return router;
}

export default createModerationRouter();
