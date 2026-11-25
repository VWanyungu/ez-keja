import { afterEach, describe, expect, it } from 'bun:test';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import type { Server } from 'node:http';
import { HttpError } from '../../lib/http-error.js';
import type { AuthContext } from '../../middlewares/auth.js';
import { JPEG_BYTES, PDF_BYTES, PNG_BYTES } from './fake-cloudinary.js';
import { createFilesRouter, type FilesRouterDeps } from './routes.js';
import {
  parsePatchPhotoBody,
  parseRemovePhotoBody,
  parseUploadFilename,
  sniffMime,
  validateUpload,
} from './schemas.js';

const BUILDING_ID = '019363c8-1234-7000-8000-0000000000b1';
const SPACE_TYPE_ID = '019363c8-1234-7000-8000-0000000000c1';
const PHOTO_ID = '019363c8-1234-7000-8000-0000000000d1';
const FILE_ID = '019363c8-1234-7000-8000-0000000000e1';

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const status = typeof err?.status === 'number' ? err.status : 500;
  const expose = Boolean(err?.expose);
  res.status(status).json({
    status: 'error',
    data: null,
    message: expose ? err.message : 'Internal server error',
    ...(expose && err?.code ? { code: err.code } : {}),
  });
};

let activeServer: Server | null = null;

afterEach(async () => {
  if (activeServer) {
    await new Promise<void>((resolve, reject) => {
      activeServer!.close((err) => (err ? reject(err) : resolve()));
    });
    activeServer = null;
  }
});

