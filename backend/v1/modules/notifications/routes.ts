import express, { type RequestHandler, type Router } from 'express';
import { ok } from '../../lib/respond.js';
import { requireSession } from '../../middlewares/auth.js';
import { parseUuidParam } from '../files/schemas.js';
import { parseListNotificationsQuery } from './schemas.js';
import { listNotifications, markAllRead, markRead, unreadCount } from './service.js';

export interface NotificationsRouterDeps {
  requireAuth?: RequestHandler;
  listNotifications?: typeof listNotifications;
  unreadCount?: typeof unreadCount;
  markRead?: typeof markRead;
  markAllRead?: typeof markAllRead;
}

/** The in-app notification list (FR-NTF-001). Any signed-in user, and only ever their own rows. */
export function createNotificationsRouter(deps: NotificationsRouterDeps = {}): Router {
  const router = express.Router();
  const auth = deps.requireAuth ?? requireSession();
  const listFn = deps.listNotifications ?? listNotifications;
  const countFn = deps.unreadCount ?? unreadCount;
  const readFn = deps.markRead ?? markRead;
  const readAllFn = deps.markAllRead ?? markAllRead;

  router.get('/notifications', auth, async (req, res) => {
    ok(res, await listFn(req.auth!, parseListNotificationsQuery(req.query)), 'Notifications');
  });

  router.get('/notifications/unread-count', auth, async (req, res) => {
    ok(res, await countFn(req.auth!), 'Unread notifications');
  });

  router.post('/notifications/read-all', auth, async (req, res) => {
    ok(res, await readAllFn(req.auth!), 'Notifications marked read');
  });

  router.post('/notifications/:id/read', auth, async (req, res) => {
    ok(res, await readFn(req.auth!, parseUuidParam(req.params.id, 'id')), 'Notification marked read');
  });

  return router;
}

export default createNotificationsRouter();
