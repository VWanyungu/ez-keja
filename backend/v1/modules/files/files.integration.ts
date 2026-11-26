import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Server } from 'node:http';
import { createApp } from '../../../app.js';
import db, { closeDb } from '../../db/knex.js';
import { closeAuthPool } from '../../lib/auth.js';
import { setCloudinaryClient } from '../../lib/cloudinary.js';
import { generateUuidV7 } from '../../lib/uuid.js';
import { JPEG_BYTES, PDF_BYTES, PNG_BYTES, createFakeCloudinary } from './fake-cloudinary.js';
import { purgeFiles } from './purge.js';

const fake = createFakeCloudinary();
let server: Server;
let baseUrl: string;

const json = async <T>(res: Response) => (await res.json()) as T;

beforeAll(async () => {
  setCloudinaryClient(fake.client);
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to bind ephemeral port');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  setCloudinaryClient(null);
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await closeAuthPool();
  await closeDb();
});

async function register(email: string, role: 'client' | 'landlord') {
  const res = await fetch(`${baseUrl}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'api-v': 'v1' },
    body: JSON.stringify({
      email,
      password: 'password123',
      displayName: email.split('@')[0],
      role,
      privacyNoticeAccepted: true,
    }),
  });
  expect(res.status).toBe(201);
  const body = await json<{ data: { user: { id: string }; tokens: { accessToken: string } } }>(res);
  return { id: body.data.user.id, token: body.data.tokens.accessToken };
}

async function loginAdmin() {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'api-v': 'v1' },
    body: JSON.stringify({ email: 'admin@khunt.local', password: 'password' }),
  });
  expect(res.status).toBe(200);
  const body = await json<{ data: { user: { id: string }; tokens: { accessToken: string } } }>(res);
  return { id: body.data.user.id, token: body.data.tokens.accessToken };
}

const auth = (token: string) => ({ 'api-v': 'v1', authorization: `Bearer ${token}` });

function upload(path: string, token: string, bytes: Buffer, type: string, name = 'f.jpg') {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { ...auth(token), 'content-type': type, 'x-file-name': name },
    body: new Blob([new Uint8Array(bytes)]),
  });
}

const uploadBuildingPhoto = (buildingId: string, token: string, category: string, bytes = JPEG_BYTES) =>
  upload(`/buildings/${buildingId}/photos?category=${category}`, token, bytes, 'image/jpeg');

const uploadSpaceTypePhoto = (spaceTypeId: string, token: string) =>
  upload(`/space-types/${spaceTypeId}/photos`, token, JPEG_BYTES, 'image/jpeg');

const remove = (photoId: string, token: string, reason?: string) =>
  fetch(`${baseUrl}/photos/${photoId}`, {
    method: 'DELETE',
    headers: { ...auth(token), ...(reason ? { 'content-type': 'application/json' } : {}) },
    ...(reason ? { body: JSON.stringify({ reason }) } : {}),
  });

async function createBuilding(listerId: string, areaId: string, name: string) {
  const [building] = await db('buildings')
    .insert({
      name,
      area_id: areaId,
      latitude: -1.286389,
      longitude: 36.817223,
      management_type: 'landlord',
      landlord_user_id: listerId,
      lister_id: listerId,
      created_by: listerId,
    })
    .returning('id');
  await db('building_maintainers').insert({
    building_id: building.id,
    user_id: listerId,
    added_by: listerId,
  });
  return building.id as string;
}

describe('Files and photos (PostgreSQL integration, fake Cloudinary)', () => {
  let landlord = { id: '', token: '' };
  let outsider = { id: '', token: '' };
  let client = { id: '', token: '' };
  let admin = { id: '', token: '' };
  let areaId = '';
  let buildingId = '';
  let spaceTypeId = '';
  const photoIds: Record<string, string> = {};
  const spaceTypePhotoIds: string[] = [];

  beforeAll(async () => {
    landlord = await register('files-landlord@example.com', 'landlord');
    outsider = await register('files-outsider@example.com', 'landlord');
    client = await register('files-client@example.com', 'client');
    admin = await loginAdmin();

    const [area] = await db('areas')
      .insert({ name: 'Files Test Area', slug: 'files-test-area', centre_lat: -1.28, centre_lng: 36.82 })
      .returning('id');
    areaId = area.id;
    buildingId = await createBuilding(landlord.id, areaId, 'Files Test Building');

    const category = await db('space_categories').first('id');
    const currency = await db('currencies').first('id');
    const [spaceType] = await db('space_types')
      .insert({
        building_id: buildingId,
        name: 'Bedsitter A',
        category_id: category.id,
        rent_mode: 'on_interest',
        currency_id: currency.id,
        deposit_amount: 0,
        vacant_count: 1,
        created_by: landlord.id,
      })
      .returning('id');
    spaceTypeId = spaceType.id;
  });

  it('stores a maintainer photo and records the file, photo and audit rows', async () => {
    const res = await uploadBuildingPhoto(buildingId, landlord.token, 'cover');
    expect(res.status).toBe(201);
    const body = await json<{
      data: { id: string; category: string; urls: { full: string }; file: { id: string } };
    }>(res);
    photoIds.cover = body.data.id;
    expect(body.data.category).toBe('cover');
    expect(body.data.urls.full).toStartWith('https://fake.test/full/khunt/development/photos/');

    const file = await db('files').where({ id: body.data.file.id }).first();
    expect(file).toMatchObject({
      visibility: 'public',
      delivery_type: 'upload',
      resource_type: 'image',
      format: 'jpg',
      mime_type: 'image/jpeg',
      uploaded_by: landlord.id,
    });
    expect(Number(file.size_bytes)).toBe(JPEG_BYTES.length);
    expect(file.public_id).toStartWith('khunt/development/photos/');

    const sent = fake.uploads.at(-1)!;
    expect(sent).toMatchObject({ resourceType: 'image', deliveryType: 'upload', mimeType: 'image/jpeg' });

    const audit = await db('audit_log').where({ object_id: body.data.id, action: 'photo.add' }).first();
    expect(audit).toMatchObject({ actor_type: 'user', actor_user_id: landlord.id, building_id: buildingId });
  });

  it('refuses a second cover and removes the just-uploaded asset again', async () => {
    const filesBefore = Number((await db('files').count('* as n').first())!.n);
    const destroyedBefore = fake.destroyed.length;

    const res = await uploadBuildingPhoto(buildingId, landlord.token, 'cover');
    expect(res.status).toBe(409);
    expect((await json<{ code: string }>(res)).code).toBe('COVER_EXISTS');

    expect(Number((await db('files').count('* as n').first())!.n)).toBe(filesBefore);
    expect(fake.destroyed.length).toBe(destroyedBefore + 1);
    expect(fake.destroyed.at(-1)!.publicId).toStartWith('khunt/development/photos/');
  });

  it('blocks non-maintainers and bad files before anything is sent to storage', async () => {
    const uploadsBefore = fake.uploads.length;

    const stranger = await uploadBuildingPhoto(buildingId, outsider.token, 'grounds');
    expect(stranger.status).toBe(403);
    expect((await json<{ code: string }>(stranger)).code).toBe('NOT_A_MAINTAINER');

    const disguised = await uploadBuildingPhoto(buildingId, landlord.token, 'grounds', PNG_BYTES);
    expect(disguised.status).toBe(415);

    const anonymous = await fetch(`${baseUrl}/buildings/${buildingId}/photos?category=grounds`, {
      method: 'POST',
      headers: { 'api-v': 'v1', 'content-type': 'image/jpeg' },
      body: new Blob([new Uint8Array(JPEG_BYTES)]),
    });
    expect(anonymous.status).toBe(401);

    const missing = await uploadBuildingPhoto(generateUuidV7(), landlord.token, 'grounds');
    expect(missing.status).toBe(404);

    expect(fake.uploads.length).toBe(uploadsBefore);
  });

  it('keeps a published building above the photo minimums but lets staff moderate', async () => {
    // Complete the building: 3 cover/grounds, 1 surroundings, 3 space type photos, a contact with a phone.
    for (const category of ['grounds', 'grounds', 'surroundings']) {
      const res = await uploadBuildingPhoto(buildingId, landlord.token, category);
      expect(res.status).toBe(201);
      photoIds[`${category}${Object.keys(photoIds).length}`] = (await json<{ data: { id: string } }>(res)).data.id;
    }
    for (let i = 0; i < 3; i += 1) {
      const res = await uploadSpaceTypePhoto(spaceTypeId, landlord.token);
      expect(res.status).toBe(201);
      spaceTypePhotoIds.push((await json<{ data: { id: string } }>(res)).data.id);
    }

    await db('settings').where({ key: 'require_verified_lister_to_publish' }).update({ value: 0 });
    await db('profiles').where({ user_id: landlord.id }).update({ phone: '+254700000001' });
    await db('buildings')
      .where({ id: buildingId })
      .update({ contact_user_id: landlord.id, status: 'published', published_at: db.fn.now() });

    const groundsId = Object.entries(photoIds).find(([key]) => key.startsWith('grounds'))![1];
    const surroundingsId = Object.entries(photoIds).find(([key]) => key.startsWith('surroundings'))![1];

    // Each of these would take the published building below a BR-018 minimum.
    for (const id of [groundsId, surroundingsId, photoIds.cover!, spaceTypePhotoIds[0]!]) {
      const res = await remove(id, landlord.token);
      expect(res.status).toBe(409);
      const body = await json<{ code: string; data: { blockers: string[] } }>(res);
      expect(body.code).toBe('PHOTO_MINIMUM');
      expect(body.data.blockers.length).toBeGreaterThan(0);
      expect((await db('photos').where({ id }).first('removed_at')).removed_at).toBeNull();
    }

    // With a spare grounds photo the same removal is fine.
    const spare = await uploadBuildingPhoto(buildingId, landlord.token, 'grounds');
    expect(spare.status).toBe(201);
    const allowed = await remove(groundsId, landlord.token);
    expect(allowed.status).toBe(200);
    const row = await db('photos').where({ id: groundsId }).first();
    expect(row.removed_at).not.toBeNull();
    expect(row.removed_by).toBe(landlord.id);
    expect(await db('audit_log').where({ object_id: groundsId, action: 'photo.remove' }).first()).toBeTruthy();

    // An Admin acting on behalf must give a reason (FR-ADM-003) and is exempt from the guard.
    const noReason = await remove(photoIds.cover!, admin.token);
    expect(noReason.status).toBe(403);
    expect((await json<{ code: string }>(noReason)).code).toBe('REASON_REQUIRED');

    const moderated = await remove(photoIds.cover!, admin.token, 'Shows another property');
    expect(moderated.status).toBe(200);
    const moderatedRow = await db('photos').where({ id: photoIds.cover }).first();
    expect(moderatedRow.removal_reason).toBe('Shows another property');
    const staffAudit = await db('audit_log').where({ object_id: photoIds.cover, action: 'photo.remove' }).first();
    expect(staffAudit.actor_type).toBe('staff');
  });

  it('moves the cover without ever leaving two, and respects withdrawal', async () => {
    const draftId = await createBuilding(landlord.id, areaId, 'Cover Swap Building');
    const coverA = await json<{ data: { id: string } }>(await uploadBuildingPhoto(draftId, landlord.token, 'cover'));
    const groundsB = await json<{ data: { id: string } }>(await uploadBuildingPhoto(draftId, landlord.token, 'grounds'));

    const swap = await fetch(`${baseUrl}/photos/${groundsB.data.id}`, {
      method: 'PATCH',
      headers: { ...auth(landlord.token), 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'cover' }),
    });
    expect(swap.status).toBe(200);
    expect((await json<{ data: { category: string } }>(swap)).data.category).toBe('cover');

    const live = await db('photos').where({ building_id: draftId }).whereNull('removed_at').select('id', 'category');
    expect(live.filter((p) => p.category === 'cover').map((p) => p.id)).toEqual([groundsB.data.id]);
    expect(live.find((p) => p.id === coverA.data.id)!.category).toBe('grounds');

    const list = await fetch(`${baseUrl}/buildings/${draftId}/photos`, { headers: auth(landlord.token) });
    const listed = await json<{ data: { id: string; category: string }[] }>(list);
    expect(listed.data[0]!.category).toBe('cover');
    expect((await fetch(`${baseUrl}/buildings/${draftId}/photos`, { headers: auth(outsider.token) })).status).toBe(403);

    const outsiderPatch = await fetch(`${baseUrl}/photos/${groundsB.data.id}`, {
      method: 'PATCH',
      headers: { ...auth(outsider.token), 'content-type': 'application/json' },
      body: JSON.stringify({ sortOrder: 5 }),
    });
    expect(outsiderPatch.status).toBe(403);

    // Space type photos have no category to change.
    const categoryOnSpaceType = await fetch(`${baseUrl}/photos/${spaceTypePhotoIds[1]}`, {
      method: 'PATCH',
      headers: { ...auth(landlord.token), 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'cover' }),
    });
    expect(categoryOnSpaceType.status).toBe(400);

    await db('buildings').where({ id: draftId }).update({ status: 'withdrawn' });
    const blocked = await uploadBuildingPhoto(draftId, landlord.token, 'surroundings');
    expect(blocked.status).toBe(409);
    expect((await json<{ code: string }>(blocked)).code).toBe('BUILDING_WITHDRAWN');
  });

  it('stores verification evidence privately and lets only an Admin fetch it, with an audit trail', async () => {
    const pdf = await upload('/files/evidence', landlord.token, PDF_BYTES, 'application/pdf', 'title-deed.pdf');
    expect(pdf.status).toBe(201);
    const pdfBody = await json<{ data: { id: string; url?: string } }>(pdf);
    expect(pdfBody.data.url).toBeUndefined();

    const sent = fake.uploads.at(-1)!;
    expect(sent).toMatchObject({ resourceType: 'raw', deliveryType: 'authenticated', mimeType: 'application/pdf' });
    const file = await db('files').where({ id: pdfBody.data.id }).first();
    expect(file).toMatchObject({
      visibility: 'restricted',
      delivery_type: 'authenticated',
      resource_type: 'raw',
      format: 'pdf',
      original_name: 'title-deed.pdf',
    });
    expect(file.public_id).toEndWith('.pdf');

    const image = await upload('/files/evidence', landlord.token, PNG_BYTES, 'image/png', 'id.png');
    expect(image.status).toBe(201);
    expect(fake.uploads.at(-1)).toMatchObject({ resourceType: 'image', deliveryType: 'authenticated' });

    expect((await upload('/files/evidence', client.token, PDF_BYTES, 'application/pdf')).status).toBe(403);

    expect((await fetch(`${baseUrl}/files/${pdfBody.data.id}/download`, { headers: auth(landlord.token) })).status).toBe(403);
    const download = await fetch(`${baseUrl}/files/${pdfBody.data.id}/download`, { headers: auth(admin.token) });
    expect(download.status).toBe(200);
    const link = await json<{ data: { url: string; expiresAt: string | null } }>(download);
    expect(link.data.url).toStartWith('https://fake.test/download/');
    expect(link.data.expiresAt).not.toBeNull();
    const viewed = await db('audit_log').where({ object_id: pdfBody.data.id, action: 'pii.view' }).first();
    expect(viewed).toMatchObject({ actor_type: 'staff', actor_user_id: admin.id });

    // A public photo needs no signed link and no PII audit entry.
    const photoFile = (await db('photos').where({ id: spaceTypePhotoIds[0] }).first('file_id')).file_id;
    const publicLink = await json<{ data: { url: string; expiresAt: string | null } }>(
      await fetch(`${baseUrl}/files/${photoFile}/download`, { headers: auth(admin.token) }),
    );
    expect(publicLink.data.expiresAt).toBeNull();
    expect(await db('audit_log').where({ object_id: photoFile, action: 'pii.view' }).first()).toBeUndefined();
  });

  it('cannot store restricted evidence as a publicly deliverable file', async () => {
    const attempt = await db('files')
      .insert({
        public_id: `khunt/development/evidence/${generateUuidV7()}`,
        resource_type: 'image',
        delivery_type: 'upload',
        format: 'jpg',
        original_name: 'leak.jpg',
        mime_type: 'image/jpeg',
        size_bytes: 10,
        visibility: 'restricted',
      })
      .then(
        () => null,
        (err: { code?: string; constraint?: string }) => err,
      );
    expect(attempt?.code).toBe('23514');
    expect(attempt?.constraint).toBe('ck_files_visibility_delivery');
  });

  it('purges orphaned and long-removed files, and nothing else, idempotently', async () => {
    const orphanPublicId = `khunt/development/photos/${generateUuidV7()}`;
    const freshPublicId = `khunt/development/photos/${generateUuidV7()}`;
    const row = (publicId: string, createdAt: Date) => ({
      public_id: publicId,
      resource_type: 'image',
      delivery_type: 'upload',
      format: 'jpg',
      original_name: 'o.jpg',
      mime_type: 'image/jpeg',
      size_bytes: 10,
      visibility: 'public',
      uploaded_by: landlord.id,
      created_at: createdAt,
    });
    await db('files').insert([
      row(orphanPublicId, new Date(Date.now() - 48 * 3_600_000)),
      row(freshPublicId, new Date()),
    ]);

    const removedPhoto = await db('photos').where({ id: photoIds.cover }).first('file_id');
    await db('photos')
      .where({ id: photoIds.cover })
      .update({ removed_at: new Date(Date.now() - 40 * 86_400_000) });
    const removedFile = await db('files').where({ id: removedPhoto.file_id }).first('public_id');

    const purgeFake = createFakeCloudinary();
    const first = await purgeFiles({ client: purgeFake.client });
    expect(first).toEqual({ erasedFilesPurged: 0, orphansDeleted: 1, removedPhotosPurged: 1, failures: 0 });
    expect(purgeFake.destroyed.map((d) => d.publicId).sort()).toEqual(
      [orphanPublicId, removedFile.public_id].sort(),
    );

    expect(await db('files').where({ public_id: orphanPublicId }).first()).toBeUndefined();
    expect(await db('files').where({ public_id: freshPublicId }).first()).toBeTruthy();
    const purged = await db('files').where({ id: removedPhoto.file_id }).first();
    expect(purged.purged_at).not.toBeNull();
    expect(purged.original_name).toBe('');

    const second = await purgeFiles({ client: purgeFake.client });
    expect(second).toEqual({ erasedFilesPurged: 0, orphansDeleted: 0, removedPhotosPurged: 0, failures: 0 });

    // A purged file can no longer be downloaded.
    const gone = await fetch(`${baseUrl}/files/${removedPhoto.file_id}/download`, { headers: auth(admin.token) });
    expect(gone.status).toBe(410);
  });
});
