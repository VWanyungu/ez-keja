import express, { type RequestHandler, type Router } from 'express';
import { ok } from '../../lib/respond.js';
import { optionalSession } from '../../middlewares/auth.js';
import { parseSearchQuery } from './schemas.js';
import { searchBuildings } from './service.js';

export interface SearchRouterDeps {
  optionalAuth?: RequestHandler;
  searchBuildings?: typeof searchBuildings;
}

/** Public search (FR-SRC-001 to FR-SRC-006): open to Guests, a bad token is still refused. Cards never carry a phone. */
export function createSearchRouter(deps: SearchRouterDeps = {}): Router {
  const router = express.Router();
  const auth = deps.optionalAuth ?? optionalSession();
  const searchFn = deps.searchBuildings ?? searchBuildings;

  router.get('/search/buildings', auth, async (req, res) => {
    ok(res, await searchFn(parseSearchQuery(req.query)), 'Search results');
  });

  return router;
}

export default createSearchRouter();
