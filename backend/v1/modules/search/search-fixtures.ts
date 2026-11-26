/**
 * Shared set-up for the Phase 7 integration tests (search, public pages, listers, commute).
 * Buildings are written straight to the tables, with the publish gate (T5) switched off for the
 * file's duration, so a test states exactly the state it needs (a Withdrawn building, ten
 * buildings with one shared timestamp) without driving the whole publish flow. The gate itself is
 * covered by buildings.integration.ts. Test-only: nothing in the app imports this.
 */
import { expect } from 'bun:test';
import type { Server } from 'node:http';
import { createApp } from '../../../app.js';
import db, { closeDb } from '../../db/knex.js';
import { closeAuthPool } from '../../lib/auth.js';
import { setCloudinaryClient } from '../../lib/cloudinary.js';
import { generateUuidV7 } from '../../lib/uuid.js';
import { createFakeCloudinary } from '../files/fake-cloudinary.js';

// biome-ignore lint/suspicious/noExplicitAny: response bodies are asserted field by field
export type Body = any;

let server: Server;
let baseUrl = '';

export async function startApp(): Promise<void> {
  setCloudinaryClient(createFakeCloudinary().client);
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to bind ephemeral port');
  baseUrl = `http://127.0.0.1:${addr.port}`;
  // The gate reads these settings; other suites leave them at other values.
  await db.raw('ALTER TABLE buildings DISABLE TRIGGER trg_buildings_publish_gate_update');
  await db.raw('ALTER TABLE buildings DISABLE TRIGGER trg_buildings_publish_gate_insert');
}

export async function stopApp(): Promise<void> {
  await db.raw('ALTER TABLE buildings ENABLE TRIGGER trg_buildings_publish_gate_update');
  await db.raw('ALTER TABLE buildings ENABLE TRIGGER trg_buildings_publish_gate_insert');
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  setCloudinaryClient(null);
  await closeAuthPool();
  await closeDb();
}

export async function call(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'api-v': 'v1',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => null)) as Body;
  return { status: res.status, body: json };
}

export interface Account {
  id: string;
  token: string;
}

export async function register(
  email: string,
  role: 'client' | 'landlord' | 'agent',
  phone: string | null = null,
): Promise<Account> {
  const res = await call('POST', '/auth/register', null, {
    email,
    password: 'password123',
    displayName: email.split('@')[0],
    role,
    privacyNoticeAccepted: true,
  });
  expect(res.status).toBe(201);
  const account = { id: res.body.data.user.id as string, token: res.body.data.tokens.accessToken as string };
  if (phone) await db('profiles').where({ user_id: account.id }).update({ phone });
  return account;
}

/** T7 lets only the verification path write verification_status; this opens that window. */
export const setVerified = (table: 'profiles' | 'buildings', key: string, status = 'verified') =>
  db.transaction(async (trx) => {
    await trx.raw("SET LOCAL khunt.verification_writer = 'on'");
    await trx(table)
      .where(table === 'profiles' ? { user_id: key } : { id: key })
      .update({ verification_status: status });
  });

export interface SeedType {
  name?: string;
  categoryId: string;
  currencyId: string;
  rentMode?: 'fixed' | 'on_interest';
  rentAmount?: number;
  deposit?: number;
  vacant: number;
  /** SQL timestamp text; default is now. Give microseconds to test cursors. */
  confirmedAt?: string;
  sizeSqm?: number;
  photos?: number;
  removed?: boolean;
}

export interface SeedBuilding {
  name?: string;
  areaId: string;
  lat?: number;
  lng?: number;
  status?: 'draft' | 'pending' | 'published' | 'withdrawn' | 'suspended';
  /** A withdrawn building that was once public has `published_at`; a draft that was withdrawn does not. */
  publishedAt?: boolean;
  /** For `suspended`: what it was before. */
  suspendedFrom?: 'draft' | 'pending' | 'published';
  listerId: string;
  /** Maintainers besides the lister. */
  maintainers?: string[];
  managementType?: 'agent' | 'landlord';
  buildingVerified?: boolean;
  cover?: boolean;
  grounds?: number;
  surroundings?: number;
  description?: string;
  types?: SeedType[];
}

async function addFile(uploadedBy: string): Promise<string> {
  const [file] = await db('files')
    .insert({
      public_id: `test/${generateUuidV7()}`,
      resource_type: 'image',
      delivery_type: 'upload',
      format: 'jpg',
      original_name: 'p.jpg',
      mime_type: 'image/jpeg',
      size_bytes: 10,
      visibility: 'public',
      uploaded_by: uploadedBy,
    })
    .returning('id');
  return file.id;
}

