import type { Knex } from 'knex';
import db from '../../db/knex.js';
import { writeAudit } from '../../lib/audit.js';
import {
  assetFolder,
  getCloudinary,
  type DeliveryType,
  type ResourceType,
  type StoredAsset,
} from '../../lib/cloudinary.js';
import { conflict, forbidden, HttpError, notFound } from '../../lib/http-error.js';
import { isPublishedLike, loadBuildingAccess, type BuildingAccess } from '../../lib/maintainer.js';
import { EVENT_MODERATION, notifyEach } from '../../lib/notify.js';
import { generateUuidV7 } from '../../lib/uuid.js';
import type { AuthContext } from '../../middlewares/auth.js';
import type {
  BuildingPhotoCategory,
  PatchPhotoInput,
  UploadMime,
  ValidatedUpload,
} from './schemas.js';

const FORMAT_BY_MIME: Record<UploadMime, 'jpg' | 'png' | 'pdf'> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/pdf': 'pdf',
};

const MAX_SMALLINT = 32_767;
const DOWNLOAD_URL_TTL_SECONDS = 300;

export type PhotoCategory = BuildingPhotoCategory | 'space_type';

export interface PhotoTarget {
  buildingId?: string;
  spaceTypeId?: string;
  category: PhotoCategory;
}

export interface PhotoItem {
  id: string;
  buildingId: string | null;
  spaceTypeId: string | null;
  category: PhotoCategory;
  sortOrder: number;
  createdAt: Date;
  file: {
    id: string;
    mimeType: string;
    sizeBytes: number;
    widthPx: number | null;
    heightPx: number | null;
  };
  urls: { thumb: string; medium: string; full: string };
}

export interface EvidenceFileItem {
  id: string;
  mimeType: string;
  sizeBytes: number;
  originalName: string;
  createdAt: Date;
}

export interface FileDownload {
  url: string;
  expiresAt: Date | null;
}

interface PhotoRow {
  id: string;
  building_id: string | null;
  space_type_id: string | null;
  category: PhotoCategory;
  sort_order: number;
  created_at: Date;
  file_id: string;
  mime_type: string;
  size_bytes: string | number;
  width_px: number | null;
  height_px: number | null;
  public_id: string;
}

interface LockedBuilding {
  id: string;
  status: string;
  status_before_suspension: string | null;
}

type Conn = Knex | Knex.Transaction;

const PHOTO_COLUMNS = [
  'p.id',
  'p.building_id',
  'p.space_type_id',
  'p.category',
  'p.sort_order',
  'p.created_at',
  'f.id as file_id',
  'f.mime_type',
  'f.size_bytes',
  'f.width_px',
  'f.height_px',
  'f.public_id',
] as const;

function toPhotoItem(row: PhotoRow): PhotoItem {
  const storage = getCloudinary();
  return {
    id: row.id,
    buildingId: row.building_id,
    spaceTypeId: row.space_type_id,
    category: row.category,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    file: {
      id: row.file_id,
      mimeType: row.mime_type,
      sizeBytes: Number(row.size_bytes),
      widthPx: row.width_px,
      heightPx: row.height_px,
    },
    urls: {
      thumb: storage.publicUrl(row.public_id, 320),
      medium: storage.publicUrl(row.public_id, 800),
      full: storage.publicUrl(row.public_id),
    },
  };
}

async function loadPhoto(conn: Conn, photoId: string): Promise<PhotoItem> {
  const row = (await conn('photos as p')
    .join('files as f', 'f.id', 'p.file_id')
    .where('p.id', photoId)
    .first(...PHOTO_COLUMNS)) as PhotoRow | undefined;
  if (!row) throw notFound('Photo not found.', { code: 'PHOTO_NOT_FOUND' });
  return toPhotoItem(row);
}

async function buildingOfSpaceType(
  conn: Conn,
  spaceTypeId: string,
  includeRemoved = false,
): Promise<string> {
  const qb = conn('space_types').where({ id: spaceTypeId });
  if (!includeRemoved) qb.whereNull('removed_at');
  const row = (await qb.first('building_id')) as { building_id: string } | undefined;
  if (!row) throw notFound('Space type not found.', { code: 'SPACE_TYPE_NOT_FOUND' });
  return row.building_id;
}

/** Lock order (design §9.3): the building row first, then anything under it. */
async function lockBuilding(trx: Knex.Transaction, buildingId: string): Promise<LockedBuilding> {
  const row = (await trx('buildings')
    .where({ id: buildingId })
    .forUpdate()
    .first('id', 'status', 'status_before_suspension')) as LockedBuilding | undefined;
  if (!row) throw notFound('Building not found.', { code: 'BUILDING_NOT_FOUND' });
  return row;
}

