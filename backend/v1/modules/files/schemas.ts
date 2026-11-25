import { HttpError, badRequest } from '../../lib/http-error.js';
import { isUuid } from '../../lib/uuid.js';
import { asRecord, rejectUnknownFields } from '../../lib/validation.js';

export const BUILDING_PHOTO_CATEGORIES = ['cover', 'grounds', 'surroundings'] as const;
export type BuildingPhotoCategory = (typeof BUILDING_PHOTO_CATEGORIES)[number];

export const PHOTO_MIME_TYPES = ['image/jpeg', 'image/png'] as const;
export const EVIDENCE_MIME_TYPES = ['image/jpeg', 'image/png', 'application/pdf'] as const;
export type UploadMime = (typeof EVIDENCE_MIME_TYPES)[number];

// OQ-20 (limits) is open, so this is a default that an env var can move without a release.
export const DEFAULT_MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

export function getMaxUploadBytes(): number {
  const raw = Number(process.env.MAX_UPLOAD_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_UPLOAD_BYTES;
}

export interface ValidatedUpload {
  buffer: Buffer;
  mimeType: UploadMime;
  filename: string;
}

export interface PatchPhotoInput {
  category?: BuildingPhotoCategory;
  sortOrder?: number;
}

export interface RemovePhotoInput {
  reason: string | null;
}

/** The file type is decided by the bytes, never by the client's header or file name. */
export function sniffMime(buffer: Buffer): UploadMime | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-') {
    return 'application/pdf';
  }
  return null;
}

export function parseUuidParam(value: unknown, name: string): string {
  if (typeof value !== 'string' || !isUuid(value)) {
    throw badRequest(`Parameter "${name}" must be a valid UUID.`);
  }
  return value;
}

export function parseBuildingPhotoCategory(value: unknown): BuildingPhotoCategory {
  if (typeof value === 'string' && (BUILDING_PHOTO_CATEGORIES as readonly string[]).includes(value)) {
    return value as BuildingPhotoCategory;
  }
  throw badRequest('Query "category" must be one of: cover, grounds, surroundings.');
}

/** Display name only (never a storage path): URL-decoded, stripped of separators, 255 chars max. */
export function parseUploadFilename(header: unknown, fallback = 'upload'): string {
  if (typeof header !== 'string' || header.trim() === '') return fallback;
  let decoded = header;
  try {
    decoded = decodeURIComponent(header);
  } catch {
    // keep the raw header when it is not valid percent-encoding
  }
  const cleaned = decoded
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f/\\]/g, '')
    .trim()
    .slice(0, 255);
  return cleaned || fallback;
}

/**
 * Checks the raw request body of an upload (NFR-SEC-03): present, an allowed type, bytes that
 * match that type, and within the size limit.
 */
export function validateUpload(
  body: unknown,
  contentType: string | undefined,
  allowed: readonly UploadMime[],
  maxBytes: number,
  filename: string,
): ValidatedUpload {
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw new HttpError(
      415,
      `Send the file as the raw request body with a Content-Type of ${allowed.join(', ')}.`,
      { code: 'UNSUPPORTED_MEDIA_TYPE' },
    );
  }

  const declared = contentType?.split(';')[0]?.trim().toLowerCase();
  if (!declared || !(allowed as readonly string[]).includes(declared)) {
    throw new HttpError(415, `Unsupported file type. Allowed: ${allowed.join(', ')}.`, {
      code: 'UNSUPPORTED_MEDIA_TYPE',
    });
  }
  if (body.length > maxBytes) {
    throw new HttpError(413, `File is too large. The limit is ${maxBytes} bytes.`, {
      code: 'FILE_TOO_LARGE',
    });
  }
  if (sniffMime(body) !== declared) {
    throw new HttpError(415, 'The file content does not match its declared type.', {
      code: 'FILE_TYPE_MISMATCH',
    });
  }

  return { buffer: body, mimeType: declared as UploadMime, filename };
}

const PATCH_FIELDS = ['category', 'sortOrder'] as const;
const MAX_SORT_ORDER = 32_000;

export function parsePatchPhotoBody(raw: unknown): PatchPhotoInput {
  const obj = asRecord(raw);
  rejectUnknownFields(obj, PATCH_FIELDS);

  const patch: PatchPhotoInput = {};
  if (obj.category !== undefined) patch.category = parseBuildingPhotoCategory(obj.category);
  if (obj.sortOrder !== undefined) {
    const value = obj.sortOrder;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_SORT_ORDER) {
      throw badRequest(`Field "sortOrder" must be a whole number from 0 to ${MAX_SORT_ORDER}.`);
    }
    patch.sortOrder = value;
  }
  if (Object.keys(patch).length === 0) {
    throw badRequest('Provide "category" and/or "sortOrder".');
  }
  return patch;
}

export function parseRemovePhotoBody(raw: unknown): RemovePhotoInput {
  if (raw === undefined || raw === null) return { reason: null };
  const obj = asRecord(raw);
  rejectUnknownFields(obj, ['reason']);
  if (obj.reason === undefined || obj.reason === null) return { reason: null };
  if (typeof obj.reason !== 'string' || obj.reason.trim().length < 1 || obj.reason.trim().length > 500) {
    throw badRequest('Field "reason" must be between 1 and 500 characters.');
  }
  return { reason: obj.reason.trim() };
}
