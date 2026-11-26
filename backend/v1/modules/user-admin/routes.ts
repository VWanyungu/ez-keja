import express, { type RequestHandler, type Router } from 'express';
import { ok } from '../../lib/respond.js';
import { requireRole, requireSession } from '../../middlewares/auth.js';
import { parseUuidParam } from '../files/schemas.js';
import { parseGrantRoleBody, parseRole, parseUserListQuery } from './schemas.js';
import { getUser, grantRole, listUsers, revokeRole } from './service.js';

export interface UserAdminRouterDeps {
  requireAuth?: RequestHandler;
  requireAdmin?: RequestHandler;
  listUsers?: typeof listUsers;
  getUser?: typeof getUser;
  grantRole?: typeof grantRole;
  revokeRole?: typeof revokeRole;
}

/** User administration (FR-ADM-003, FR-ADM-006, NFR-AUD-01): absolute paths under `/admin/users`. */
export function createUserAdminRouter(deps: UserAdminRouterDeps = {}): Router {
  const router = express.Router();
  const auth = deps.requireAuth ?? requireSession();
  const adminOnly = deps.requireAdmin ?? requireRole('admin');
  const listFn = deps.listUsers ?? listUsers;
  const getFn = deps.getUser ?? getUser;
  const grantFn = deps.grantRole ?? grantRole;
  const revokeFn = deps.revokeRole ?? revokeRole;

  router.get('/admin/users', auth, adminOnly, async (req, res) => {
    ok(res, await listFn(req.auth!, parseUserListQuery(req.query)), 'Users');
  });

  router.get('/admin/users/:id', auth, adminOnly, async (req, res) => {
    ok(res, await getFn(req.auth!, parseUuidParam(req.params.id, 'id')), 'User');
  });

  router.post('/admin/users/:id/roles', auth, adminOnly, async (req, res) => {
    const id = parseUuidParam(req.params.id, 'id');
    const { role } = parseGrantRoleBody(req.body);
    ok(res, await grantFn(req.auth!, id, role), 'Role granted');
  });

  router.delete('/admin/users/:id/roles/:role', auth, adminOnly, async (req, res) => {
    const id = parseUuidParam(req.params.id, 'id');
    ok(res, await revokeFn(req.auth!, id, parseRole(req.params.role)), 'Role revoked');
  });

  return router;
}

export default createUserAdminRouter();
