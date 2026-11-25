import { createHash } from 'node:crypto';
import { HttpError, serviceUnavailable } from './http-error.js';

export type ResourceType = 'image' | 'raw';
/** upload = public delivery, authenticated = only reachable through a signed request. */
export type DeliveryType = 'upload' | 'authenticated';

export interface AssetRef {
  publicId: string;
  resourceType: ResourceType;
  deliveryType: DeliveryType;
}

export interface StoredAsset extends AssetRef {
  format: string;
  bytes: number;
  width: number | null;
  height: number | null;
}

export interface UploadInput extends AssetRef {
  buffer: Buffer;
  mimeType: string;
  filename: string;
}

export interface CloudinaryClient {
  upload(input: UploadInput): Promise<StoredAsset>;
  /** Treats "not found" as success so cleanup is idempotent. */
  destroy(ref: AssetRef): Promise<void>;
  privateDownloadUrl(ref: AssetRef & { format: string }, ttlSeconds: number): string;
  publicUrl(publicId: string, width?: number): string;
}

export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

const API_BASE = 'https://api.cloudinary.com/v1_1';
const DELIVERY_BASE = 'https://res.cloudinary.com';
const REQUEST_TIMEOUT_MS = 30_000;

type Params = Record<string, string | number | undefined>;

/** Cloudinary signature: sha1 of the sorted "k=v&k=v" string with the API secret appended. */
export function signParams(params: Params, apiSecret: string): string {
  const toSign = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  return createHash('sha1').update(toSign + apiSecret).digest('hex');
}

function storageError(message: string, cause?: unknown): HttpError {
  return new HttpError(502, message, { expose: true, code: 'STORAGE_ERROR', cause });
}

export function createCloudinaryClient(
  config: CloudinaryConfig,
  fetchFn: typeof fetch = fetch,
): CloudinaryClient {
  const nowSeconds = () => Math.floor(Date.now() / 1000);

  async function post(resourceType: ResourceType, action: string, fields: Params, file?: Blob) {
    const signed = { ...fields, timestamp: nowSeconds() };
    const form = new FormData();
    for (const [key, value] of Object.entries(signed)) {
      if (value !== undefined) form.append(key, String(value));
    }
    form.append('api_key', config.apiKey);
    form.append('signature', signParams(signed, config.apiSecret));
    if (file) form.append('file', file);

    let res: Response;
    try {
      res = await fetchFn(`${API_BASE}/${config.cloudName}/${resourceType}/${action}`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw storageError('File storage is unreachable.', err);
    }

    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) {
      throw storageError('File storage rejected the request.', body?.error?.message);
    }
    return body;
  }

  const client: CloudinaryClient = {
    async upload(input) {
      const body = await post(
        input.resourceType,
        'upload',
        { public_id: input.publicId, type: input.deliveryType },
        new Blob([new Uint8Array(input.buffer)], { type: input.mimeType }),
      );

      // Defence in depth: a restricted file must never come back as publicly deliverable.
      if (body.type !== input.deliveryType) {
        await client.destroy(input).catch(() => undefined);
        throw storageError('File storage stored the file with the wrong access type.');
      }

      return {
        publicId: String(body.public_id),
        resourceType: input.resourceType,
        deliveryType: input.deliveryType,
        format: typeof body.format === 'string' ? body.format : '',
        bytes: Number(body.bytes),
        width: typeof body.width === 'number' ? body.width : null,
        height: typeof body.height === 'number' ? body.height : null,
      };
    },

    async destroy(ref) {
      const body = await post(ref.resourceType, 'destroy', {
        public_id: ref.publicId,
        type: ref.deliveryType,
      });
      if (body.result !== 'ok' && body.result !== 'not found') {
        throw storageError('File storage could not delete the file.');
      }
    },

    privateDownloadUrl(ref, ttlSeconds) {
      const params: Params = {
        public_id: ref.publicId,
        format: ref.resourceType === 'raw' ? undefined : ref.format,
        type: ref.deliveryType,
        timestamp: nowSeconds(),
        expires_at: nowSeconds() + ttlSeconds,
      };
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) query.set(key, String(value));
      }
      query.set('api_key', config.apiKey);
      query.set('signature', signParams(params, config.apiSecret));
      return `${API_BASE}/${config.cloudName}/${ref.resourceType}/download?${query.toString()}`;
    },

    publicUrl(publicId, width) {
      const transform = width ? `c_limit,w_${width},q_auto,f_auto` : 'q_auto,f_auto';
      return `${DELIVERY_BASE}/${config.cloudName}/image/upload/${transform}/${publicId}`;
    },
  };

  return client;
}

let client: CloudinaryClient | null = null;

/** Test seam: pass a fake, or null to fall back to the env-configured client. */
export function setCloudinaryClient(next: CloudinaryClient | null): void {
  client = next;
}

export function getCloudinary(): CloudinaryClient {
  if (client) return client;

  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    throw serviceUnavailable('File storage is not configured.', { code: 'STORAGE_NOT_CONFIGURED' });
  }
  client = createCloudinaryClient({
    cloudName: CLOUDINARY_CLOUD_NAME,
    apiKey: CLOUDINARY_API_KEY,
    apiSecret: CLOUDINARY_API_SECRET,
  });
  return client;
}

/** Keeps dev, staging and production assets apart inside one Cloudinary account. */
export function assetFolder(): string {
  return `khunt/${process.env.NODE_ENV ?? 'development'}`;
}
