import express, { type RequestHandler, type Router } from 'express';
import { created, ok } from '../../lib/respond.js';
import { requireRole, requireSession } from '../../middlewares/auth.js';
import {
  createAdminReferenceRouter,
  type AdminReferenceRouterDeps,
} from '../reference/routes.js';
import {
  parseCreateAdminInviteBody,
  parseInviteIdParam,
  type CreateAdminInviteInput,
} from './schemas.js';
import {
  createAdminInvite,
  listAdminInvites,
  revokeAdminInvite,
  type AdminInviteSummary,
  type CreatedAdminInviteResult,
} from './service.js';

export interface AdminRouterDeps {
  requireAuth?: RequestHandler;
  requireAdmin?: RequestHandler;
  createAdminInvite?: (
    adminUserId: string,
    input: CreateAdminInviteInput,
  ) => Promise<CreatedAdminInviteResult>;
  listAdminInvites?: () => Promise<AdminInviteSummary[]>;
  revokeAdminInvite?: (adminUserId: string, inviteId: string) => Promise<AdminInviteSummary>;
  reference?: AdminReferenceRouterDeps;
}

export function createAdminRouter(deps: AdminRouterDeps = {}): Router {
  const router = express.Router();
  const authMiddleware = deps.requireAuth ?? requireSession();
  const adminRoleMiddleware = deps.requireAdmin ?? requireRole('admin');
  const createInviteFn = deps.createAdminInvite ?? createAdminInvite;
  const listInvitesFn = deps.listAdminInvites ?? listAdminInvites;
  const revokeInviteFn = deps.revokeAdminInvite ?? revokeAdminInvite;

  router.use(authMiddleware, adminRoleMiddleware);

  router.post('/invites', async (req, res) => {
    const input = parseCreateAdminInviteBody(req.body);
    const result = await createInviteFn(req.auth!.user.id, input);
    created(res, result, 'Admin invite created');
  });

  router.get('/invites', async (_req, res) => {
    const invites = await listInvitesFn();
    ok(res, invites, 'Admin invites');
  });

  router.post('/invites/:id/revoke', async (req, res) => {
    const inviteId = parseInviteIdParam(req.params.id);
    const invite = await revokeInviteFn(req.auth!.user.id, inviteId);
    ok(res, invite, 'Admin invite revoked');
  });

  router.use(createAdminReferenceRouter(deps.reference));

  return router;
}

export default createAdminRouter();
