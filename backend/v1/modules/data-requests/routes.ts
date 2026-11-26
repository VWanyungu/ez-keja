import express, { type RequestHandler, type Router } from 'express';
import { created, ok } from '../../lib/respond.js';
import { requireRole, requireSession } from '../../middlewares/auth.js';
import { parseUuidParam } from '../files/schemas.js';
import { getOwnData, runExport } from './export.js';
import { parseAdminListQuery, parseCreateRequestBody, parseOutcomeBody, parseOwnListQuery } from './schemas.js';
import { completeRequest, createRequest, listOwnRequests, listRequests, rejectRequest, startRequest } from './service.js';

export interface DataRequestsRouterDeps {
  requireAuth?: RequestHandler;
  requireAdmin?: RequestHandler;
  createRequest?: typeof createRequest;
  listOwnRequests?: typeof listOwnRequests;
  getOwnData?: typeof getOwnData;
  runExport?: typeof runExport;
  listRequests?: typeof listRequests;
  startRequest?: typeof startRequest;
  completeRequest?: typeof completeRequest;
  rejectRequest?: typeof rejectRequest;
}

/**
 * Data subject requests (FR-PRV-002): a user's own requests and data under `/me`, and the Admin
 * queue under `/admin/data-requests`. Absolute paths; mounted before nothing else on `/me/...`
 * because the `/me` router only answers `GET /me` and `PATCH /me`.
 */
export function createDataRequestsRouter(deps: DataRequestsRouterDeps = {}): Router {
  const router = express.Router();
  const auth = deps.requireAuth ?? requireSession();
  const adminOnly = deps.requireAdmin ?? requireRole('admin');
  const createFn = deps.createRequest ?? createRequest;
  const listOwnFn = deps.listOwnRequests ?? listOwnRequests;
  const ownDataFn = deps.getOwnData ?? getOwnData;
  const exportFn = deps.runExport ?? runExport;
  const listFn = deps.listRequests ?? listRequests;
  const startFn = deps.startRequest ?? startRequest;
  const completeFn = deps.completeRequest ?? completeRequest;
  const rejectFn = deps.rejectRequest ?? rejectRequest;

  router.get('/me/data', auth, async (req, res) => {
    ok(res, await ownDataFn(req.auth!), 'Your personal data');
  });

  router.post('/me/data-requests', auth, async (req, res) => {
    created(res, await createFn(req.auth!, parseCreateRequestBody(req.body)), 'Data request received');
  });

  router.get('/me/data-requests', auth, async (req, res) => {
    ok(res, await listOwnFn(req.auth!, parseOwnListQuery(req.query)), 'Your data requests');
  });

  router.get('/me/data-requests/:id/export', auth, async (req, res) => {
    ok(res, await exportFn(req.auth!, parseUuidParam(req.params.id, 'id')), 'Your personal data export');
  });

  router.get('/admin/data-requests', auth, adminOnly, async (req, res) => {
    ok(res, await listFn(req.auth!, parseAdminListQuery(req.query)), 'Data requests');
  });

  router.post('/admin/data-requests/:id/start', auth, adminOnly, async (req, res) => {
    ok(res, await startFn(req.auth!, parseUuidParam(req.params.id, 'id')), 'Data request started');
  });

  router.post('/admin/data-requests/:id/complete', auth, adminOnly, async (req, res) => {
    const id = parseUuidParam(req.params.id, 'id');
    const { outcome } = parseOutcomeBody(req.body);
    ok(res, await completeFn(req.auth!, id, outcome), 'Data request completed');
  });

  router.post('/admin/data-requests/:id/reject', auth, adminOnly, async (req, res) => {
    const id = parseUuidParam(req.params.id, 'id');
    const { outcome } = parseOutcomeBody(req.body);
    ok(res, await rejectFn(req.auth!, id, outcome), 'Data request rejected');
  });

  return router;
}

export default createDataRequestsRouter();
