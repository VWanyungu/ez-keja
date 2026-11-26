import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { HttpError } from './http-error.js';
import {
  assetFolder,
  createCloudinaryClient,
  getCloudinary,
  setCloudinaryClient,
  signParams,
} from './cloudinary.js';

const config = { cloudName: 'demo', apiKey: 'key123', apiSecret: 'secret456' };

afterEach(() => setCloudinaryClient(null));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('signParams', () => {
  it("matches the example in Cloudinary's signature documentation", () => {
    const signature = signParams(
      {
        eager: 'w_400,h_300,c_pad|w_260,h_200,c_crop',
        public_id: 'sample_image',
        timestamp: 1315060510,
      },
      'abcd',
    );
    expect(signature).toBe('bfd09f95f331f558cbd1320e67aa8d488770583e');
  });

  it('sorts keys, drops empty values and appends the secret', () => {
    const expected = createHash('sha1').update('a=1&b=2s3cret').digest('hex');
    expect(signParams({ b: 2, a: 1, skipped: undefined, empty: '' }, 's3cret')).toBe(expected);
  });
});

describe('createCloudinaryClient', () => {
  it('uploads a signed multipart request and maps the response', async () => {
    let seen: { url: string; form: FormData } | null = null;
    const client = createCloudinaryClient(config, (async (url: string, init: RequestInit) => {
      seen = { url, form: init.body as FormData };
      return jsonResponse({
        public_id: 'khunt/test/photos/abc',
        type: 'upload',
        format: 'jpg',
        bytes: 4,
        width: 100,
        height: 50,
      });
    }) as unknown as typeof fetch);

    const stored = await client.upload({
      publicId: 'khunt/test/photos/abc',
      resourceType: 'image',
      deliveryType: 'upload',
      buffer: Buffer.from([1, 2, 3, 4]),
      mimeType: 'image/jpeg',
      filename: 'a.jpg',
    });

    expect(stored).toMatchObject({ publicId: 'khunt/test/photos/abc', bytes: 4, width: 100, height: 50 });
    expect(seen!.url).toBe('https://api.cloudinary.com/v1_1/demo/image/upload');
    const form = seen!.form;
    expect(form.get('api_key')).toBe('key123');
    expect(form.get('type')).toBe('upload');
    expect(form.get('public_id')).toBe('khunt/test/photos/abc');
    expect(form.get('file')).toBeInstanceOf(Blob);
    // An empty filename makes Cloudinary answer "Missing required parameter - file".
    expect((form.get('file') as File).name).toBe('a.jpg');
    // The signature covers exactly the signed params, never the file or api_key.
    const timestamp = Number(form.get('timestamp'));
    expect(form.get('signature')).toBe(
      signParams({ public_id: 'khunt/test/photos/abc', type: 'upload', timestamp }, 'secret456'),
    );
  });

  it('removes the asset and fails when Cloudinary stores it with the wrong access type', async () => {
    const calls: string[] = [];
    const client = createCloudinaryClient(config, (async (url: string) => {
      calls.push(url);
      return url.endsWith('/upload')
        ? jsonResponse({ public_id: 'evidence/x', type: 'upload', bytes: 1 })
        : jsonResponse({ result: 'ok' });
    }) as unknown as typeof fetch);

    const err = await client
      .upload({
        publicId: 'evidence/x',
        resourceType: 'image',
        deliveryType: 'authenticated',
        buffer: Buffer.from([1]),
        mimeType: 'image/png',
        filename: 'id.png',
      })
      .catch((e) => e);

    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(502);
    expect(calls.some((url) => url.endsWith('/image/destroy'))).toBe(true);
  });

  it('maps Cloudinary errors and network failures to 502', async () => {
    const rejecting = createCloudinaryClient(config, (async () =>
      jsonResponse({ error: { message: 'Invalid signature' } }, 401)) as unknown as typeof fetch);
    const err = await rejecting
      .destroy({ publicId: 'x', resourceType: 'image', deliveryType: 'upload' })
      .catch((e) => e);
    expect((err as HttpError).status).toBe(502);
    expect((err as HttpError).code).toBe('STORAGE_ERROR');

    const offline = createCloudinaryClient(config, (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch);
    const offlineErr = await offline
      .destroy({ publicId: 'x', resourceType: 'image', deliveryType: 'upload' })
      .catch((e) => e);
    expect((offlineErr as HttpError).status).toBe(502);
  });

  it('treats "not found" on destroy as success so cleanup is idempotent', async () => {
    const client = createCloudinaryClient(config, (async () =>
      jsonResponse({ result: 'not found' })) as unknown as typeof fetch);
    await expect(
      client.destroy({ publicId: 'gone', resourceType: 'raw', deliveryType: 'authenticated' }),
    ).resolves.toBeUndefined();
  });

  it('builds a signed, expiring private download URL', () => {
    const client = createCloudinaryClient(config);
    const url = new URL(
      client.privateDownloadUrl(
        { publicId: 'khunt/x/evidence/1', resourceType: 'image', deliveryType: 'authenticated', format: 'jpg' },
        300,
      ),
    );
    expect(url.origin + url.pathname).toBe('https://api.cloudinary.com/v1_1/demo/image/download');
    const q = url.searchParams;
    expect(q.get('type')).toBe('authenticated');
    expect(q.get('format')).toBe('jpg');
    expect(q.get('api_key')).toBe('key123');
    expect(Number(q.get('expires_at')) - Number(q.get('timestamp'))).toBe(300);
    expect(q.get('signature')).toBe(
      signParams(
        {
          public_id: 'khunt/x/evidence/1',
          format: 'jpg',
          type: 'authenticated',
          timestamp: Number(q.get('timestamp')),
          expires_at: Number(q.get('expires_at')),
        },
        'secret456',
      ),
    );

    // Raw assets (PDFs) carry their extension in the public id, so no format parameter.
    const raw = new URL(
      client.privateDownloadUrl(
        { publicId: 'khunt/x/evidence/2.pdf', resourceType: 'raw', deliveryType: 'authenticated', format: 'pdf' },
        60,
      ),
    );
    expect(raw.searchParams.has('format')).toBe(false);
  });

  it('builds public delivery URLs with optional resizing', () => {
    const client = createCloudinaryClient(config);
    expect(client.publicUrl('khunt/x/photos/1', 320)).toBe(
      'https://res.cloudinary.com/demo/image/upload/c_limit,w_320,q_auto,f_auto/khunt/x/photos/1',
    );
    expect(client.publicUrl('khunt/x/photos/1')).toBe(
      'https://res.cloudinary.com/demo/image/upload/q_auto,f_auto/khunt/x/photos/1',
    );
  });
});

describe('getCloudinary', () => {
  it('answers 503 when credentials are not configured', () => {
    const saved = { ...process.env };
    delete process.env.CLOUDINARY_CLOUD_NAME;
    delete process.env.CLOUDINARY_API_KEY;
    delete process.env.CLOUDINARY_API_SECRET;
    try {
      let thrown: unknown;
      try {
        getCloudinary();
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(HttpError);
      expect((thrown as HttpError).status).toBe(503);
      expect((thrown as HttpError).code).toBe('STORAGE_NOT_CONFIGURED');
    } finally {
      process.env = saved;
    }
  });

  it('separates assets per environment', () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'staging';
    expect(assetFolder()).toBe('khunt/staging');
    process.env.NODE_ENV = saved;
  });
});
