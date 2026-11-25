import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Server } from 'node:http';
import { createApp } from '../../../app.js';
import db, { closeDb } from '../../db/knex.js';
import { closeAuthPool } from '../../lib/auth.js';
import type { AreaItem, CurrencyItem, ServiceCategoryItem, SettingItem, SpaceCategoryItem } from './service.js';

let server: Server;
let baseUrl: string;

function extractCookies(res: Response): string {
  const setCookies = res.headers.getSetCookie?.() ?? [];
  return setCookies.map((c) => c.split(';')[0]).join('; ');
}

beforeAll(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to bind ephemeral port');
  }
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await closeAuthPool();
  await closeDb();
});

describe('Reference data & settings (PostgreSQL integration)', () => {
  let adminCookie = '';
  let adminUserId = '';
  let clientCookie = '';

  it('signs in seeded admin and registers a non-admin client', async () => {
    const adminRes = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@khunt.local', password: 'password' }),
    });
    expect(adminRes.status).toBe(200);
    adminCookie = extractCookies(adminRes);
    const adminBody = (await adminRes.json()) as { user: { id: string } };
    adminUserId = adminBody.user.id;

    const regRes = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-v': 'v1' },
      body: JSON.stringify({
        email: 'ref-client@example.com',
        password: 'password123',
        displayName: 'Ref Client',
        role: 'client',
        privacyNoticeAccepted: true,
      }),
    });
    expect(regRes.status).toBe(201);
    clientCookie = extractCookies(regRes);
  });

  it('serves seeded currencies, space categories, and service categories publicly', async () => {
    const currRes = await fetch(`${baseUrl}/currencies`, { headers: { 'api-v': 'v1' } });
    expect(currRes.status).toBe(200);
    const currBody = (await currRes.json()) as { data: CurrencyItem[] };
    expect(currBody.data.map((c) => c.code)).toEqual(['KES', 'USD']);

    const catRes = await fetch(`${baseUrl}/categories`, { headers: { 'api-v': 'v1' } });
    expect(catRes.status).toBe(200);
    const catBody = (await catRes.json()) as { data: SpaceCategoryItem[] };
    expect(catBody.data).toHaveLength(9);

    const commercialRes = await fetch(`${baseUrl}/space-categories?kind=commercial`, {
      headers: { 'api-v': 'v1' },
    });
    expect(commercialRes.status).toBe(200);
    const commercialBody = (await commercialRes.json()) as { data: SpaceCategoryItem[] };
    expect(commercialBody.data.map((c) => c.code)).toEqual(['office', 'shop', 'warehouse']);

    const svcRes = await fetch(`${baseUrl}/service-categories`, { headers: { 'api-v': 'v1' } });
    expect(svcRes.status).toBe(200);
    const svcBody = (await svcRes.json()) as { data: ServiceCategoryItem[] };
    expect(svcBody.data.map((c) => c.code)).toEqual(['wifi', 'water_refill', 'gas_refill']);
  });

  it('rejects non-admin access to admin reference and settings routes', async () => {
    const res = await fetch(`${baseUrl}/admin/settings`, {
      headers: { 'api-v': 'v1', cookie: clientCookie },
    });
    expect(res.status).toBe(403);
  });

  it('performs audited Admin CRUD for areas and filters inactive areas from public reads', async () => {
    const createRes = await fetch(`${baseUrl}/admin/areas`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-v': 'v1', cookie: adminCookie },
      body: JSON.stringify({
        name: 'Ngong Town',
        centreLat: -1.3617,
        centreLng: 36.6569,
      }),
    });
    expect(createRes.status).toBe(201);
    const createdBody = (await createRes.json()) as { data: AreaItem };
    const areaId = createdBody.data.id;
    expect(createdBody.data.slug).toBe('ngong-town');
    expect(createdBody.data.centreLat).toBe(-1.3617);

    // Case-insensitive duplicate name rejected
    const dupRes = await fetch(`${baseUrl}/admin/areas`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-v': 'v1', cookie: adminCookie },
      body: JSON.stringify({
        name: 'ngong town',
        slug: 'ngong-town-2',
        centreLat: -1.36,
        centreLng: 36.65,
      }),
    });
    expect(dupRes.status).toBe(409);

    // Visible publicly while active
    const pubList1 = await fetch(`${baseUrl}/areas`, { headers: { 'api-v': 'v1' } });
    expect(((await pubList1.json()) as { data: AreaItem[] }).data.map((a) => a.id)).toContain(areaId);

    // Update audited
    const patchRes = await fetch(`${baseUrl}/admin/areas/${areaId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'api-v': 'v1', cookie: adminCookie },
      body: JSON.stringify({ name: 'Ngong Hills' }),
    });
    expect(patchRes.status).toBe(200);
    expect(((await patchRes.json()) as { data: AreaItem }).data.name).toBe('Ngong Hills');

    // Deactivate via DELETE
    const delRes = await fetch(`${baseUrl}/admin/areas/${areaId}`, {
      method: 'DELETE',
      headers: { 'api-v': 'v1', cookie: adminCookie },
    });
    expect(delRes.status).toBe(200);
    expect(((await delRes.json()) as { data: AreaItem }).data.isActive).toBe(false);

    // Hidden from public reads once inactive
    const pubList2 = await fetch(`${baseUrl}/areas`, { headers: { 'api-v': 'v1' } });
    expect(((await pubList2.json()) as { data: AreaItem[] }).data.map((a) => a.id)).not.toContain(
      areaId,
    );
    const pubGet = await fetch(`${baseUrl}/areas/${areaId}`, { headers: { 'api-v': 'v1' } });
    expect(pubGet.status).toBe(404);

    // Admin can still read inactive areas
    const adminGet = await fetch(`${baseUrl}/admin/areas/${areaId}`, {
      headers: { 'api-v': 'v1', cookie: adminCookie },
    });
    expect(adminGet.status).toBe(200);

    // Verify audit_log rows
    const auditRows = await db('audit_log')
      .where({ object_type: 'area', object_id: areaId, actor_user_id: adminUserId })
      .orderBy('created_at', 'asc')
      .select('action', 'actor_type', 'changes');
    expect(auditRows.map((r) => r.action)).toEqual([
      'area.create',
      'area.update',
      'area.deactivate',
    ]);
    expect(auditRows.every((r) => r.actor_type === 'staff')).toBe(true);
  });

  it('performs audited Admin CRUD for currencies and filters inactive currencies from public reads', async () => {
    const createRes = await fetch(`${baseUrl}/admin/currencies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-v': 'v1', cookie: adminCookie },
      body: JSON.stringify({ code: 'tzs', name: 'Tanzanian shilling', sortOrder: 3 }),
    });
    expect(createRes.status).toBe(201);
    const createdCurr = ((await createRes.json()) as { data: CurrencyItem }).data;
    expect(createdCurr.code).toBe('TZS');

    const patchRes = await fetch(`${baseUrl}/admin/currencies/${createdCurr.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'api-v': 'v1', cookie: adminCookie },
      body: JSON.stringify({ name: 'Tanzanian Shilling', sortOrder: 4 }),
    });
    expect(patchRes.status).toBe(200);

    const delRes = await fetch(`${baseUrl}/admin/currencies/${createdCurr.id}`, {
      method: 'DELETE',
      headers: { 'api-v': 'v1', cookie: adminCookie },
    });
    expect(delRes.status).toBe(200);
    expect(((await delRes.json()) as { data: CurrencyItem }).data.isActive).toBe(false);

    const pubList = await fetch(`${baseUrl}/currencies`, { headers: { 'api-v': 'v1' } });
    expect(((await pubList.json()) as { data: CurrencyItem[] }).data.map((c) => c.code)).toEqual([
      'KES',
      'USD',
    ]);

    const auditRows = await db('audit_log')
      .where({ object_type: 'currency', object_id: createdCurr.id })
      .orderBy('created_at', 'asc')
      .select('action');
    expect(auditRows.map((r) => r.action)).toEqual([
      'currency.create',
      'currency.update',
      'currency.deactivate',
    ]);
  });

  it('performs range-checked and audited Admin CRUD for settings', async () => {
    const listRes = await fetch(`${baseUrl}/admin/settings`, {
      headers: { 'api-v': 'v1', cookie: adminCookie },
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { data: SettingItem[] };
    expect(listBody.data.length).toBeGreaterThanOrEqual(9);

    // Out-of-range update on seeded setting is refused
    const badRes = await fetch(`${baseUrl}/admin/settings/freshness_days`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'api-v': 'v1', cookie: adminCookie },
      body: JSON.stringify({ value: 0 }),
    });
    expect(badRes.status).toBe(400);

    const badFlagRes = await fetch(`${baseUrl}/admin/settings/require_verified_lister_to_publish`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'api-v': 'v1', cookie: adminCookie },
      body: JSON.stringify({ value: 2 }),
    });
    expect(badFlagRes.status).toBe(400);

    // Valid update succeeds and is audited
    const okRes = await fetch(`${baseUrl}/admin/settings/freshness_days`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'api-v': 'v1', cookie: adminCookie },
      body: JSON.stringify({ value: 10 }),
    });
    expect(okRes.status).toBe(200);
    const okSetting = ((await okRes.json()) as { data: SettingItem }).data;
    expect(okSetting.value).toBe(10);
    expect(okSetting.updatedBy).toBe(adminUserId);

    // Required seeded setting cannot be deleted
    const delReqRes = await fetch(`${baseUrl}/admin/settings/freshness_days`, {
      method: 'DELETE',
      headers: { 'api-v': 'v1', cookie: adminCookie },
    });
    expect(delReqRes.status).toBe(409);

    // Custom setting can be created, updated, and deleted with audit
    const createCustomRes = await fetch(`${baseUrl}/admin/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-v': 'v1', cookie: adminCookie },
      body: JSON.stringify({
        key: 'custom_batch_limit',
        value: 25,
        minValue: 5,
        maxValue: 100,
        description: 'Custom batch limit for tests',
      }),
    });
    expect(createCustomRes.status).toBe(201);
    const customSetting = ((await createCustomRes.json()) as { data: SettingItem }).data;

    const delCustomRes = await fetch(`${baseUrl}/admin/settings/${customSetting.id}`, {
      method: 'DELETE',
      headers: { 'api-v': 'v1', cookie: adminCookie },
    });
    expect(delCustomRes.status).toBe(200);

    const auditRows = await db('audit_log')
      .where({ object_type: 'setting', object_id: customSetting.id })
      .orderBy('created_at', 'asc')
      .select('action');
    expect(auditRows.map((r) => r.action)).toEqual(['setting.create', 'setting.delete']);
  });
});