function assertAcceptsPhotos(status: string): void {
  if (status === 'withdrawn') {
    throw conflict('This building is withdrawn. Reopen it before changing its photos.', {
      code: 'BUILDING_WITHDRAWN',
    });
  }
}

async function insertFile(
  trx: Knex.Transaction,
  params: {
    fileId: string;
    uploadedBy: string;
    upload: ValidatedUpload;
    stored: StoredAsset;
    visibility: 'public' | 'restricted';
  },
): Promise<void> {
  await trx('files').insert({
    id: params.fileId,
    public_id: params.stored.publicId,
    resource_type: params.stored.resourceType,
    delivery_type: params.stored.deliveryType,
    format: FORMAT_BY_MIME[params.upload.mimeType],
    original_name: params.upload.filename,
    mime_type: params.upload.mimeType,
    size_bytes: params.upload.buffer.length,
    width_px: params.stored.width,
    height_px: params.stored.height,
    visibility: params.visibility,
    uploaded_by: params.uploadedBy,
  });
}

/** TX-12: the upload happens first; if the database write fails the asset is removed again. */
async function uploadThenRecord<T>(
  asset: { publicId: string; resourceType: ResourceType; deliveryType: DeliveryType },
  upload: ValidatedUpload,
  record: (stored: StoredAsset) => Promise<T>,
): Promise<T> {
  const storage = getCloudinary();
  const stored = await storage.upload({ ...asset, buffer: upload.buffer, mimeType: upload.mimeType, filename: upload.filename });
  try {
    return await record(stored);
  } catch (err) {
    await storage
      .destroy(stored)
      .catch((cleanupErr) => console.error('Could not remove orphaned upload', cleanupErr));
    throw err;
  }
}

function mapPhotoDbError(err: unknown): unknown {
  const pg = err as { code?: string; constraint?: string };
  if (pg?.code === '23505' && pg.constraint === 'ux_photos_one_cover') {
    return conflict('This building already has a cover photo. Change the cover with PATCH /photos/:id.', {
      code: 'COVER_EXISTS',
    });
  }
  return err;
}

async function nextSortOrder(trx: Knex.Transaction, target: PhotoTarget): Promise<number> {
  const qb = trx('photos').whereNull('removed_at');
  if (target.spaceTypeId) qb.where({ space_type_id: target.spaceTypeId });
  else qb.where({ building_id: target.buildingId, category: target.category });
  const row = (await qb.max('sort_order as max').first()) as { max: number | null } | undefined;
  return Math.min((row?.max ?? 0) + 1, MAX_SMALLINT);
}

export async function uploadPhoto(
  auth: AuthContext,
  target: PhotoTarget,
  upload: ValidatedUpload,
): Promise<PhotoItem> {
  const buildingId = target.buildingId ?? (await buildingOfSpaceType(db, target.spaceTypeId!));
  const access = await loadBuildingAccess(auth, buildingId);
  assertAcceptsPhotos(access.status);

  const fileId = generateUuidV7();
  try {
    const photoId = await uploadThenRecord(
      {
        publicId: `${assetFolder()}/photos/${fileId}`,
        resourceType: 'image',
        deliveryType: 'upload',
      },
      upload,
      (stored) =>
        db.transaction(async (trx) => {
          const building = await lockBuilding(trx, buildingId);
          assertAcceptsPhotos(building.status);

          await insertFile(trx, { fileId, uploadedBy: auth.user.id, upload, stored, visibility: 'public' });
          const [photo] = (await trx('photos')
            .insert({
              id: generateUuidV7(),
              building_id: target.buildingId ?? null,
              space_type_id: target.spaceTypeId ?? null,
              category: target.category,
              file_id: fileId,
              sort_order: await nextSortOrder(trx, target),
              uploaded_by: auth.user.id,
            })
            .returning('id')) as { id: string }[];

          await writeAudit(trx, {
            actorUserId: auth.user.id,
            actorType: access.actsAsStaff ? 'staff' : 'user',
            action: 'photo.add',
            objectType: 'photo',
            objectId: photo!.id,
            buildingId,
            changes: { category: target.category, spaceTypeId: target.spaceTypeId ?? null, fileId },
          });
          return photo!.id;
        }),
    );
    return await loadPhoto(db, photoId);
  } catch (err) {
    throw mapPhotoDbError(err);
  }
}

export async function listPhotos(
  auth: AuthContext,
  scope: { buildingId: string } | { spaceTypeId: string },
): Promise<PhotoItem[]> {
  const buildingId =
    'buildingId' in scope ? scope.buildingId : await buildingOfSpaceType(db, scope.spaceTypeId);
  await loadBuildingAccess(auth, buildingId);

  const qb = db('photos as p')
    .join('files as f', 'f.id', 'p.file_id')
    .whereNull('p.removed_at')
    .select(...PHOTO_COLUMNS);
  if ('buildingId' in scope) qb.where('p.building_id', scope.buildingId);
  else qb.where('p.space_type_id', scope.spaceTypeId);

  const rows = (await qb
    .orderByRaw("CASE p.category WHEN 'cover' THEN 0 ELSE 1 END")
    .orderBy('p.sort_order')
    .orderBy('p.created_at')) as PhotoRow[];
  return rows.map(toPhotoItem);
}

