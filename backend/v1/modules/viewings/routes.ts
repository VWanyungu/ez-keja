import express, { type RequestHandler, type Router } from 'express';
import { created, ok } from '../../lib/respond.js';
import { requireSession } from '../../middlewares/auth.js';
import { parseUuidParam } from '../files/schemas.js';
import { parseCounterBody, parseListViewingsQuery, parseRequestViewingBody } from './schemas.js';
import { listViewings, requestViewing, transitionViewing, type ViewingAction } from './service.js';

export interface ViewingsRouterDeps {
  requireAuth?: RequestHandler;
  requestViewing?: typeof requestViewing;
  transitionViewing?: typeof transitionViewing;
  listViewings?: typeof listViewings;
}

const ACTION_PATHS: Array<{ path: string; action: ViewingAction; message: string }> = [
  { path: 'accept', action: 'accept', message: 'Viewing accepted' },
  { path: 'decline', action: 'decline', message: 'Viewing declined' },
  { path: 'accept-counter', action: 'accept-counter', message: 'New time accepted' },
  { path: 'decline-counter', action: 'decline-counter', message: 'New time declined; the request is cancelled' },
  { path: 'cancel', action: 'cancel', message: 'Viewing request cancelled' },
];

/** Viewing requests (FR-ENQ-002, TX-07). Login required for every route (BR-008). */
export function createViewingsRouter(deps: ViewingsRouterDeps = {}): Router {
  const router = express.Router();
  const auth = deps.requireAuth ?? requireSession();
  const requestFn = deps.requestViewing ?? requestViewing;
  const transitionFn = deps.transitionViewing ?? transitionViewing;
  const listFn = deps.listViewings ?? listViewings;

  router.post('/space-types/:id/viewings', auth, async (req, res) => {
    created(res, await requestFn(req.auth!, parseUuidParam(req.params.id, 'id'), parseRequestViewingBody(req.body)), 'Viewing requested');
  });

  router.get('/viewings', auth, async (req, res) => {
    ok(res, await listFn(req.auth!, parseListViewingsQuery(req.query)), 'Viewing requests');
  });

  for (const { path, action, message } of ACTION_PATHS) {
    router.post(`/viewings/:id/${path}`, auth, async (req, res) => {
      ok(res, await transitionFn(req.auth!, parseUuidParam(req.params.id, 'id'), action), message);
    });
  }

  router.post('/viewings/:id/counter', auth, async (req, res) => {
    const input = parseCounterBody(req.body);
    ok(res, await transitionFn(req.auth!, parseUuidParam(req.params.id, 'id'), 'counter', input), 'New time proposed');
  });

  return router;
}

export default createViewingsRouter();