function fakeAuth(roles: AuthContext['roles'] = ['landlord']): AuthContext {
  const now = new Date('2026-11-25T12:00:00Z');
  return {
    user: { id: '019363c8-1234-7000-8000-000000000001', email: 'a@example.com', name: 'A', emailVerified: false, image: null },
    session: { id: '019363c8-1234-7000-8000-000000000002', token: 't', expiresAt: new Date(Date.now() + 60_000) },
    profile: {
      userId: '019363c8-1234-7000-8000-000000000001',
      displayName: 'A',
      phone: null,
      language: 'en',
      agentType: null,
      photoFileId: null,
      accountStatus: 'active',
      suspendedReason: null,
      suspendedAt: null,
      verificationStatus: 'unverified',
      tokenVersion: 1,
      lastLoginAt: now,
      erasedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    roles,
    consent: { currentNotice: null, acceptedAt: now, requiresReconsent: false },
  };
}

async function startApp(deps: FilesRouterDeps, roles: AuthContext['roles'] = ['landlord']): Promise<string> {
  const requireAuth: RequestHandler = (req, _res, next) => {
    req.auth = fakeAuth(roles);
    next();
  };
  const app = express();
  app.use(express.json());
  app.use(createFilesRouter({ requireAuth, ...deps }));
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    activeServer = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = activeServer!.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return `http://127.0.0.1:${addr.port}`;
}

const asBody = (buffer: Buffer) => new Blob([new Uint8Array(buffer)]);

describe('upload validation', () => {
  it('detects the real type from the bytes', () => {
    expect(sniffMime(JPEG_BYTES)).toBe('image/jpeg');
    expect(sniffMime(PNG_BYTES)).toBe('image/png');
    expect(sniffMime(PDF_BYTES)).toBe('application/pdf');
    expect(sniffMime(Buffer.from('<?php echo 1;'))).toBeNull();
    expect(sniffMime(Buffer.alloc(0))).toBeNull();
  });

  it('accepts a matching, allowed, in-size file', () => {
    const file = validateUpload(JPEG_BYTES, 'image/jpeg; charset=binary', ['image/jpeg', 'image/png'], 1000, 'a.jpg');
    expect(file.mimeType).toBe('image/jpeg');
    expect(file.filename).toBe('a.jpg');
  });

  it('rejects a missing body, a disallowed type, a disguised file and an oversize file', () => {
    const run = (...args: Parameters<typeof validateUpload>) => {
      try {
        validateUpload(...args);
      } catch (err) {
        return err as HttpError;
      }
      throw new Error('expected a rejection');
    };
    const allowed = ['image/jpeg', 'image/png'] as const;

    expect(run({}, 'image/jpeg', allowed, 1000, 'a').status).toBe(415);
    expect(run(Buffer.alloc(0), 'image/jpeg', allowed, 1000, 'a').status).toBe(415);
    expect(run(PDF_BYTES, 'application/pdf', allowed, 1000, 'a').code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(run(PNG_BYTES, 'image/jpeg', allowed, 1000, 'a').code).toBe('FILE_TYPE_MISMATCH');
    expect(run(JPEG_BYTES, 'image/jpeg', allowed, 8, 'a').status).toBe(413);
  });

  it('cleans file names and parses photo bodies', () => {
    expect(parseUploadFilename('../../etc/passwd')).toBe('....etcpasswd');
    expect(parseUploadFilename('My%20Plot.jpg')).toBe('My Plot.jpg');
    expect(parseUploadFilename(undefined, 'photo')).toBe('photo');

    expect(parsePatchPhotoBody({ category: 'cover', sortOrder: 2 })).toEqual({ category: 'cover', sortOrder: 2 });
    expect(() => parsePatchPhotoBody({})).toThrow(HttpError);
    expect(() => parsePatchPhotoBody({ category: 'space_type' })).toThrow(HttpError);
    expect(() => parsePatchPhotoBody({ sortOrder: -1 })).toThrow(HttpError);
    expect(() => parsePatchPhotoBody({ extra: 1 })).toThrow(HttpError);

    expect(parseRemovePhotoBody(undefined)).toEqual({ reason: null });
    expect(parseRemovePhotoBody({ reason: '  duplicate ' })).toEqual({ reason: 'duplicate' });
    expect(() => parseRemovePhotoBody({ reason: '' })).toThrow(HttpError);
  });
});

describe('files router', () => {
  it('uploads a building photo from the raw body', async () => {
    const calls: unknown[] = [];
    const baseUrl = await startApp({
      uploadPhoto: async (_auth, target, file) => {
        calls.push({ target, mime: file.mimeType, name: file.filename, size: file.buffer.length });
        return { id: PHOTO_ID } as never;
      },
    });

    const res = await fetch(`${baseUrl}/buildings/${BUILDING_ID}/photos?category=cover`, {
      method: 'POST',
      headers: { 'content-type': 'image/jpeg', 'x-file-name': 'front%20gate.jpg' },
      body: asBody(JPEG_BYTES),
    });

    expect(res.status).toBe(201);
    expect(calls).toEqual([
      {
        target: { buildingId: BUILDING_ID, category: 'cover' },
        mime: 'image/jpeg',
        name: 'front gate.jpg',
        size: JPEG_BYTES.length,
      },
    ]);
  });

  it('uploads a space type photo with the space_type category', async () => {
    let target: unknown;
    const baseUrl = await startApp({
      uploadPhoto: async (_auth, t) => {
        target = t;
        return { id: PHOTO_ID } as never;
      },
    });
    const res = await fetch(`${baseUrl}/space-types/${SPACE_TYPE_ID}/photos`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: asBody(PNG_BYTES),
    });
    expect(res.status).toBe(201);
    expect(target).toEqual({ spaceTypeId: SPACE_TYPE_ID, category: 'space_type' });
  });

  it('rejects bad categories, ids, types, disguised files and oversize bodies without calling the service', async () => {
    let called = 0;
    const baseUrl = await startApp({
      maxUploadBytes: 64,
      uploadPhoto: async () => {
        called += 1;
        return {} as never;
      },
    });
    const post = (path: string, type: string, body: Blob | string) =>
      fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': type }, body });

    expect((await post(`/buildings/${BUILDING_ID}/photos?category=roof`, 'image/jpeg', asBody(JPEG_BYTES))).status).toBe(400);
    expect((await post(`/buildings/not-a-uuid/photos?category=cover`, 'image/jpeg', asBody(JPEG_BYTES))).status).toBe(400);
    expect((await post(`/buildings/${BUILDING_ID}/photos?category=cover`, 'text/plain', 'hello')).status).toBe(415);
    expect((await post(`/buildings/${BUILDING_ID}/photos?category=cover`, 'application/pdf', asBody(PDF_BYTES))).status).toBe(415);
    const disguised = await post(`/buildings/${BUILDING_ID}/photos?category=cover`, 'image/jpeg', asBody(PNG_BYTES));
    expect(disguised.status).toBe(415);
    expect(((await disguised.json()) as { code: string }).code).toBe('FILE_TYPE_MISMATCH');
    expect((await post(`/buildings/${BUILDING_ID}/photos?category=cover`, 'image/jpeg', asBody(Buffer.alloc(200, 0xff)))).status).toBe(413);
    expect(called).toBe(0);
  });

  it('lists, updates and removes photos', async () => {
    const seen: Record<string, unknown> = {};
    const baseUrl = await startApp({
      listPhotos: async (_auth, scope) => {
        seen.list = scope;
        return [];
      },
      updatePhoto: async (_auth, id, patch) => {
        seen.update = { id, patch };
        return { id } as never;
      },
      removePhoto: async (_auth, id, reason) => {
        seen.remove = { id, reason };
        return { id, removedAt: new Date() };
      },
    });

    expect((await fetch(`${baseUrl}/buildings/${BUILDING_ID}/photos`)).status).toBe(200);
    expect(seen.list).toEqual({ buildingId: BUILDING_ID });
    expect((await fetch(`${baseUrl}/space-types/${SPACE_TYPE_ID}/photos`)).status).toBe(200);
    expect(seen.list).toEqual({ spaceTypeId: SPACE_TYPE_ID });

    const patch = await fetch(`${baseUrl}/photos/${PHOTO_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'cover' }),
    });
    expect(patch.status).toBe(200);
    expect(seen.update).toEqual({ id: PHOTO_ID, patch: { category: 'cover' } });
    expect(
      (await fetch(`${baseUrl}/photos/${PHOTO_ID}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })).status,
    ).toBe(400);

    expect((await fetch(`${baseUrl}/photos/${PHOTO_ID}`, { method: 'DELETE' })).status).toBe(200);
    expect(seen.remove).toEqual({ id: PHOTO_ID, reason: null });
    await fetch(`${baseUrl}/photos/${PHOTO_ID}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'blurry' }),
    });
    expect(seen.remove).toEqual({ id: PHOTO_ID, reason: 'blurry' });
  });

  it('accepts a PDF as verification evidence for evidence uploaders only', async () => {
    let received: string | undefined;
    const deps: FilesRouterDeps = {
      uploadEvidence: async (_auth, file) => {
        received = file.mimeType;
        return { id: FILE_ID } as never;
      },
    };

    const allowed = await startApp(deps, ['landlord']);
    const ok = await fetch(`${allowed}/files/evidence`, {
      method: 'POST',
      headers: { 'content-type': 'application/pdf', 'x-file-name': 'title-deed.pdf' },
      body: asBody(PDF_BYTES),
    });
    expect(ok.status).toBe(201);
    expect(received).toBe('application/pdf');
  });

  it('refuses evidence uploads from a client and downloads from non-admins', async () => {
    let called = 0;
    const baseUrl = await startApp(
      {
        uploadEvidence: async () => {
          called += 1;
          return {} as never;
        },
        getFileDownload: async () => {
          called += 1;
          return { url: 'x', expiresAt: null };
        },
      },
      ['client'],
    );

    const upload = await fetch(`${baseUrl}/files/evidence`, {
      method: 'POST',
      headers: { 'content-type': 'application/pdf' },
      body: asBody(PDF_BYTES),
    });
    expect(upload.status).toBe(403);
    expect((await fetch(`${baseUrl}/files/${FILE_ID}/download`)).status).toBe(403);
    expect(called).toBe(0);
  });

  it('lets an admin request a download link', async () => {
    const baseUrl = await startApp(
      { getFileDownload: async (_auth, id) => ({ url: `https://fake/${id}`, expiresAt: null }) },
      ['admin'],
    );
    const res = await fetch(`${baseUrl}/files/${FILE_ID}/download`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { url: string } }).data.url).toBe(`https://fake/${FILE_ID}`);
  });
});
