import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Server } from 'node:http';
import { createApp } from '../../../app.js';
import db, { closeDb } from '../../db/knex.js';
import { closeAuthPool } from '../../lib/auth.js';
import { generateUuidV7 } from '../../lib/uuid.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to bind ephemeral port');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await closeAuthPool();
  await closeDb();
});

// biome-ignore lint/suspicious/noExplicitAny: response bodies are asserted field by field
type Body = any;

async function call(method: string, path: string, token: string | null, body?: unknown) {
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

interface Account {
  id: string;
  token: string;
}

async function register(email: string, role: 'client' | 'landlord' | 'agent'): Promise<Account> {
  const res = await call('POST', '/auth/register', null, {
    email,
    password: 'password123',
    displayName: email.split('@')[0],
    role,
    privacyNoticeAccepted: true,
  });
  expect(res.status).toBe(201);
  return { id: res.body.data.user.id, token: res.body.data.tokens.accessToken };
}

async function loginAdmin(): Promise<Account> {
  const res = await call('POST', '/auth/login', null, { email: 'admin@khunt.local', password: 'password' });
  expect(res.status).toBe(200);
  return { id: res.body.data.user.id, token: res.body.data.tokens.accessToken };
}

const setPhone = (userId: string, phone: string) => db('profiles').where({ user_id: userId }).update({ phone });

/** T7 lets only the verification path write verification_status; the test opens that window itself. */
const setVerified = (userId: string) =>
  db.transaction(async (trx) => {
    await trx.raw("SET LOCAL khunt.verification_writer = 'on'");
    await trx('profiles').where({ user_id: userId }).update({ verification_status: 'verified' });
  });

async function addPhotos(
  owner: { buildingId: string; category: 'cover' | 'grounds' | 'surroundings' } | { spaceTypeId: string },
  count: number,
  uploadedBy: string,
) {
  for (let i = 0; i < count; i += 1) {
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
    await db('photos').insert({
      building_id: 'buildingId' in owner ? owner.buildingId : null,
      space_type_id: 'spaceTypeId' in owner ? owner.spaceTypeId : null,
      category: 'buildingId' in owner ? owner.category : 'space_type',
      file_id: file.id,
      uploaded_by: uploadedBy,
    });
  }
}

/** Soft-removes one live photo of a space type (knex cannot LIMIT an UPDATE on PostgreSQL). */
async function removeOnePhoto(spaceTypeId: string, byUser: string) {
  const photo = await db('photos').where({ space_type_id: spaceTypeId }).whereNull('removed_at').first('id');
  await db('photos').where({ id: photo.id }).update({ removed_at: new Date(), removed_by: byUser });
}

describe('Catalogue: buildings and space types (PostgreSQL integration)', () => {
  let landlord: Account; // verified, has a phone
  let unverified: Account; // landlord, not verified, has a phone
  let agent: Account;
  let outsider: Account;
  let client: Account;
  let admin: Account;
  let areaId = '';
  let inactiveAreaId = '';
  let categoryId = '';
  let currencyId = '';
  let inactiveCurrencyId = '';

  const buildingBody = (extra: Record<string, unknown> = {}) => ({
    name: 'Acacia Court',
    areaId,
    latitude: -1.286389,
    longitude: 36.817223,
    description: 'Quiet, near the matatu stage',
    managementType: 'landlord',
    ...extra,
  });
  const spaceTypeBody = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    categoryId,
    rentMode: 'fixed',
    rentAmount: 15000,
    currencyId,
    depositAmount: 15000,
    vacantCount: 2,
    ...extra,
  });

  async function createBuilding(token: string, extra: Record<string, unknown> = {}): Promise<string> {
    const res = await call('POST', '/buildings', token, buildingBody(extra));
    expect(res.status).toBe(201);
    return res.body.data.id;
  }

  async function createSpaceType(token: string, buildingId: string, name: string, extra = {}): Promise<string> {
    const res = await call('POST', `/buildings/${buildingId}/space-types`, token, spaceTypeBody(name, extra));
    expect(res.status).toBe(201);
    return res.body.data.id;
  }

  /** A Draft that satisfies BR-018 for a verified, phoned lister: ready to publish. */
  async function readyBuilding(typeNames: string[] = ['Type A', 'Type B']) {
    const id = await createBuilding(landlord.token);
    await addPhotos({ buildingId: id, category: 'cover' }, 1, landlord.id);
    await addPhotos({ buildingId: id, category: 'grounds' }, 2, landlord.id);
    await addPhotos({ buildingId: id, category: 'surroundings' }, 1, landlord.id);
    const typeIds: string[] = [];
    for (const name of typeNames) {
      const typeId = await createSpaceType(landlord.token, id, name);
      await addPhotos({ spaceTypeId: typeId }, 3, landlord.id);
      typeIds.push(typeId);
    }
    expect((await call('PUT', `/buildings/${id}/contact`, landlord.token, { userId: landlord.id })).status).toBe(200);
    return { id, typeIds };
  }

  const audit = (objectId: string, action: string) => db('audit_log').where({ object_id: objectId, action }).first();

  beforeAll(async () => {
    landlord = await register('cat-landlord@example.com', 'landlord');
    unverified = await register('cat-unverified@example.com', 'landlord');
    agent = await register('cat-agent@example.com', 'agent');
    outsider = await register('cat-outsider@example.com', 'landlord');
    client = await register('cat-client@example.com', 'client');
    admin = await loginAdmin();

    // The suites share one database and files.integration.ts leaves this setting at 0. The gate
    // behaviour under test (BR-005) needs the default, so set it here rather than rely on order.
    await db('settings').where({ key: 'require_verified_lister_to_publish' }).update({ value: 1 });

    await setPhone(landlord.id, '+254700000001');
    await setPhone(unverified.id, '+254700000002');
    await setVerified(landlord.id);

    const [area] = await db('areas')
      .insert({ name: 'Catalogue Test Area', slug: 'catalogue-test-area', centre_lat: -1.28, centre_lng: 36.82 })
      .returning('id');
    areaId = area.id;
    const [inactive] = await db('areas')
      .insert({ name: 'Closed Area', slug: 'closed-area', centre_lat: -1.3, centre_lng: 36.8, is_active: false })
      .returning('id');
    inactiveAreaId = inactive.id;
    categoryId = (await db('space_categories').where({ is_active: true }).first('id')).id;
    currencyId = (await db('currencies').where({ is_active: true }).first('id')).id;
    const [badCurrency] = await db('currencies').insert({ code: 'ZZZ', name: 'Retired', is_active: false }).returning('id');
    inactiveCurrencyId = badCurrency.id;
  });

  // ---- create ----------------------------------------------------------------------------

  describe('creating a building (FR-UNT-001, FR-UNT-005, G-15)', () => {
    it('creates a Draft whose creator is the lister and first maintainer, with an audit row', async () => {
      const res = await call('POST', '/buildings', landlord.token, buildingBody());
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        status: 'draft',
        version: 1,
        listerId: landlord.id,
        createdBy: landlord.id,
        managementType: 'landlord',
        landlordUserId: landlord.id, // a landlord lister need not name themselves
        contactUserId: null,
        latitude: -1.286389,
      });

      const detail = await call('GET', `/buildings/${res.body.data.id}`, landlord.token);
      expect(detail.status).toBe(200);
      expect(detail.body.data.maintainers.map((m: Body) => m.userId)).toEqual([landlord.id]);
      expect(detail.body.data.spaceTypes).toEqual([]);

      expect(await audit(res.body.data.id, 'building.create')).toMatchObject({ actor_type: 'user', actor_user_id: landlord.id });
    });

    it('lets an agent manage a building and defaults the managing agent to the lister', async () => {
      const res = await call('POST', '/buildings', agent.token, buildingBody({ managementType: 'agent' }));
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ managementType: 'agent', managingAgentId: agent.id });
    });

    it('refuses a missing pin, a bad area, an invalid management designation and a client', async () => {
      const { latitude: _l, ...noPin } = buildingBody();
      expect((await call('POST', '/buildings', landlord.token, noPin)).body.code).toBe('MAP_PIN_REQUIRED');

      const inactive = await call('POST', '/buildings', landlord.token, buildingBody({ areaId: inactiveAreaId }));
      expect(inactive.status).toBe(400);
      expect(inactive.body.code).toBe('INVALID_AREA');
      const unknownArea = await call('POST', '/buildings', landlord.token, buildingBody({ areaId: generateUuidV7() }));
      expect(unknownArea.body.code).toBe('INVALID_AREA');

      // an agent-managed building must link a real Agent account
      const notAgent = await call('POST', '/buildings', landlord.token, buildingBody({ managementType: 'agent', managingAgentId: landlord.id }));
      expect(notAgent.body.code).toBe('MANAGING_AGENT_INVALID');
      const noAgent = await call('POST', '/buildings', landlord.token, buildingBody({ managementType: 'agent' }));
      expect(noAgent.body.code).toBe('MANAGEMENT_INVALID');
      // an agent lister who gives no landlord must name one
      const noLandlord = await call('POST', '/buildings', agent.token, buildingBody({ managementType: 'landlord' }));
      expect(noLandlord.body.code).toBe('MANAGEMENT_INVALID');
      const named = await call('POST', '/buildings', agent.token, buildingBody({ managementType: 'landlord', landlordName: 'Mrs Wanjiru' }));
      expect(named.status).toBe(201);

      expect((await call('POST', '/buildings', client.token, buildingBody())).status).toBe(403);
      expect((await call('POST', '/buildings', null, buildingBody())).status).toBe(401);
    });

    it('lets an Admin create on behalf: creator and lister both recorded, the lister maintains it', async () => {
      const res = await call('POST', '/buildings', admin.token, buildingBody({ listerId: outsider.id }));
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ createdBy: admin.id, listerId: outsider.id });

      const row = await db('buildings').where({ id: res.body.data.id }).first();
      expect(row).toMatchObject({ created_by: admin.id, lister_id: outsider.id });
      const maintainers = await db('building_maintainers').where({ building_id: res.body.data.id });
      expect(maintainers.map((m) => m.user_id)).toEqual([outsider.id]);
      expect(maintainers[0]!.added_by).toBe(admin.id);
      expect(await audit(res.body.data.id, 'building.create')).toMatchObject({ actor_type: 'staff', actor_user_id: admin.id });
    });

    it('refuses an on-behalf create by a non-admin and a lister without a lister role (ASM-10)', async () => {
      const bySelf = await call('POST', '/buildings', landlord.token, buildingBody({ listerId: outsider.id }));
      expect(bySelf.status).toBe(403);
      expect(bySelf.body.code).toBe('ADMIN_ONLY');

      const toClient = await call('POST', '/buildings', admin.token, buildingBody({ listerId: client.id }));
      expect(toClient.status).toBe(400);
      expect(toClient.body.code).toBe('LISTER_NOT_ELIGIBLE');
    });
  });

  // ---- edit, optimistic locking -----------------------------------------------------------

  describe('editing a building (FR-UNT-007, TX-04)', () => {
    let id = '';
    beforeAll(async () => {
      id = await createBuilding(landlord.token);
    });

    it('saves with the current version, bumps it and audits before and after', async () => {
      const res = await call('PATCH', `/buildings/${id}`, landlord.token, { version: 1, name: 'Acacia Court II', description: null });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ name: 'Acacia Court II', description: null, version: 2 });

      const row = await audit(id, 'building.update');
      expect(row.changes).toEqual({
        before: { name: 'Acacia Court', description: 'Quiet, near the matatu stage' },
        after: { name: 'Acacia Court II', description: null },
      });
    });

    it('answers 409 with the current version for a stale save and changes nothing', async () => {
      const res = await call('PATCH', `/buildings/${id}`, landlord.token, { version: 1, name: 'Stale name' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('STALE_VERSION');
      expect(res.body.data).toEqual({ currentVersion: 2 });
      expect((await db('buildings').where({ id }).first()).name).toBe('Acacia Court II');
    });

    it('treats an unchanged save as a no-op, but still refuses a stale one', async () => {
      const same = await call('PATCH', `/buildings/${id}`, landlord.token, { version: 2, name: 'Acacia Court II' });
      expect(same.status).toBe(200);
      expect(same.body.data.version).toBe(2);
      const stale = await call('PATCH', `/buildings/${id}`, landlord.token, { version: 1, name: 'Acacia Court II' });
      expect(stale.status).toBe(409);
    });

    it('switches management type with its rules and refuses bad edits', async () => {
      const toAgent = await call('PATCH', `/buildings/${id}`, landlord.token, { version: 2, managementType: 'agent', managingAgentId: agent.id });
      expect(toAgent.status).toBe(200);
      expect(toAgent.body.data).toMatchObject({ managementType: 'agent', managingAgentId: agent.id, version: 3 });

      // back to landlord management drops the agent link
      const back = await call('PATCH', `/buildings/${id}`, landlord.token, { version: 3, managementType: 'landlord' });
      expect(back.status).toBe(200);
      expect(back.body.data).toMatchObject({ managementType: 'landlord', managingAgentId: null });

      expect((await call('PATCH', `/buildings/${id}`, landlord.token, { version: 4, areaId: inactiveAreaId })).body.code).toBe('INVALID_AREA');
      expect((await call('PATCH', `/buildings/${id}`, landlord.token, { version: 4, latitude: 120 })).status).toBe(400);
      expect((await call('PATCH', `/buildings/${id}`, landlord.token, { name: 'No version' })).status).toBe(400);
      expect((await call('PATCH', `/buildings/${id}`, landlord.token, { version: 4, status: 'published' })).status).toBe(400);
    });

    it('lets an Admin edit on behalf, audited as staff', async () => {
      const res = await call('PATCH', `/buildings/${id}`, admin.token, { version: 4, name: 'Renamed by staff' });
      expect(res.status).toBe(200);
      const rows = await db('audit_log').where({ object_id: id, action: 'building.update' }).orderBy('created_at', 'desc');
      expect(rows[0]).toMatchObject({ actor_type: 'staff', actor_user_id: admin.id });
    });
  });

  // ---- authorisation ----------------------------------------------------------------------

  describe('non-maintainers (FR-UNT-006, BR-031)', () => {
    it('get 403 on every read and write, and nothing changes', async () => {
      const { id, typeIds } = await readyBuilding(['Type A']);
      const spaceTypeId = typeIds[0]!;
      const before = await db('buildings').where({ id }).first();

      const requests: Array<[string, string, unknown?]> = [
        ['GET', `/buildings/${id}`],
        ['GET', `/buildings/${id}/publish-blockers`],
        ['GET', `/buildings/${id}/space-types`],
        ['PATCH', `/buildings/${id}`, { version: 1, name: 'Hijacked' }],
        ['POST', `/buildings/${id}/withdraw`],
        ['POST', `/buildings/${id}/reopen`],
        ['POST', `/buildings/${id}/publish`],
        ['POST', `/buildings/${id}/maintainers`, { userId: outsider.id }],
        ['DELETE', `/buildings/${id}/maintainers/${landlord.id}`],
        ['PUT', `/buildings/${id}/contact`, { userId: landlord.id }],
        ['POST', `/buildings/${id}/space-types`, spaceTypeBody('Intruder')],
        ['PATCH', `/space-types/${spaceTypeId}`, { version: 1, name: 'Hijacked' }],
        ['DELETE', `/space-types/${spaceTypeId}`],
        ['POST', `/space-types/${spaceTypeId}/restore`, { vacantCount: 1 }],
      ];
      for (const [method, path, body] of requests) {
        const res = await call(method, path, outsider.token, body);
        expect([method, path, res.status, res.body.code]).toEqual([method, path, 403, 'NOT_A_MAINTAINER']);
        const anonymous = await call(method, path, null, body);
        expect([method, path, anonymous.status]).toEqual([method, path, 401]);
      }

      const after = await db('buildings').where({ id }).first();
      expect(after).toMatchObject({ name: before.name, status: 'draft', version: before.version });
      expect(await db('space_types').where({ building_id: id }).count('* as n').first()).toMatchObject({ n: '1' });
      expect((await db('space_types').where({ id: spaceTypeId }).first()).removed_at).toBeNull();
    });

    it('returns 404 for an unknown building or space type', async () => {
      expect((await call('GET', `/buildings/${generateUuidV7()}`, landlord.token)).status).toBe(404);
      expect((await call('PATCH', `/space-types/${generateUuidV7()}`, landlord.token, { version: 1, name: 'x' })).status).toBe(404);
    });
  });

  // ---- maintainers and contact ------------------------------------------------------------

  describe('maintainers and the designated contact (TX-15, BR-018)', () => {
    let id = '';
    beforeAll(async () => {
      id = await createBuilding(landlord.token);
    });

    it('adds a maintainer, refusing duplicates, non-listers and unknown users', async () => {
      const res = await call('POST', `/buildings/${id}/maintainers`, landlord.token, { userId: agent.id });
      expect(res.status).toBe(201);
      expect(res.body.data.map((m: Body) => m.userId).sort()).toEqual([agent.id, landlord.id].sort());
      expect(await audit(agent.id, 'maintainer.add')).toMatchObject({ building_id: id });

      expect((await call('POST', `/buildings/${id}/maintainers`, landlord.token, { userId: agent.id })).body.code).toBe('ALREADY_MAINTAINER');
      expect((await call('POST', `/buildings/${id}/maintainers`, landlord.token, { userId: client.id })).body.code).toBe('NOT_A_LISTER');
      expect((await call('POST', `/buildings/${id}/maintainers`, landlord.token, { userId: generateUuidV7() })).status).toBe(404);
    });

    it('lets a new maintainer in at once and sets the contact only to a maintainer with a phone', async () => {
      expect((await call('GET', `/buildings/${id}`, agent.token)).status).toBe(200);

      const noPhone = await call('PUT', `/buildings/${id}/contact`, landlord.token, { userId: agent.id });
      expect(noPhone.status).toBe(409);
      expect(noPhone.body.code).toBe('CONTACT_PHONE_REQUIRED');

      const stranger = await call('PUT', `/buildings/${id}/contact`, landlord.token, { userId: unverified.id });
      expect(stranger.status).toBe(400);
      expect(stranger.body.code).toBe('CONTACT_NOT_MAINTAINER');

      const ok = await call('PUT', `/buildings/${id}/contact`, landlord.token, { userId: landlord.id });
      expect(ok.status).toBe(200);
      expect(ok.body.data.contactUserId).toBe(landlord.id);
      expect((await audit(id, 'building.contact.set')).changes).toEqual({
        before: { contactUserId: null },
        after: { contactUserId: landlord.id },
      });

      const detail = await call('GET', `/buildings/${id}`, landlord.token);
      const contact = detail.body.data.maintainers.find((m: Body) => m.isContact);
      expect(contact).toMatchObject({ userId: landlord.id, hasPhone: true });
    });

    it('refuses removing the current contact, then removes another maintainer and ends their access', async () => {
      const blocked = await call('DELETE', `/buildings/${id}/maintainers/${landlord.id}`, agent.token);
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe('MAINTAINER_IS_CONTACT');

      const removed = await call('DELETE', `/buildings/${id}/maintainers/${agent.id}`, landlord.token);
      expect(removed.status).toBe(200);
      expect(removed.body.data.map((m: Body) => m.userId)).toEqual([landlord.id]);
      expect(await audit(agent.id, 'maintainer.remove')).toMatchObject({ building_id: id });

      expect((await call('GET', `/buildings/${id}`, agent.token)).status).toBe(403);
      expect((await call('DELETE', `/buildings/${id}/maintainers/${agent.id}`, landlord.token)).status).toBe(404);
    });

    it('keeps the last maintainer', async () => {
      const lone = await createBuilding(landlord.token);
      const res = await call('DELETE', `/buildings/${lone}/maintainers/${landlord.id}`, landlord.token);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('LAST_MAINTAINER');
    });
  });

  // ---- space types ------------------------------------------------------------------------

  describe('space types (FR-UNT-002 to -004, -010, -011, BR-013, BR-028, BR-029)', () => {
    let id = '';
    let typeId = '';
    beforeAll(async () => {
      id = await createBuilding(landlord.token);
    });

    it('creates fixed and on-interest space types, each with a deposit, and logs a created event', async () => {
      const res = await call('POST', `/buildings/${id}/space-types`, landlord.token, spaceTypeBody('Bedsitter · Type A', { sizeSqm: 18.5 }));
      expect(res.status).toBe(201);
      typeId = res.body.data.id;
      expect(res.body.data).toMatchObject({
        name: 'Bedsitter · Type A',
        rentMode: 'fixed',
        rentAmount: 15000,
        depositAmount: 15000,
        sizeSqm: 18.5,
        vacantCount: 2,
        removedAt: null,
        version: 1,
      });
      expect(await db('availability_events').where({ space_type_id: typeId, event_type: 'created' }).first()).toMatchObject({
        old_count: null,
        new_count: 2,
        actor_user_id: landlord.id,
        acted_as_staff: false,
        source: 'maintainer',
      });

      const open = await call('POST', `/buildings/${id}/space-types`, landlord.token, spaceTypeBody('Office 1', { rentMode: 'on_interest', rentAmount: undefined, depositAmount: 0, vacantCount: 0 }));
      expect(open.status).toBe(201);
      expect(open.body.data).toMatchObject({ rentMode: 'on_interest', rentAmount: null, depositAmount: 0, vacantCount: 0 });
    });

    it('refuses bad input and names the field', async () => {
      const bad = async (extra: Record<string, unknown>) => (await call('POST', `/buildings/${id}/space-types`, landlord.token, spaceTypeBody('Bad', extra)));
      expect((await bad({ depositAmount: undefined })).status).toBe(400);
      expect((await bad({ depositAmount: -1 })).status).toBe(400);
      expect((await bad({ rentAmount: 0 })).status).toBe(400);
      expect((await bad({ rentMode: 'on_interest' })).status).toBe(400);
      expect((await bad({ vacantCount: -1 })).status).toBe(400);
      expect((await bad({ vacantCount: 1.5 })).status).toBe(400);
      expect((await bad({ sizeSqm: 0 })).status).toBe(400);
      expect((await bad({ name: '' })).status).toBe(400);
      expect((await bad({ name: 'x'.repeat(101) })).status).toBe(400);
      expect((await bad({ categoryId: generateUuidV7() })).body.code).toBe('INVALID_CATEGORY');
      expect((await bad({ currencyId: inactiveCurrencyId })).body.code).toBe('INVALID_CURRENCY');
      const res = await bad({ vacantCount: -1 });
      expect(res.body.message).toContain('vacantCount');
    });

    it('treats names as unique per building, ignoring case, but not across buildings', async () => {
      const clash = await call('POST', `/buildings/${id}/space-types`, landlord.token, spaceTypeBody('BEDSITTER · TYPE A'));
      expect(clash.status).toBe(409);
      expect(clash.body.code).toBe('NAME_TAKEN');

      const other = await createBuilding(landlord.token);
      expect((await call('POST', `/buildings/${other}/space-types`, landlord.token, spaceTypeBody('Bedsitter · Type A'))).status).toBe(201);
    });

    it('edits with the version check and an audit row, and leaves the count alone', async () => {
      const res = await call('PATCH', `/space-types/${typeId}`, landlord.token, { version: 1, rentAmount: 16000, sizeSqm: null });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ rentAmount: 16000, sizeSqm: null, version: 2 });
      expect((await audit(typeId, 'space_type.update')).changes).toEqual({
        before: { rentAmount: 15000, sizeSqm: 18.5 },
        after: { rentAmount: 16000, sizeSqm: null },
      });

      const stale = await call('PATCH', `/space-types/${typeId}`, landlord.token, { version: 1, rentAmount: 17000 });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ code: 'STALE_VERSION', data: { currentVersion: 2 } });

      const count = await call('PATCH', `/space-types/${typeId}`, landlord.token, { version: 2, vacantCount: 0 });
      expect(count.status).toBe(400);
      expect(count.body.code).toBe('COUNT_NOT_EDITABLE');
    });

    it('moves between rent modes by the rules and refuses a clashing rename', async () => {
      const toInterest = await call('PATCH', `/space-types/${typeId}`, landlord.token, { version: 2, rentMode: 'on_interest' });
      expect(toInterest.body.data).toMatchObject({ rentMode: 'on_interest', rentAmount: null, version: 3 });
      expect((await call('PATCH', `/space-types/${typeId}`, landlord.token, { version: 3, rentMode: 'fixed' })).body.code).toBe('RENT_INVALID');
      const toFixed = await call('PATCH', `/space-types/${typeId}`, landlord.token, { version: 3, rentMode: 'fixed', rentAmount: 9000 });
      expect(toFixed.body.data).toMatchObject({ rentMode: 'fixed', rentAmount: 9000, version: 4 });

      const clash = await call('PATCH', `/space-types/${typeId}`, landlord.token, { version: 4, name: 'office 1' });
      expect(clash.status).toBe(409);
      expect(clash.body.code).toBe('NAME_TAKEN');
    });

    it('lists live space types, and removed ones on request', async () => {
      const live = await call('GET', `/buildings/${id}/space-types`, landlord.token);
      expect(live.body.data.map((s: Body) => s.name).sort()).toEqual(['Bedsitter · Type A', 'Office 1']);
      expect((await call('GET', `/buildings/${id}/space-types?includeRemoved=maybe`, landlord.token)).status).toBe(400);
    });
  });

  // ---- publishing -------------------------------------------------------------------------

  describe('publishing (TX-03, BR-018, BR-005, FR-VER-008)', () => {
    it('lists every blocker and refuses to publish an incomplete building with a 409 that names them', async () => {
      const id = await createBuilding(landlord.token);
      await createSpaceType(landlord.token, id, 'Type A');

      const blockers = await call('GET', `/buildings/${id}/publish-blockers`, landlord.token);
      expect(blockers.status).toBe(200);
      expect(blockers.body.data).toMatchObject({ canPublish: false, wouldBePending: false });
      expect(blockers.body.data.blockers).toEqual(
        expect.arrayContaining([
          'needs at least 3 cover or grounds photos (has 0)',
          'needs a cover photo',
          'needs at least 1 surroundings photos (has 0)',
          'needs a designated contact',
          'space type "Type A" needs at least 3 photos (has 0)',
        ]),
      );

      const res = await call('POST', `/buildings/${id}/publish`, landlord.token);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PUBLISH_BLOCKED');
      expect(res.body.data.blockers).toEqual(blockers.body.data.blockers);
      expect((await db('buildings').where({ id }).first()).status).toBe('draft');
    });

    it('refuses a building with no space type, and one whose space type has too few photos', async () => {
      const { id, typeIds } = await readyBuilding(['Type A']);
      await removeOnePhoto(typeIds[0]!, landlord.id);
      const few = await call('POST', `/buildings/${id}/publish`, landlord.token);
      expect(few.body.data.blockers).toEqual(['space type "Type A" needs at least 3 photos (has 2)']);

      await call('DELETE', `/space-types/${typeIds[0]}`, landlord.token);
      const none = await call('POST', `/buildings/${id}/publish`, landlord.token);
      expect(none.body.data.blockers).toEqual(['needs at least one space type']);
    });

    it('publishes a complete building: stamps counts, writes a published event per type, keeps published_at', async () => {
      const { id, typeIds } = await readyBuilding();
      await db('space_types').whereIn('id', typeIds).update({ last_confirmed_at: new Date('2026-01-01T00:00:00Z') });

      const res = await call('POST', `/buildings/${id}/publish`, landlord.token);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ outcome: 'published', blockers: [] });
      expect(res.body.data.building.status).toBe('published');
      expect(res.body.data.building.publishedAt).not.toBeNull();

      for (const typeId of typeIds) {
        const type = await db('space_types').where({ id: typeId }).first();
        expect(type.last_confirmed_at.getTime()).toBeGreaterThan(Date.now() - 60_000);
        const event = await db('availability_events').where({ space_type_id: typeId, event_type: 'published' }).first();
        expect(event).toMatchObject({ new_count: 2, actor_user_id: landlord.id, source: 'maintainer' });
      }
      expect(await audit(id, 'building.publish')).toMatchObject({ actor_user_id: landlord.id });

      const again = await call('POST', `/buildings/${id}/publish`, landlord.token);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('ALREADY_PUBLISHED');
    });

    it('parks the building as Pending when only the lister is unverified, then publishes once they are verified', async () => {
      const id = await createBuilding(unverified.token);
      await addPhotos({ buildingId: id, category: 'cover' }, 1, unverified.id);
      await addPhotos({ buildingId: id, category: 'grounds' }, 2, unverified.id);
      await addPhotos({ buildingId: id, category: 'surroundings' }, 1, unverified.id);
      const typeId = await createSpaceType(unverified.token, id, 'Type A');
      await addPhotos({ spaceTypeId: typeId }, 3, unverified.id);
      await call('PUT', `/buildings/${id}/contact`, unverified.token, { userId: unverified.id });

      const blockers = await call('GET', `/buildings/${id}/publish-blockers`, unverified.token);
      expect(blockers.body.data).toEqual({ blockers: ['the lister is not verified'], canPublish: false, wouldBePending: true });

      const pending = await call('POST', `/buildings/${id}/publish`, unverified.token);
      expect(pending.status).toBe(200);
      expect(pending.body.data).toMatchObject({ outcome: 'pending', blockers: ['the lister is not verified'] });
      expect(pending.body.data.building.status).toBe('pending');
      expect(pending.body.data.building.publishedAt).toBeNull();
      expect(await audit(id, 'building.pending')).not.toBeUndefined();

      // asking again changes nothing
      const again = await call('POST', `/buildings/${id}/publish`, unverified.token);
      expect(again.body.data.outcome).toBe('pending');
      expect(await db('audit_log').where({ object_id: id, action: 'building.pending' }).count('* as n').first()).toMatchObject({ n: '1' });

      // Another blocker keeps it a refusal, not Pending
      await removeOnePhoto(typeId, unverified.id);
      const refused = await call('POST', `/buildings/${id}/publish`, unverified.token);
      expect(refused.status).toBe(409);
      await db('photos').where({ space_type_id: typeId }).update({ removed_at: null, removed_by: null });

      await setVerified(unverified.id);
      const published = await call('POST', `/buildings/${id}/publish`, unverified.token);
      expect(published.status).toBe(200);
      expect(published.body.data).toMatchObject({ outcome: 'published', blockers: [] });
      expect(published.body.data.building.status).toBe('published');
      expect(published.body.data.building.publishedAt).not.toBeNull();
    });
  });

  // ---- published buildings: TX-13 / TX-14 ---------------------------------------------------

  describe('space types on a published building (TX-13, TX-14, FR-AVL-009)', () => {
    let id = '';
    let typeA = '';
    let typeB = '';

    beforeAll(async () => {
      const ready = await readyBuilding(['Type A', 'Type B']);
      id = ready.id;
      [typeA, typeB] = ready.typeIds as [string, string];
      expect((await call('POST', `/buildings/${id}/publish`, landlord.token)).status).toBe(200);
    });

    it('refuses adding a space type without its photos and rolls the insert back', async () => {
      const res = await call('POST', `/buildings/${id}/space-types`, landlord.token, spaceTypeBody('Type C'));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PUBLISH_MINIMUMS');
      expect(res.body.data.blockers).toEqual(['space type "Type C" needs at least 3 photos']);
      expect(res.body.message).toContain('without its photos');
      expect(await db('space_types').where({ building_id: id, name: 'Type C' }).first()).toBeUndefined();
    });

    it('removes a space type: soft-removes it, closes open enquiries, cancels future viewings, writes a removed event', async () => {
      const day = 86_400_000;
      const [open] = await db('enquiries').insert({ space_type_id: typeB, client_id: client.id }).returning('id');
      const [done] = await db('enquiries')
        .insert({ space_type_id: typeB, client_id: client.id, status: 'closed', closed_reason: 'manual', closed_at: new Date('2026-01-01') })
        .returning('id');
      const responded = { responded_by: landlord.id, responded_at: new Date() };
      const viewings = await db('viewing_requests')
        .insert([
          { space_type_id: typeB, client_id: client.id, requested_for: new Date(Date.now() + 2 * day), status: 'requested' },
          { space_type_id: typeB, client_id: client.id, requested_for: new Date(Date.now() + 3 * day), status: 'accepted', ...responded },
          { space_type_id: typeB, client_id: client.id, requested_for: new Date(Date.now() - 2 * day), status: 'requested' },
          { space_type_id: typeB, client_id: client.id, requested_for: new Date(Date.now() + 4 * day), status: 'declined', ...responded },
        ])
        .returning('id');
      const [futureRequested, futureAccepted, past, declined] = viewings.map((v) => v.id as string);

      const res = await call('DELETE', `/space-types/${typeB}`, landlord.token);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: typeB, closedEnquiries: 1, cancelledViewings: 2 });

      const removed = await db('space_types').where({ id: typeB }).first();
      expect(removed).toMatchObject({ removed_by: landlord.id, vacant_count: 2 });
      expect(removed.removed_at).not.toBeNull();

      expect(await db('enquiries').where({ id: open.id }).first()).toMatchObject({ status: 'closed', closed_reason: 'fully_let' });
      expect(await db('enquiries').where({ id: done.id }).first()).toMatchObject({ closed_reason: 'manual' });

      const cancelled = await db('viewing_requests').whereIn('id', [futureRequested!, futureAccepted!]);
      for (const v of cancelled) expect(v).toMatchObject({ status: 'cancelled', cancel_reason: 'fully_let', cancelled_by: landlord.id });
      expect((await db('viewing_requests').where({ id: past }).first()).status).toBe('requested');
      expect((await db('viewing_requests').where({ id: declined }).first()).status).toBe('declined');

      expect(await db('availability_events').where({ space_type_id: typeB, event_type: 'removed' }).first()).toMatchObject({
        old_count: 2,
        new_count: null,
        actor_user_id: landlord.id,
        source: 'maintainer',
      });
      expect(await audit(typeB, 'space_type.remove')).toMatchObject({ building_id: id });

      expect((await call('DELETE', `/space-types/${typeB}`, landlord.token)).body.code).toBe('SPACE_TYPE_REMOVED');
      expect((await call('PATCH', `/space-types/${typeB}`, landlord.token, { version: 1, name: 'x' })).body.code).toBe('SPACE_TYPE_REMOVED');
      const listed = await call('GET', `/buildings/${id}/space-types?includeRemoved=true`, landlord.token);
      expect(listed.body.data.map((s: Body) => s.name).sort()).toEqual(['Type A', 'Type B']);
    });

    it('refuses removing the last live space type of a published building and leaves everything in place', async () => {
      const res = await call('DELETE', `/space-types/${typeA}`, landlord.token);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PUBLISH_MINIMUMS');
      expect(res.body.data.blockers).toEqual(['needs at least one space type']);
      expect((await db('space_types').where({ id: typeA }).first()).removed_at).toBeNull();
      expect(await db('availability_events').where({ space_type_id: typeA, event_type: 'removed' }).first()).toBeUndefined();
    });

    it('restores a removed space type with an explicit count, a fresh confirmation and a restored event', async () => {
      const noCount = await call('POST', `/space-types/${typeB}/restore`, landlord.token, {});
      expect(noCount.status).toBe(400);
      expect((await call('POST', `/space-types/${typeA}/restore`, landlord.token, { vacantCount: 1 })).body.code).toBe('SPACE_TYPE_NOT_REMOVED');

      await db('space_types').where({ id: typeB }).update({ last_confirmed_at: new Date('2026-01-01') });
      const res = await call('POST', `/space-types/${typeB}/restore`, landlord.token, { vacantCount: 4 });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: typeB, vacantCount: 4, removedAt: null, version: 2 });
      expect(new Date(res.body.data.lastConfirmedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect(await db('availability_events').where({ space_type_id: typeB, event_type: 'restored' }).first()).toMatchObject({ new_count: 4 });
    });
  });

  describe('restoring over a name that is now taken (TX-14)', () => {
    it('needs a new name; a live clash is refused, the new name restores', async () => {
      const id = await createBuilding(landlord.token);
      const old = await createSpaceType(landlord.token, id, 'Studio');
      expect((await call('DELETE', `/space-types/${old}`, landlord.token)).status).toBe(200);
      // The name is free again while the old one is removed.
      const replacement = await createSpaceType(landlord.token, id, 'studio');

      const clash = await call('POST', `/space-types/${old}/restore`, landlord.token, { vacantCount: 2 });
      expect(clash.status).toBe(409);
      expect(clash.body.code).toBe('NAME_TAKEN');
      expect(clash.body.message).toContain('new "name"');
      expect((await call('POST', `/space-types/${old}/restore`, landlord.token, { vacantCount: 2, name: 'STUDIO' })).body.code).toBe('NAME_TAKEN');
      expect((await db('space_types').where({ id: old }).first()).removed_at).not.toBeNull();

      const ok = await call('POST', `/space-types/${old}/restore`, landlord.token, { vacantCount: 2, name: 'Studio (old)' });
      expect(ok.status).toBe(200);
      expect(ok.body.data).toMatchObject({ name: 'Studio (old)', vacantCount: 2, removedAt: null });
      expect((await db('space_types').where({ id: replacement }).first()).name).toBe('studio');
      expect((await audit(old, 'space_type.restore')).changes).toMatchObject({ name: 'Studio (old)', previousName: 'Studio' });
    });
  });

  // ---- withdraw / reopen ------------------------------------------------------------------

  describe('withdrawing and reopening (FR-UNT-008, BR-021)', () => {
    it('withdraws without deleting, freezes edits, and reopens as a Draft', async () => {
      const { id, typeIds } = await readyBuilding(['Type A', 'Type B']);
      expect((await call('POST', `/buildings/${id}/publish`, landlord.token)).status).toBe(200);

      const withdrawn = await call('POST', `/buildings/${id}/withdraw`, landlord.token);
      expect(withdrawn.status).toBe(200);
      expect(withdrawn.body.data.status).toBe('withdrawn');
      expect((await audit(id, 'building.withdraw')).changes).toEqual({ from: 'published', to: 'withdrawn' });
      expect(await db('buildings').where({ id }).first()).toMatchObject({ status: 'withdrawn', published_at: expect.any(Date) });
      expect((await db('space_types').where({ building_id: id })).length).toBe(2);

      const edit = await call('PATCH', `/buildings/${id}`, landlord.token, { version: 1, name: 'Nope' });
      expect(edit.status).toBe(409);
      expect(edit.body.code).toBe('BUILDING_WITHDRAWN');
      expect((await call('POST', `/buildings/${id}/space-types`, landlord.token, spaceTypeBody('Late'))).body.code).toBe('BUILDING_WITHDRAWN');
      expect((await call('DELETE', `/space-types/${typeIds[0]}`, landlord.token)).body.code).toBe('BUILDING_WITHDRAWN');
      expect((await call('POST', `/buildings/${id}/publish`, landlord.token)).body.code).toBe('INVALID_TRANSITION');
      expect((await call('POST', `/buildings/${id}/withdraw`, landlord.token)).body.code).toBe('INVALID_TRANSITION');

      const reopened = await call('POST', `/buildings/${id}/reopen`, landlord.token);
      expect(reopened.status).toBe(200);
      expect(reopened.body.data.status).toBe('draft');
      expect((await call('POST', `/buildings/${id}/reopen`, landlord.token)).body.code).toBe('INVALID_TRANSITION');

      // A reopened building passes the gate again and publishes with its first published_at kept
      const republished = await call('POST', `/buildings/${id}/publish`, landlord.token);
      expect(republished.status).toBe(200);
    });

    it('withdraws a Draft and does not allow a suspended building to be moved by a maintainer', async () => {
      const id = await createBuilding(landlord.token);
      expect((await call('POST', `/buildings/${id}/withdraw`, landlord.token)).status).toBe(200);
      expect((await call('POST', `/buildings/${id}/reopen`, landlord.token)).status).toBe(200);

      await db('buildings').where({ id }).update({
        status: 'suspended',
        status_before_suspension: 'draft',
        suspension_cause: 'admin',
        suspended_reason: 'test',
        suspended_at: new Date(),
        suspended_by: admin.id,
      });
      expect((await call('POST', `/buildings/${id}/withdraw`, landlord.token)).body.code).toBe('INVALID_TRANSITION');
      expect((await call('PATCH', `/buildings/${id}`, landlord.token, { version: 1, name: 'x' })).body.code).toBe('BUILDING_SUSPENDED');
      expect((await call('PATCH', `/buildings/${id}`, admin.token, { version: 1, name: 'Admin edit' })).status).toBe(200);
    });
  });

  // ---- my buildings -----------------------------------------------------------------------

  describe('my buildings (FR-RPT-003)', () => {
    it('lists the maintained buildings with vacant counts and days since the last confirmation', async () => {
      const fresh = await createBuilding(agent.token, { managementType: 'landlord', landlordName: 'Mr Otieno' });
      const typeA = await createSpaceType(agent.token, fresh, 'Type A', { vacantCount: 3 });
      const typeB = await createSpaceType(agent.token, fresh, 'Type B', { vacantCount: 0 });
      await db('space_types').where({ id: typeA }).update({ last_confirmed_at: db.raw("now() - interval '5 days 3 hours'") });
      await db('space_types').where({ id: typeB }).update({ last_confirmed_at: db.raw("now() - interval '10 minutes'") });
      const removed = await createSpaceType(agent.token, fresh, 'Gone');
      await call('DELETE', `/space-types/${removed}`, agent.token);

      const res = await call('GET', '/buildings/mine', agent.token);
      expect(res.status).toBe(200);
      const mine = res.body.data.find((b: Body) => b.id === fresh);
      expect(mine).toMatchObject({ name: 'Acacia Court', status: 'draft', version: 1 });
      expect(mine.spaceTypes).toEqual([
        expect.objectContaining({ id: typeA, name: 'Type A', vacantCount: 3, daysSinceConfirmed: 5 }),
        expect.objectContaining({ id: typeB, name: 'Type B', vacantCount: 0, daysSinceConfirmed: 0 }),
      ]);
      // only buildings this user maintains
      expect(res.body.data.every((b: Body) => b.id !== undefined)).toBe(true);
      const others = await call('GET', '/buildings/mine', outsider.token);
      expect(others.body.data.some((b: Body) => b.id === fresh)).toBe(false);

      expect((await call('GET', '/buildings/mine', client.token)).status).toBe(403);
    });
  });

  // ---- concurrency ------------------------------------------------------------------------

  describe('requests racing on one building (design §9.3 lock order)', () => {
    it('lets exactly one of two same-version edits win and the other get a 409', async () => {
      const id = await createBuilding(landlord.token);
      const [a, b] = await Promise.all([
        call('PATCH', `/buildings/${id}`, landlord.token, { version: 1, name: 'Writer A' }),
        call('PATCH', `/buildings/${id}`, landlord.token, { version: 1, name: 'Writer B' }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const loser = a.status === 409 ? a : b;
      expect(loser.body.code).toBe('STALE_VERSION');
      expect((await db('buildings').where({ id }).first()).version).toBe(2);
    }, 30_000);

    it('publishes once when two publishes race, with edits and a contact change in flight, and never deadlocks', async () => {
      for (let round = 0; round < 3; round += 1) {
        const { id, typeIds } = await readyBuilding(['Type A', 'Type B']);
        const results = await Promise.all([
          call('POST', `/buildings/${id}/publish`, landlord.token),
          call('POST', `/buildings/${id}/publish`, landlord.token),
          call('PATCH', `/buildings/${id}`, landlord.token, { version: 1, name: `Edited ${round}` }),
          call('PATCH', `/buildings/${id}`, landlord.token, { version: 1, description: 'Edited too' }),
          call('PATCH', `/space-types/${typeIds[0]}`, landlord.token, { version: 1, rentAmount: 17000 }),
          call('PUT', `/buildings/${id}/contact`, landlord.token, { userId: landlord.id }),
          call('GET', '/buildings/mine', landlord.token),
        ]);
        const [p1, p2, e1, e2, st, contact, mine] = results;

        expect(results.every((r) => r.status < 500)).toBe(true);
        expect([p1!.status, p2!.status].sort()).toEqual([200, 409]);
        expect([p1, p2].find((p) => p!.status === 409)!.body.code).toBe('ALREADY_PUBLISHED');
        expect([e1!.status, e2!.status].sort()).toEqual([200, 409]);
        expect(st!.status).toBe(200);
        expect(contact!.status).toBe(200);
        expect(mine!.status).toBe(200);

        const building = await db('buildings').where({ id }).first();
        expect(building.status).toBe('published');
        const events = await db('availability_events').whereIn('space_type_id', typeIds).where({ event_type: 'published' });
        expect(events.length).toBe(2);
      }
    }, 60_000);

    it('keeps a published building complete whatever order a publish and space-type changes land in', async () => {
      for (let round = 0; round < 3; round += 1) {
        const { id, typeIds } = await readyBuilding(['Type A', 'Type B']);
        const results = await Promise.all([
          call('POST', `/buildings/${id}/publish`, landlord.token),
          call('POST', `/buildings/${id}/space-types`, landlord.token, spaceTypeBody('Late 1')),
          call('POST', `/buildings/${id}/space-types`, landlord.token, spaceTypeBody('Late 2')),
          call('DELETE', `/space-types/${typeIds[1]}`, landlord.token),
        ]);
        expect(results.every((r) => r.status < 500)).toBe(true);
        for (const r of results) expect([200, 201, 409]).toContain(r.status);

        const building = await db('buildings').where({ id }).first();
        if (building.status === 'published') {
          const blockers = (await db.raw('SELECT building_publish_blockers(?::uuid) AS b', [id])).rows[0].b as string[];
          expect(blockers).toEqual([]);
        } else {
          expect(building.status).toBe('draft');
        }
      }
    }, 60_000);

    it('lets only one of two concurrent removals through when both would empty a published building', async () => {
      for (let round = 0; round < 3; round += 1) {
        const { id, typeIds } = await readyBuilding(['Type A', 'Type B']);
        expect((await call('POST', `/buildings/${id}/publish`, landlord.token)).status).toBe(200);

        const [a, b] = await Promise.all([
          call('DELETE', `/space-types/${typeIds[0]}`, landlord.token),
          call('DELETE', `/space-types/${typeIds[1]}`, landlord.token),
        ]);
        expect([a.status, b.status].sort()).toEqual([200, 409]);
        expect([a, b].find((r) => r.status === 409)!.body.code).toBe('PUBLISH_MINIMUMS');
        const live = await db('space_types').where({ building_id: id }).whereNull('removed_at');
        expect(live.length).toBe(1);
      }
    }, 60_000);
  });
});
