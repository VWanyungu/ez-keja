import express, { type RequestHandler, type Router } from 'express';
import { ok } from '../../lib/respond.js';
import { requireSession, type AuthContext } from '../../middlewares/auth.js';
import { parsePatchMeBody, type PatchMeInput } from './schemas.js';
import { getMe, updateMe, type MePayload } from './service.js';

export interface MeRouterDeps {
  requireAuth?: RequestHandler;
  getMe?: (authContext: AuthContext) => MePayload;
  updateMe?: (authContext: AuthContext, patch: PatchMeInput) => Promise<MePayload>;
}

export function createMeRouter(deps: MeRouterDeps = {}): Router {
  const router = express.Router();
  const authMiddleware = deps.requireAuth ?? requireSession();
  const getMeFn = deps.getMe ?? getMe;
  const updateMeFn = deps.updateMe ?? updateMe;

  router.get('/', authMiddleware, (req, res) => {
    const profile = getMeFn(req.auth!);
    ok(res, profile, 'Current profile');
  });

  router.patch('/', authMiddleware, async (req, res) => {
    const patch = parsePatchMeBody(req.body);
    const updated = await updateMeFn(req.auth!, patch);
    ok(res, updated, 'Profile updated');
  });

  return router;
}

export default createMeRouter();
