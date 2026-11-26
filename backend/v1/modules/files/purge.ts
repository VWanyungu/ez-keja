import type { Knex } from 'knex';
import db from '../../db/knex.js';
import {
  getCloudinary,
  type CloudinaryClient,
  type DeliveryType,
  type ResourceType,
} from '../../lib/cloudinary.js';

/** TX-12: an upload whose database row never got a photo or evidence reference is an orphan. */
export const ORPHAN_AFTER_HOURS = 24;
// shortcut: a fixed window for removed photos (design §12.1 says "purged later"); move it to a
// setting if Admin needs to tune it.
export const REMOVED_PHOTO_PURGE_DAYS = 30;
const BATCH_SIZE = 100;

export interface PurgeResult {
  /** Files an erasure asked to be deleted (design §10.6 step 6): asset destroyed, then `purged_at` set. */
  erasedFilesPurged: number;
  orphansDeleted: number;
  removedPhotosPurged: number;
  failures: number;
}

interface FileRow {
  id: string;
  public_id: string;
  resource_type: ResourceType;
  delivery_type: DeliveryType;
}

export interface PurgeOptions {
  client?: CloudinaryClient;
  conn?: Knex;
  now?: Date;
}

const FILE_COLUMNS = ['f.id', 'f.public_id', 'f.resource_type', 'f.delivery_type'] as const;

/**
 * Removes Cloudinary assets that nothing needs any more. Safe to run twice or on two PM2
 * instances: Cloudinary "not found" counts as success, and each database step re-checks its row.
 * Run it from a cron/PM2 job (jobs/purge-files.ts), never from a request handler.
 */
export async function purgeFiles(options: PurgeOptions = {}): Promise<PurgeResult> {
  const conn = options.conn ?? db;
  const storage = options.client ?? getCloudinary();
  const now = options.now ?? new Date();
  const result: PurgeResult = { erasedFilesPurged: 0, orphansDeleted: 0, removedPhotosPurged: 0, failures: 0 };

  // Erasure (TX-10) only sets `purge_requested_at` and blanks the name; the object is destroyed here
  // and `purged_at` is set once Cloudinary has answered. Runs first so an erased profile photo
  // (now unreferenced) is marked purged instead of being picked up as an orphan and deleted.
  const requested = (await conn('files as f')
    .whereNotNull('f.purge_requested_at')
    .whereNull('f.purged_at')
    .select(...FILE_COLUMNS)
    .limit(BATCH_SIZE)) as FileRow[];

  for (const file of requested) {
    try {
      await storage.destroy({
        publicId: file.public_id,
        resourceType: file.resource_type,
        deliveryType: file.delivery_type,
      });
      await conn('files').where({ id: file.id }).update({ purged_at: now, original_name: '' });
      result.erasedFilesPurged += 1;
    } catch (err) {
      result.failures += 1;
      console.error(`purge-files: erased user's file ${file.id} failed`, err);
    }
  }

  const orphanCutoff = new Date(now.getTime() - ORPHAN_AFTER_HOURS * 3_600_000);
  const orphans = (await conn('files as f')
    .whereNull('f.purged_at')
    .whereNull('f.purge_requested_at')
    .where('f.created_at', '<', orphanCutoff)
    .whereRaw('NOT EXISTS (SELECT 1 FROM photos x WHERE x.file_id = f.id)')
    .whereRaw('NOT EXISTS (SELECT 1 FROM verification_evidence x WHERE x.file_id = f.id)')
    .whereRaw('NOT EXISTS (SELECT 1 FROM profiles x WHERE x.photo_file_id = f.id)')
    .whereRaw('NOT EXISTS (SELECT 1 FROM ad_campaigns x WHERE x.image_file_id = f.id)')
    .select(...FILE_COLUMNS)
    .limit(BATCH_SIZE)) as FileRow[];

  for (const file of orphans) {
    try {
      await storage.destroy({
        publicId: file.public_id,
        resourceType: file.resource_type,
        deliveryType: file.delivery_type,
      });
      await conn('files').where({ id: file.id }).del();
      result.orphansDeleted += 1;
    } catch (err) {
      result.failures += 1;
      console.error(`purge-files: orphan ${file.id} failed`, err);
    }
  }

  const photoCutoff = new Date(now.getTime() - REMOVED_PHOTO_PURGE_DAYS * 86_400_000);
  const removed = (await conn('files as f')
    .join('photos as p', 'p.file_id', 'f.id')
    .whereNull('f.purged_at')
    .where('p.removed_at', '<', photoCutoff)
    .select(...FILE_COLUMNS)
    .limit(BATCH_SIZE)) as FileRow[];

  for (const file of removed) {
    try {
      await storage.destroy({
        publicId: file.public_id,
        resourceType: file.resource_type,
        deliveryType: file.delivery_type,
      });
      // The row stays (the photo still references it); the name is blanked as personal data.
      await conn('files').where({ id: file.id }).update({ purged_at: now, original_name: '' });
      result.removedPhotosPurged += 1;
    } catch (err) {
      result.failures += 1;
      console.error(`purge-files: removed photo file ${file.id} failed`, err);
    }
  }

  return result;
}