async function addPhotos(
  owner: { buildingId: string; category: 'cover' | 'grounds' | 'surroundings' } | { spaceTypeId: string },
  count: number,
  uploadedBy: string,
) {
  for (let i = 0; i < count; i += 1) {
    await db('photos').insert({
      building_id: 'buildingId' in owner ? owner.buildingId : null,
      space_type_id: 'spaceTypeId' in owner ? owner.spaceTypeId : null,
      category: 'buildingId' in owner ? owner.category : 'space_type',
      file_id: await addFile(uploadedBy),
      uploaded_by: uploadedBy,
      sort_order: i,
    });
  }
}

/** Writes one building in the requested state. Returns its id and its space type ids, in order. */
export async function seedBuilding(b: SeedBuilding): Promise<{ id: string; typeIds: string[] }> {
  const status = b.status ?? 'published';
  const managementType = b.managementType ?? 'landlord';
  const [row] = await db('buildings')
    .insert({
      name: b.name ?? `Seed ${generateUuidV7().slice(-8)}`,
      area_id: b.areaId,
      latitude: b.lat ?? -1.3,
      longitude: b.lng ?? 36.8,
      description: b.description ?? 'A seeded building',
      management_type: managementType,
      managing_agent_id: managementType === 'agent' ? b.listerId : null,
      landlord_user_id: managementType === 'landlord' ? b.listerId : null,
      lister_id: b.listerId,
      created_by: b.listerId,
    })
    .returning('id');
  const id = row.id as string;

  await db('building_maintainers').insert(
    [b.listerId, ...(b.maintainers ?? [])].map((userId) => ({ building_id: id, user_id: userId, added_by: b.listerId })),
  );

  const typeIds: string[] = [];
  for (const [index, t] of (b.types ?? []).entries()) {
    const fixed = (t.rentMode ?? 'fixed') === 'fixed';
    const [st] = await db('space_types')
      .insert({
        building_id: id,
        name: t.name ?? `Type ${index + 1}`,
        category_id: t.categoryId,
        size_sqm: t.sizeSqm ?? null,
        rent_mode: fixed ? 'fixed' : 'on_interest',
        currency_id: t.currencyId,
        rent_amount: fixed ? (t.rentAmount ?? 10000) : null,
        deposit_amount: t.deposit ?? 10000,
        vacant_count: t.vacant,
        last_confirmed_at: t.confirmedAt ? db.raw('?::timestamptz', [t.confirmedAt]) : db.fn.now(),
        created_by: b.listerId,
        removed_at: t.removed ? db.fn.now() : null,
        removed_by: t.removed ? b.listerId : null,
      })
      .returning('id');
    typeIds.push(st.id);
    if (t.photos) await addPhotos({ spaceTypeId: st.id }, t.photos, b.listerId);
  }
  if (b.cover !== false) await addPhotos({ buildingId: id, category: 'cover' }, 1, b.listerId);
  if (b.grounds) await addPhotos({ buildingId: id, category: 'grounds' }, b.grounds, b.listerId);
  if (b.surroundings) await addPhotos({ buildingId: id, category: 'surroundings' }, b.surroundings, b.listerId);

  const everPublic = status === 'published' || b.publishedAt === true || b.suspendedFrom === 'published';
  await db('buildings')
    .where({ id })
    .update({
      status,
      contact_user_id: b.listerId,
      published_at: everPublic ? db.fn.now() : null,
      ...(status === 'suspended'
        ? {
            status_before_suspension: b.suspendedFrom ?? 'published',
            suspension_cause: 'admin',
            suspended_reason: 'test',
            suspended_at: db.fn.now(),
          }
        : {}),
    });
  if (b.buildingVerified) await setVerified('buildings', id);
  return { id, typeIds };
}

/** A UTC timestamp `days` days before now, as SQL text, for backdating `last_confirmed_at`. */
export const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

export async function referenceData() {
  const categories = (await db('space_categories').where({ is_active: true }).orderBy('code').select('id', 'code')) as Array<{
    id: string;
    code: string;
  }>;
  const currency = async (code: string) => (await db('currencies').where({ code }).first('id')).id as string;
  return {
    categoryA: categories[0]!.id,
    categoryB: categories[1]!.id,
    kes: await currency('KES'),
    usd: await currency('USD'),
  };
}

export async function makeArea(name: string, lat = -1.3, lng = 36.8): Promise<string> {
  const [area] = await db('areas')
    .insert({ name, slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${generateUuidV7().slice(-6)}`, centre_lat: lat, centre_lng: lng })
    .returning('id');
  return area.id;
}