const normaliseBlocker = (blocker: string): string => blocker.replace(/\s*\(has \d+\)/, '');

async function publishBlockers(trx: Knex.Transaction, buildingId: string): Promise<string[]> {
  const result = await trx.raw('SELECT building_publish_blockers(?::uuid) AS blockers', [buildingId]);
  return ((result.rows[0]?.blockers as string[] | null) ?? []).map(normaliseBlocker);
}

/**
 * FR-MED-004 / TX-13: a maintainer may not take a published building below the BR-018 minimums.
 * Only blockers the change introduces count, so an unrelated one (say, an unverified lister) does
 * not freeze every photo edit. Admin moderation acting on behalf of maintainers is exempt.
 */
async function guardPublishingMinimums(
  trx: Knex.Transaction,
  access: BuildingAccess,
  building: LockedBuilding,
  mutate: () => Promise<void>,
): Promise<void> {
  const guarded = access.isMaintainer && isPublishedLike({
    status: building.status,
    statusBeforeSuspension: building.status_before_suspension,
  });
  if (!guarded) {
    await mutate();
    return;
  }

  const before = new Set(await publishBlockers(trx, access.buildingId));
  await mutate();
  const introduced = (await publishBlockers(trx, access.buildingId)).filter((b) => !before.has(b));
  if (introduced.length > 0) {
    throw conflict(
      `This change would leave the building below the publishing minimums: ${introduced.join('; ')}.`,
      { code: 'PHOTO_MINIMUM', data: { blockers: introduced } },
    );
  }
}

async function withLockedPhoto<T>(
  auth: AuthContext,
  photoId: string,
  fn: (ctx: {
    trx: Knex.Transaction;
    photo: { id: string; building_id: string | null; space_type_id: string | null; category: PhotoCategory; uploaded_by: string };
    building: LockedBuilding;
    access: BuildingAccess;
  }) => Promise<T>,
): Promise<T> {
  return db.transaction(async (trx) => {
    const found = (await trx('photos').where({ id: photoId }).whereNull('removed_at').first('id', 'building_id', 'space_type_id')) as
      | { id: string; building_id: string | null; space_type_id: string | null }
      | undefined;
    if (!found) throw notFound('Photo not found.', { code: 'PHOTO_NOT_FOUND' });

    const buildingId = found.building_id ?? (await buildingOfSpaceType(trx, found.space_type_id!, true));
    const building = await lockBuilding(trx, buildingId);
    const access = await loadBuildingAccess(auth, buildingId, trx);

    // Re-read under the lock: another request may have removed it while we waited.
    const photo = (await trx('photos')
      .where({ id: photoId })
      .whereNull('removed_at')
      .forUpdate()
      .first('id', 'building_id', 'space_type_id', 'category', 'uploaded_by')) as
      | { id: string; building_id: string | null; space_type_id: string | null; category: PhotoCategory; uploaded_by: string }
      | undefined;
    if (!photo) throw notFound('Photo not found.', { code: 'PHOTO_NOT_FOUND' });

    return fn({ trx, photo, building, access });
  });
}

export async function updatePhoto(
  auth: AuthContext,
  photoId: string,
  patch: PatchPhotoInput,
): Promise<PhotoItem> {
  try {
    await withLockedPhoto(auth, photoId, async ({ trx, photo, building, access }) => {
      assertAcceptsPhotos(building.status);
      if (patch.category !== undefined && photo.space_type_id !== null) {
        throw new HttpError(400, 'Space type photos have no category to change.', {
          code: 'CATEGORY_NOT_APPLICABLE',
        });
      }

      const updates: Record<string, unknown> = {};
      const changes: Record<string, unknown> = {};
      if (patch.category !== undefined && patch.category !== photo.category) {
        updates.category = patch.category;
        changes.category = { from: photo.category, to: patch.category };
      }
      if (patch.sortOrder !== undefined) {
        updates.sort_order = patch.sortOrder;
        changes.sortOrder = patch.sortOrder;
      }
      if (Object.keys(updates).length === 0) return;

      await guardPublishingMinimums(trx, access, building, async () => {
        // One cover per building: the old cover steps down to "grounds" before the new one is set.
        if (updates.category === 'cover') {
          await trx('photos')
            .where({ building_id: photo.building_id, category: 'cover' })
            .whereNull('removed_at')
            .whereNot({ id: photo.id })
            .update({ category: 'grounds' });
        }
        await trx('photos').where({ id: photo.id }).update(updates);
      });

      await writeAudit(trx, {
        actorUserId: auth.user.id,
        actorType: access.actsAsStaff ? 'staff' : 'user',
        action: 'photo.update',
        objectType: 'photo',
        objectId: photo.id,
        buildingId: access.buildingId,
        changes,
      });
    });
    return await loadPhoto(db, photoId);
  } catch (err) {
    throw mapPhotoDbError(err);
  }
}

