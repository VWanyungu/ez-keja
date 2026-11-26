import express, { type RequestHandler, type Router } from 'express';
import { created, ok } from '../../lib/respond.js';
import { requireSession } from '../../middlewares/auth.js';
import { parseUuidParam } from '../files/schemas.js';
import { parseListEnquiriesQuery, parseMessageBody } from './schemas.js';
import { addMessage, closeEnquiry, getEnquiry, listEnquiries, startOrContinueEnquiry } from './service.js';

export interface EnquiriesRouterDeps {
  requireAuth?: RequestHandler;
  startOrContinueEnquiry?: typeof startOrContinueEnquiry;
  addMessage?: typeof addMessage;
  listEnquiries?: typeof listEnquiries;
  getEnquiry?: typeof getEnquiry;
  closeEnquiry?: typeof closeEnquiry;
}

/**
 * In-app enquiries (FR-ENQ-001, FR-ENQ-005). Every route needs a signed-in user: a Guest gets 401
 * (BR-008). Absolute paths, like the other catalogue-facing routers.
 */
export function createEnquiriesRouter(deps: EnquiriesRouterDeps = {}): Router {
  const router = express.Router();
  const auth = deps.requireAuth ?? requireSession();
  const startFn = deps.startOrContinueEnquiry ?? startOrContinueEnquiry;
  const addFn = deps.addMessage ?? addMessage;
  const listFn = deps.listEnquiries ?? listEnquiries;
  const getFn = deps.getEnquiry ?? getEnquiry;
  const closeFn = deps.closeEnquiry ?? closeEnquiry;

  router.post('/space-types/:id/enquiries', auth, async (req, res) => {
    const posted = await startFn(req.auth!, parseUuidParam(req.params.id, 'id'), parseMessageBody(req.body));
    created(res, posted, posted.newThread ? 'Enquiry started' : 'Message added to your open enquiry');
  });

  router.get('/enquiries', auth, async (req, res) => {
    ok(res, await listFn(req.auth!, parseListEnquiriesQuery(req.query)), 'Enquiries');
  });

  router.get('/enquiries/:id', auth, async (req, res) => {
    ok(res, await getFn(req.auth!, parseUuidParam(req.params.id, 'id')), 'Enquiry');
  });

  router.post('/enquiries/:id/messages', auth, async (req, res) => {
    created(res, await addFn(req.auth!, parseUuidParam(req.params.id, 'id'), parseMessageBody(req.body)), 'Message sent');
  });

  router.post('/enquiries/:id/close', auth, async (req, res) => {
    ok(res, await closeFn(req.auth!, parseUuidParam(req.params.id, 'id')), 'Enquiry closed');
  });

  return router;
}

export default createEnquiriesRouter();
