import express, { type RequestHandler, type Router } from 'express';
import { parseKeysetQuery } from '../../lib/keyset.js';
import { created, ok } from '../../lib/respond.js';
import { requireRole, requireSession } from '../../middlewares/auth.js';
import { parseUuidParam } from '../files/schemas.js';
import {
  parseAddEvidenceBody,
  parseDecisionBody,
  parseQueueQuery,
  parseRevokeBody,
  parseSubmitBody,
} from './schemas.js';
import {
  addAdminEvidence,
  decideCase,
  getCase,
  listCases,
  listMyCases,
  revokeVerification,
  submitAccountVerification,
  submitBuildingVerification,
} from './service.js';

export interface VerificationRouterDeps {
  requireAuth?: RequestHandler;
  requireAdmin?: RequestHandler;
  requireLister?: RequestHandler;
  submitAccount?: typeof submitAccountVerification;
  submitBuilding?: typeof submitBuildingVerification;
  listMine?: typeof listMyCases;
  listCases?: typeof listCases;
  getCase?: typeof getCase;
  addEvidence?: typeof addAdminEvidence;
  decide?: typeof decideCase;
  revoke?: typeof revokeVerification;
}

/**
 * Verification of accounts and buildings (FR-VER-001 to -006). Absolute paths, like the other
 * catalogue routers: `/verification/...` for applicants and `/admin/verification/...` for the
 * Admin queue. Whether the caller maintains a building is checked in the service.
 */
export function createVerificationRouter(deps: VerificationRouterDeps = {}): Router {
  const router = express.Router();
  const auth = deps.requireAuth ?? requireSession();
  const adminOnly = deps.requireAdmin ?? requireRole('admin');
  const listers = deps.requireLister ?? requireRole('landlord', 'agent');

  const submitAccountFn = deps.submitAccount ?? submitAccountVerification;
  const submitBuildingFn = deps.submitBuilding ?? submitBuildingVerification;
  const mineFn = deps.listMine ?? listMyCases;
  const casesFn = deps.listCases ?? listCases;
  const caseFn = deps.getCase ?? getCase;
  const addEvidenceFn = deps.addEvidence ?? addAdminEvidence;
  const decideFn = deps.decide ?? decideCase;
  const revokeFn = deps.revoke ?? revokeVerification;

  router.post('/verification/account', auth, listers, async (req, res) => {
    const input = parseSubmitBody(req.body);
    created(res, await submitAccountFn(req.auth!, input), 'Account verification submitted');
  });

  router.post('/verification/buildings/:buildingId', auth, async (req, res) => {
    const buildingId = parseUuidParam(req.params.buildingId, 'buildingId');
    const input = parseSubmitBody(req.body);
    created(res, await submitBuildingFn(req.auth!, buildingId, input), 'Building verification submitted');
  });

  router.get('/verification/mine', auth, async (req, res) => {
    ok(res, await mineFn(req.auth!, parseKeysetQuery(req.query)), 'My verification cases');
  });

  router.get('/admin/verification/cases', auth, adminOnly, async (req, res) => {
    ok(res, await casesFn(parseQueueQuery(req.query)), 'Verification cases');
  });

  router.get('/admin/verification/cases/:id', auth, adminOnly, async (req, res) => {
    const id = parseUuidParam(req.params.id, 'id');
    ok(res, await caseFn(req.auth!, id), 'Verification case');
  });

  router.post('/admin/verification/cases/:id/evidence', auth, adminOnly, async (req, res) => {
    const id = parseUuidParam(req.params.id, 'id');
    const { evidenceType } = parseAddEvidenceBody(req.body);
    created(res, await addEvidenceFn(req.auth!, id, evidenceType), 'Evidence added');
  });

  router.post('/admin/verification/cases/:id/decision', auth, adminOnly, async (req, res) => {
    const id = parseUuidParam(req.params.id, 'id');
    const input = parseDecisionBody(req.body);
    ok(res, await decideFn(req.auth!, id, input), input.decision === 'approve' ? 'Case approved' : 'Case rejected');
  });

  router.post('/admin/verification/revoke', auth, adminOnly, async (req, res) => {
    ok(res, await revokeFn(req.auth!, parseRevokeBody(req.body)), 'Verification revoked');
  });

  return router;
}

export default createVerificationRouter();
