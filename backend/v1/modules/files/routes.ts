import express, { type RequestHandler, type Router } from 'express';
import { created, ok } from '../../lib/respond.js';
import { requireRole, requireSession } from '../../middlewares/auth.js';
import {
  EVIDENCE_MIME_TYPES,
  PHOTO_MIME_TYPES,
  getMaxUploadBytes,
  parseBuildingPhotoCategory,
  parsePatchPhotoBody,
  parseRemovePhotoBody,
  parseUploadFilename,
  parseUuidParam,
  validateUpload,
} from './schemas.js';
import {
  getFileDownload,
  listPhotos,
  removePhoto,
  updatePhoto,
  uploadEvidence,
  uploadPhoto,
} from './service.js';

export interface FilesRouterDeps {
  requireAuth?: RequestHandler;
  requireAdmin?: RequestHandler;
  requireEvidenceUploader?: RequestHandler;
  maxUploadBytes?: number;
  uploadPhoto?: typeof uploadPhoto;
  listPhotos?: typeof listPhotos;
  updatePhoto?: typeof updatePhoto;
  removePhoto?: typeof removePhoto;
  uploadEvidence?: typeof uploadEvidence;
  getFileDownload?: typeof getFileDownload;
}

/**
 * Photos and files. Uploads are the raw request body (one file per request) with the type in
 * Content-Type, so no multipart parser is needed; the display name goes in `x-file-name`.
 * Auth runs before the body parser so an anonymous caller never makes us buffer a file.
 */
export function createFilesRouter(deps: FilesRouterDeps = {}): Router {
  const router = express.Router();
  const auth = deps.requireAuth ?? requireSession();
  const adminOnly = deps.requireAdmin ?? requireRole('admin');
  const evidenceUploaders = deps.requireEvidenceUploader ?? requireRole('landlord', 'agent', 'admin');
  const maxBytes = deps.maxUploadBytes ?? getMaxUploadBytes();

  const uploadPhotoFn = deps.uploadPhoto ?? uploadPhoto;
  const listPhotosFn = deps.listPhotos ?? listPhotos;
  const updatePhotoFn = deps.updatePhoto ?? updatePhoto;
  const removePhotoFn = deps.removePhoto ?? removePhoto;
  const uploadEvidenceFn = deps.uploadEvidence ?? uploadEvidence;
  const downloadFn = deps.getFileDownload ?? getFileDownload;

  const photoBody = express.raw({ type: [...PHOTO_MIME_TYPES], limit: maxBytes });
  const evidenceBody = express.raw({ type: [...EVIDENCE_MIME_TYPES], limit: maxBytes });

  router.post('/buildings/:buildingId/photos', auth, photoBody, async (req, res) => {
    const buildingId = parseUuidParam(req.params.buildingId, 'buildingId');
    const category = parseBuildingPhotoCategory(req.query.category);
    const file = validateUpload(
      req.body,
      req.headers['content-type'],
      PHOTO_MIME_TYPES,
      maxBytes,
      parseUploadFilename(req.headers['x-file-name'], 'photo'),
    );
    created(res, await uploadPhotoFn(req.auth!, { buildingId, category }, file), 'Photo uploaded');
  });

  router.post('/space-types/:spaceTypeId/photos', auth, photoBody, async (req, res) => {
    const spaceTypeId = parseUuidParam(req.params.spaceTypeId, 'spaceTypeId');
    const file = validateUpload(
      req.body,
      req.headers['content-type'],
      PHOTO_MIME_TYPES,
      maxBytes,
      parseUploadFilename(req.headers['x-file-name'], 'photo'),
    );
    created(
      res,
      await uploadPhotoFn(req.auth!, { spaceTypeId, category: 'space_type' }, file),
      'Photo uploaded',
    );
  });

  router.get('/buildings/:buildingId/photos', auth, async (req, res) => {
    const buildingId = parseUuidParam(req.params.buildingId, 'buildingId');
    ok(res, await listPhotosFn(req.auth!, { buildingId }), 'Building photos');
  });

  router.get('/space-types/:spaceTypeId/photos', auth, async (req, res) => {
    const spaceTypeId = parseUuidParam(req.params.spaceTypeId, 'spaceTypeId');
    ok(res, await listPhotosFn(req.auth!, { spaceTypeId }), 'Space type photos');
  });

  router.patch('/photos/:photoId', auth, async (req, res) => {
    const photoId = parseUuidParam(req.params.photoId, 'photoId');
    const patch = parsePatchPhotoBody(req.body);
    ok(res, await updatePhotoFn(req.auth!, photoId, patch), 'Photo updated');
  });

  router.delete('/photos/:photoId', auth, async (req, res) => {
    const photoId = parseUuidParam(req.params.photoId, 'photoId');
    const { reason } = parseRemovePhotoBody(req.body);
    ok(res, await removePhotoFn(req.auth!, photoId, reason), 'Photo removed');
  });

  router.post('/files/evidence', auth, evidenceUploaders, evidenceBody, async (req, res) => {
    const file = validateUpload(
      req.body,
      req.headers['content-type'],
      EVIDENCE_MIME_TYPES,
      maxBytes,
      parseUploadFilename(req.headers['x-file-name'], 'evidence'),
    );
    created(res, await uploadEvidenceFn(req.auth!, file), 'Evidence uploaded');
  });

  router.get('/files/:fileId/download', auth, adminOnly, async (req, res) => {
    const fileId = parseUuidParam(req.params.fileId, 'fileId');
    ok(res, await downloadFn(req.auth!, fileId), 'File download link');
  });

  return router;
}

export default createFilesRouter();
