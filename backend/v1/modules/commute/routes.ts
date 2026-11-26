import express, { type RequestHandler, type Router } from 'express';
import { ok } from '../../lib/respond.js';
import { optionalSession } from '../../middlewares/auth.js';
import { parseCommuteQuery } from './schemas.js';
import { getCommute } from './service.js';

export interface CommuteRouterDeps {
  optionalAuth?: RequestHandler;
  getCommute?: typeof getCommute;
}

/**
 * Commute estimates (FR-CMT-001 to FR-CMT-005). Open to Guests. A Maps problem never makes this a
 * 5xx: it answers 200 with `available: false` and a notice, and the page keeps working.
 */
export function createCommuteRouter(deps: CommuteRouterDeps = {}): Router {
  const router = express.Router();
  const auth = deps.optionalAuth ?? optionalSession();
  const commuteFn = deps.getCommute ?? getCommute;

  router.get('/commute', auth, async (req, res) => {
    ok(res, await commuteFn(parseCommuteQuery(req.query)), 'Commute');
  });

  return router;
}

export default createCommuteRouter();