export async function removePhoto(
  auth: AuthContext,
  photoId: string,
  reason: string | null,
): Promise<{ id: string; removedAt: Date }> {
  return withLockedPhoto(auth, photoId, async ({ trx, photo, building, access }) => {
    assertAcceptsPhotos(building.status);
    if (access.actsAsStaff && !reason) {
      throw forbidden('A reason is required when an Admin removes a photo (FR-ADM-003).', {
        code: 'REASON_REQUIRED',
      });
    }

    const removedAt = new Date();
    await guardPublishingMinimums(trx, access, building, async () => {
      await trx('photos')
        .where({ id: photo.id })
        .update({ removed_at: removedAt, removed_by: auth.user.id, removal_reason: reason });
    });

    await writeAudit(trx, {
      actorUserId: auth.user.id,
      actorType: access.actsAsStaff ? 'staff' : 'user',
      action: 'photo.remove',
      objectType: 'photo',
      objectId: photo.id,
      buildingId: access.buildingId,
      changes: { category: photo.category, reason },
    });
    if (access.actsAsStaff) {
      // N-10 (FR-ADM-003): the uploader is told when an Admin removes their photo, with the reason.
      const { name } = (await trx('buildings').where({ id: access.buildingId }).first('name')) as { name: string };
      await notifyEach(trx, [photo.uploaded_by], EVENT_MODERATION, {
        subject: 'photo', action: 'removed', buildingId: access.buildingId, buildingName: name, category: photo.category, reason,
      });
    }
    return { id: photo.id, removedAt };
  });
}

/** Verification evidence (FR-VER-001/003): stored privately; only the Admin download path can read it. */
export async function uploadEvidence(
  auth: AuthContext,
  upload: ValidatedUpload,
): Promise<EvidenceFileItem> {
  const fileId = generateUuidV7();
  const isPdf = upload.mimeType === 'application/pdf';

  const createdAt = await uploadThenRecord(
    {
      // Raw assets keep their extension in the public id; images do not.
      publicId: `${assetFolder()}/evidence/${fileId}${isPdf ? '.pdf' : ''}`,
      resourceType: isPdf ? 'raw' : 'image',
      deliveryType: 'authenticated',
    },
    upload,
    (stored) =>
      db.transaction(async (trx) => {
        await insertFile(trx, { fileId, uploadedBy: auth.user.id, upload, stored, visibility: 'restricted' });
        const row = (await trx('files').where({ id: fileId }).first('created_at')) as { created_at: Date };
        return row.created_at;
      }),
  );

  return {
    id: fileId,
    mimeType: upload.mimeType,
    sizeBytes: upload.buffer.length,
    originalName: upload.filename,
    createdAt,
  };
}

/** Admin-only. Restricted files get a short-lived signed URL, and every read is audited (pii.view). */
export async function getFileDownload(auth: AuthContext, fileId: string): Promise<FileDownload> {
  const file = (await db('files')
    .where({ id: fileId })
    .first('id', 'public_id', 'resource_type', 'delivery_type', 'format', 'visibility', 'purged_at')) as
    | {
        id: string;
        public_id: string;
        resource_type: ResourceType;
        delivery_type: DeliveryType;
        format: string;
        visibility: 'public' | 'restricted';
        purged_at: Date | null;
      }
    | undefined;
  if (!file) throw notFound('File not found.', { code: 'FILE_NOT_FOUND' });
  if (file.purged_at) {
    throw new HttpError(410, 'This file has been deleted.', { code: 'FILE_PURGED' });
  }

  const storage = getCloudinary();
  if (file.visibility === 'public') {
    return { url: storage.publicUrl(file.public_id), expiresAt: null };
  }

  await writeAudit(db, {
    actorUserId: auth.user.id,
    actorType: 'staff',
    action: 'pii.view',
    objectType: 'file',
    objectId: file.id,
    changes: { visibility: file.visibility },
  });
  return {
    url: storage.privateDownloadUrl(
      {
        publicId: file.public_id,
        resourceType: file.resource_type,
        deliveryType: file.delivery_type,
        format: file.format,
      },
      DOWNLOAD_URL_TTL_SECONDS,
    ),
    expiresAt: new Date(Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000),
  };
}
