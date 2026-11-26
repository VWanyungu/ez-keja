import express, { type RequestHandler, type Router } from 'express';
import { ok } from '../../lib/respond.js';
import { optionalSession } from '../../middlewares/auth.js';
import { parseUuidParam } from '../files/schemas.js';
import { getLister } from './service.js';

export interface ListersRouterDeps {
  optionalAuth?: RequestHandler;
  getLister?: typeof getLister;
}

/** FR-ACC-004: public lister profile. The phone needs a session (BR-009). */
export function createListersRouter(deps: ListersRouterDeps = {}): Router {
  const router = express.Router();
  const auth = deps.optionalAuth ?? optionalSession();
  const listerFn = deps.getLister ?? getLister;

  router.get('/listers/:userId', auth, async (req, res) => {
    const userId = parseUuidParam(req.params.userId, 'userId');
    ok(res, await listerFn(req.auth, userId), 'Lister');
  });

  return router;
}

export default createListersRouter();
