import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import type { Server } from 'node:http';
import { createApp } from '../../../app.js';
import db, { closeDb } from '../../db/knex.js';
import { closeAuthPool } from '../../lib/auth.js';
import { outdatedSql } from '../../lib/freshness.js';
import { generateUuidV7 } from '../../lib/uuid.js';
import { expireViewings } from './expire-viewings.js';
import { sendReminders } from './reminders.js';

setDefaultTimeout(60_000);

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

/** Moves a space type's last update into the past (the column is not append-only; events are). */
const backdate = (spaceTypeId: string, interval: string) =>
  db('space_types')
    .where({ id: spaceTypeId })
    .update({ last_confirmed_at: db.raw(`clock_timestamp() - interval '${interval}'`) });

describe('Availability counts, freshness, reminders and follow-ups (PostgreSQL integration)', () => {
  let landlord: Account; // verified, phoned: can publish
  let landlord2: Account; // verified, phoned: can publish
  let outsider: Account; // a landlord who maintains none of these buildings
  let client: Account;
  let admin: Account;
  let areaId = '';
  let categoryId = '';
  let currencyId = '';

  const spaceTypeBody = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    categoryId,
    rentMode: 'fixed',
    rentAmount: 15000,
    currencyId,
    depositAmount: 15000,
    vacantCount: 3,
    ...extra,
  });

  async function createBuilding(token: string): Promise<string> {
    const res = await call('POST', '/buildings', token, {
      name: 'Availability Court',
      areaId,
      latitude: -1.286389,
      longitude: 36.817223,
      description: 'Test building',
      managementType: 'landlord',
    });
    expect(res.status).toBe(201);
    return res.body.data.id;
  }

  async function createSpaceType(token: string, buildingId: string, name: string, extra = {}): Promise<string> {
    const res = await call('POST', `/buildings/${buildingId}/space-types`, token, spaceTypeBody(name, extra));
    expect(res.status).toBe(201);
    return res.body.data.id;
  }

  /** A Draft that satisfies BR-018 for its lister: ready to publish. */
  async function readyBuilding(owner: Account, typeNames: string[], counts: number[] = []) {
    const id = await createBuilding(owner.token);
    await addPhotos({ buildingId: id, category: 'cover' }, 1, owner.id);
    await addPhotos({ buildingId: id, category: 'grounds' }, 2, owner.id);
    await addPhotos({ buildingId: id, category: 'surroundings' }, 1, owner.id);
    const typeIds: string[] = [];
    for (const [i, name] of typeNames.entries()) {
      const typeId = await createSpaceType(owner.token, id, name, { vacantCount: counts[i] ?? 3 });
      await addPhotos({ spaceTypeId: typeId }, 3, owner.id);
      typeIds.push(typeId);
    }
    expect((await call('PUT', `/buildings/${id}/contact`, owner.token, { userId: owner.id })).status).toBe(200);
    return { id, typeIds };
  }

  async function publishedBuilding(owner: Account, typeNames: string[], counts: number[] = []) {
    const built = await readyBuilding(owner, typeNames, counts);
    const res = await call('POST', `/buildings/${built.id}/publish`, owner.token);
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('published');
    return built;
  }

  const spaceType = (id: string) => db('space_types').where({ id }).first();
  const events = (id: string) => db('availability_events').where({ space_type_id: id }).orderBy('created_at').orderBy('id');
  const lastEvent = async (id: string) => (await events(id)).at(-1);

  const put = (token: string | null, id: string, vacantCount: unknown) =>
    call('PUT', `/space-types/${id}/vacant-count`, token, { vacantCount });
  const confirm = (token: string | null, id: string, body?: unknown) =>
    call('POST', `/space-types/${id}/confirm`, token, body ?? {});
  const fullyLet = (token: string | null, id: string) => call('POST', `/space-types/${id}/fully-let`, token);

  async function mine(token: string, buildingId: string): Promise<Body> {
    const res = await call('GET', '/buildings/mine', token);
    expect(res.status).toBe(200);
    return res.body.data.find((b: Body) => b.id === buildingId);
  }

  beforeAll(async () => {
    landlord = await register('avl-landlord@example.com', 'landlord');
    landlord2 = await register('avl-landlord2@example.com', 'landlord');
    outsider = await register('avl-outsider@example.com', 'landlord');
    client = await register('avl-client@example.com', 'client');
    admin = await loginAdmin();

    // The suites share one database and reference.integration.ts leaves freshness_days at 10. The
    // thresholds under test (BR-001, BR-010) are the defaults, so set them rather than rely on order.
    await db('settings').where({ key: 'require_verified_lister_to_publish' }).update({ value: 1 });
    await db('settings').where({ key: 'freshness_days' }).update({ value: 7 });
    await db('settings').where({ key: 'reminder_lead_days' }).update({ value: 1 });
    await db('settings').where({ key: 'reminder_repeat_days' }).update({ value: 7 });
    for (const [account, phone] of [
      [landlord, '+254700000101'],
      [landlord2, '+254700000102'],
    ] as const) {
      await setPhone(account.id, phone);
      await setVerified(account.id);
    }

    const [area] = await db('areas')
      .insert({ name: 'Availability Test Area', slug: 'availability-test-area', centre_lat: -1.28, centre_lng: 36.82 })
      .returning('id');
    areaId = area.id;
    categoryId = (await db('space_categories').where({ is_active: true }).first('id')).id;
    currencyId = (await db('currencies').where({ is_active: true }).first('id')).id;
  });

  // ---- set, confirm, fully let (TX-01) ----------------------------------------------------------

  describe('setting and confirming counts (FR-AVL-001, -003, TX-01)', () => {
    let buildingId = '';
    let typeId = '';
    beforeAll(async () => {
      buildingId = await createBuilding(landlord.token);
      typeId = await createSpaceType(landlord.token, buildingId, 'Bedsitter', { vacantCount: 3 });
    });

    it('confirms "Still N vacant" as it is: a confirmed event, a fresh timestamp, no version bump', async () => {
      await backdate(typeId, '5 days');
      const before = await spaceType(typeId);
      const res = await confirm(landlord.token, typeId);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: typeId,
        buildingId,
        previousCount: 3,
        vacantCount: 3,
        eventType: 'confirmed',
        closedEnquiries: 0,
        cancelledViewings: 0,
      });

      const after = await spaceType(typeId);
      expect(after.vacant_count).toBe(3);
      expect(after.version).toBe(before.version);
      expect(after.last_confirmed_at.getTime()).toBeGreaterThan(before.last_confirmed_at.getTime() + 4 * 86_400_000);
      expect(await lastEvent(typeId)).toMatchObject({
        event_type: 'confirmed',
        old_count: 3,
        new_count: 3,
        actor_user_id: landlord.id,
        acted_as_staff: false,
        source: 'maintainer',
      });
    });

    it('adjusts the count before confirming, sets it directly, and marks it fully let', async () => {
      const adjusted = await confirm(landlord.token, typeId, { vacantCount: 2 });
      expect(adjusted.body.data).toMatchObject({ previousCount: 3, vacantCount: 2, eventType: 'count_changed' });
      expect(await lastEvent(typeId)).toMatchObject({ event_type: 'count_changed', old_count: 3, new_count: 2 });

      expect((await put(landlord.token, typeId, 5)).body.data).toMatchObject({ previousCount: 2, vacantCount: 5 });
      expect((await put(landlord.token, typeId, 5)).body.data.eventType).toBe('confirmed');

      const fully = await fullyLet(landlord.token, typeId);
      expect(fully.status).toBe(200);
      expect(fully.body.data).toMatchObject({ previousCount: 5, vacantCount: 0, eventType: 'count_changed' });
      expect((await spaceType(typeId)).vacant_count).toBe(0);

      // FR-AVL-003: a Fully let space type can be raised again by the same endpoint.
      const raised = await put(landlord.token, typeId, 4);
      expect(raised.body.data).toMatchObject({ previousCount: 0, vacantCount: 4, eventType: 'count_changed' });
    });

    it('refuses counts that are not whole numbers of zero or more', async () => {
      for (const bad of [-1, 1.5, '3', null, 1_000_001]) {
        expect((await put(landlord.token, typeId, bad)).status).toBe(400);
      }
      expect((await call('PUT', `/space-types/${typeId}/vacant-count`, landlord.token, {})).status).toBe(400);
      expect((await confirm(landlord.token, typeId, { vacantCount: -2 })).status).toBe(400);
      expect((await confirm(landlord.token, typeId, { vacantCount: 2, extra: true })).status).toBe(400);
      expect((await spaceType(typeId)).vacant_count).toBe(4);
    });

    it('records an Admin who is not a maintainer as staff (FR-ADM-001)', async () => {
      const res = await put(admin.token, typeId, 6);
      expect(res.status).toBe(200);
      expect(await lastEvent(typeId)).toMatchObject({
        actor_user_id: admin.id,
        acted_as_staff: true,
        source: 'admin',
        new_count: 6,
      });
    });

    it('refuses a non-maintainer on every write with 403, and changes nothing (BR-003)', async () => {
      const before = await spaceType(typeId);
      const eventCount = (await events(typeId)).length;
      for (const stranger of [outsider.token, client.token]) {
        expect((await put(stranger, typeId, 9)).status).toBe(403);
        expect((await confirm(stranger, typeId)).status).toBe(403);
        expect((await fullyLet(stranger, typeId)).status).toBe(403);
        const bulk = await call('POST', '/availability/bulk-confirm', stranger, {
          items: [{ spaceTypeId: typeId, lastConfirmedAt: '2026-01-01T00:00:00.000000Z', vacantCount: 1 }],
        });
        expect(bulk.status).toBe(403);
        expect((await call('GET', `/space-types/${typeId}/availability-events`, stranger)).status).toBe(403);
      }
      for (const [method, path] of [
        ['PUT', `/space-types/${typeId}/vacant-count`],
        ['POST', `/space-types/${typeId}/confirm`],
        ['POST', `/space-types/${typeId}/fully-let`],
        ['POST', '/availability/bulk-confirm'],
        ['GET', `/space-types/${typeId}/availability-events`],
      ] as const) {
        expect((await call(method, path, null, method === 'GET' ? undefined : {})).status).toBe(401);
      }
      const after = await spaceType(typeId);
      expect(after.vacant_count).toBe(before.vacant_count);
      expect(after.last_confirmed_at).toEqual(before.last_confirmed_at);
      expect((await events(typeId)).length).toBe(eventCount);
    });

    it('answers 404 for a removed or unknown space type and 409 for a withdrawn building', async () => {
      const removed = await createSpaceType(landlord.token, buildingId, 'Gone');
      expect((await call('DELETE', `/space-types/${removed}`, landlord.token)).status).toBe(200);
      for (const res of [await put(landlord.token, removed, 2), await confirm(landlord.token, removed), await fullyLet(landlord.token, removed)]) {
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('SPACE_TYPE_NOT_FOUND');
      }
      expect((await put(landlord.token, generateUuidV7(), 2)).status).toBe(404);
      expect((await put(landlord.token, 'not-a-uuid', 2)).status).toBe(400);

      const other = await createBuilding(landlord.token);
      const otherType = await createSpaceType(landlord.token, other, 'Studio');
      expect((await call('POST', `/buildings/${other}/withdraw`, landlord.token)).status).toBe(200);
      const res = await put(landlord.token, otherType, 1);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('BUILDING_WITHDRAWN');
      expect((await put(admin.token, otherType, 1)).status).toBe(409);
    });
  });

  // ---- the >0 to 0 cascade (TX-01, FR-AVL-009, BR-004) -----------------------------------------

  describe('a count falling to 0 closes enquiries and cancels future viewings (FR-AVL-009)', () => {
    let buildingId = '';
    let typeId = '';
    let otherTypeId = '';
    let clients: Account[] = [];
    const rows: Record<string, string> = {};

    const viewing = async (
      spaceTypeId: string,
      clientId: string,
      status: string,
      when: string,
      extra: Record<string, unknown> = {},
    ): Promise<string> => {
      const [row] = await db('viewing_requests')
        .insert({
          space_type_id: spaceTypeId,
          client_id: clientId,
          requested_for: db.raw(`now() + interval '${when}'`),
          status,
          ...extra,
        })
        .returning('id');
      return row.id;
    };
    const responded = { responded_by: null as string | null, responded_at: db.raw('now()') };

    beforeAll(async () => {
      buildingId = await createBuilding(landlord.token);
      typeId = await createSpaceType(landlord.token, buildingId, 'Two bedroom', { vacantCount: 3 });
      otherTypeId = await createSpaceType(landlord.token, buildingId, 'Shop', { vacantCount: 3 });
      clients = await Promise.all(
        ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => register(`avl-cascade-${n}@example.com`, 'client')),
      );
      responded.responded_by = landlord.id;

      const enquiry = async (spaceTypeId: string, clientId: string, extra: Record<string, unknown> = {}) =>
        (await db('enquiries').insert({ space_type_id: spaceTypeId, client_id: clientId, ...extra }).returning('id'))[0].id;
      rows.openNew = await enquiry(typeId, clients[0]!.id);
      rows.openResponded = await enquiry(typeId, clients[1]!.id, { status: 'responded', first_response_at: db.raw('now()') });
      rows.alreadyClosed = await enquiry(typeId, clients[2]!.id, { status: 'closed', closed_reason: 'manual', closed_at: db.raw('now()') });
      rows.otherType = await enquiry(otherTypeId, clients[0]!.id);

      rows.futureRequested = await viewing(typeId, clients[0]!.id, 'requested', '2 days');
      rows.futureAccepted = await viewing(typeId, clients[1]!.id, 'accepted', '3 days', responded);
      rows.futureCounter = await viewing(typeId, clients[3]!.id, 'counter_proposed', '-1 day', { ...responded, counter_for: db.raw("now() + interval '4 days'") });
      rows.pastAccepted = await viewing(typeId, clients[4]!.id, 'accepted', '-2 days', responded);
      rows.pastRequested = await viewing(typeId, clients[5]!.id, 'requested', '-1 day');
      rows.declined = await viewing(typeId, clients[6]!.id, 'declined', '2 days', responded);
      rows.cancelled = await viewing(typeId, clients[2]!.id, 'cancelled', '2 days', { cancelled_at: db.raw('now()'), cancel_reason: 'client' });
      rows.otherViewing = await viewing(otherTypeId, clients[0]!.id, 'requested', '2 days');
    });

    const viewingRow = (id: string) => db('viewing_requests').where({ id }).first();
    const enquiryRow = (id: string) => db('enquiries').where({ id }).first();

    it('leaves enquiries and viewings alone while the count stays above 0', async () => {
      expect((await put(landlord.token, typeId, 1)).body.data).toMatchObject({ closedEnquiries: 0, cancelledViewings: 0 });
      expect((await enquiryRow(rows.openNew!)).status).toBe('new');
      expect((await viewingRow(rows.futureRequested!)).status).toBe('requested');
    });

    it('closes open enquiries and cancels future viewings only, in the same transaction', async () => {
      const notificationsBefore = Number((await db('notifications').count({ n: '*' }).first())!.n);
      const res = await fullyLet(landlord.token, typeId);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ previousCount: 1, vacantCount: 0, closedEnquiries: 2, cancelledViewings: 3 });

      for (const key of ['openNew', 'openResponded']) {
        expect(await enquiryRow(rows[key]!)).toMatchObject({ status: 'closed', closed_reason: 'fully_let' });
        expect((await enquiryRow(rows[key]!)).closed_at).not.toBeNull();
      }
      for (const key of ['futureRequested', 'futureAccepted', 'futureCounter']) {
        expect(await viewingRow(rows[key]!)).toMatchObject({ status: 'cancelled', cancel_reason: 'fully_let', cancelled_by: landlord.id });
        expect((await viewingRow(rows[key]!)).cancelled_at).not.toBeNull();
      }

      // untouched: already closed, past-dated, declined, already cancelled, and other space types
      expect(await enquiryRow(rows.alreadyClosed!)).toMatchObject({ status: 'closed', closed_reason: 'manual' });
      expect((await enquiryRow(rows.otherType!)).status).toBe('new');
      expect((await viewingRow(rows.pastAccepted!)).status).toBe('accepted');
      expect((await viewingRow(rows.pastRequested!)).status).toBe('requested'); // the expiry job's, below
      expect((await viewingRow(rows.declined!)).status).toBe('declined');
      expect(await viewingRow(rows.cancelled!)).toMatchObject({ status: 'cancelled', cancel_reason: 'client' });
      expect((await viewingRow(rows.otherViewing!)).status).toBe('requested');

      // Phase 9 creates the N-08 notifications; this phase creates none.
      expect(Number((await db('notifications').count({ n: '*' }).first())!.n)).toBe(notificationsBefore);
    });

    it('does nothing more when a Fully let space type is marked fully let again', async () => {
      const res = await fullyLet(landlord.token, typeId);
      expect(res.body.data).toMatchObject({ previousCount: 0, vacantCount: 0, eventType: 'confirmed', closedEnquiries: 0, cancelledViewings: 0 });
    });

    it('expires requested viewings whose time has passed, and only those (TX-01 daily job)', async () => {
      const first = await expireViewings();
      expect(first.expired).toBeGreaterThanOrEqual(1);
      expect(await viewingRow(rows.pastRequested!)).toMatchObject({ status: 'cancelled', cancel_reason: 'expired', cancelled_by: null });
      expect((await viewingRow(rows.pastRequested!)).cancelled_at).not.toBeNull();

      expect((await viewingRow(rows.otherViewing!)).status).toBe('requested'); // still in the future
      expect((await viewingRow(rows.pastAccepted!)).status).toBe('accepted'); // answered, so not "expired"
      expect((await viewingRow(rows.declined!)).status).toBe('declined');
      expect(await viewingRow(rows.futureRequested!)).toMatchObject({ cancel_reason: 'fully_let' });

      const second = await expireViewings();
      expect(second.expired).toBe(0);
      expect((await viewingRow(rows.pastRequested!)).cancel_reason).toBe('expired');
    });
  });

  // ---- freshness (BR-001, BR-030) -----------------------------------------------------------------

  describe('freshness (BR-001, BR-030, FR-AVL-005)', () => {
    const outdatedAt = async (id: string, asOf: string): Promise<boolean> => {
      const result = await db.raw(`SELECT ${outdatedSql('st', `'${asOf}'::timestamptz`)} AS outdated FROM space_types st WHERE st.id = ?`, [id]);
      return result.rows[0].outdated;
    };

    it('treats exactly 7 days as not outdated and one microsecond more as outdated', async () => {
      const buildingId = await createBuilding(landlord.token);
      const typeId = await createSpaceType(landlord.token, buildingId, 'Boundary', { vacantCount: 2 });
      await db('space_types').where({ id: typeId }).update({ last_confirmed_at: '2026-03-01 10:00:00.123456+00' });

      expect(await outdatedAt(typeId, '2026-03-08 10:00:00.123455+00')).toBe(false);
      expect(await outdatedAt(typeId, '2026-03-08 10:00:00.123456+00')).toBe(false); // exactly 7 days
      expect(await outdatedAt(typeId, '2026-03-08 10:00:00.123457+00')).toBe(true);
      expect(await outdatedAt(typeId, '2026-03-09 10:00:00+00')).toBe(true);
    });

    it('follows settings.freshness_days and never flags Fully let or removed space types', async () => {
      const buildingId = await createBuilding(landlord.token);
      const typeId = await createSpaceType(landlord.token, buildingId, 'Setting', { vacantCount: 2 });
      await db('space_types').where({ id: typeId }).update({ last_confirmed_at: '2026-03-01 10:00:00+00' });
      try {
        await db('settings').where({ key: 'freshness_days' }).update({ value: 3 });
        expect(await outdatedAt(typeId, '2026-03-04 10:00:00+00')).toBe(false);
        expect(await outdatedAt(typeId, '2026-03-04 10:00:01+00')).toBe(true);
      } finally {
        await db('settings').where({ key: 'freshness_days' }).update({ value: 7 });
      }

      await db('space_types').where({ id: typeId }).update({ vacant_count: 0 });
      expect(await outdatedAt(typeId, '2027-01-01 00:00:00+00')).toBe(false);
      await db('space_types').where({ id: typeId }).update({ vacant_count: 2, removed_at: db.raw('now()'), removed_by: landlord.id });
      expect(await outdatedAt(typeId, '2027-01-01 00:00:00+00')).toBe(false);
    });

    it('reports freshness on /buildings/mine from the helper, with BR-030 for the building', async () => {
      const buildingId = await createBuilding(landlord.token);
      const old = await createSpaceType(landlord.token, buildingId, 'Old', { vacantCount: 2 });
      const fullyLetOld = await createSpaceType(landlord.token, buildingId, 'Let', { vacantCount: 0 });
      await backdate(old, '8 days');
      await backdate(fullyLetOld, '1 minute');

      // The only Vacant space type is stale, so the building is outdated; the Fully let one does not rescue it.
      let building = await mine(landlord.token, buildingId);
      expect(building.freshness).toBe('may_be_outdated');
      const byName = (b: Body, name: string) => b.spaceTypes.find((t: Body) => t.name === name);
      expect(byName(building, 'Old')).toMatchObject({ freshness: 'may_be_outdated', daysSinceConfirmed: 8 });
      expect(byName(building, 'Let').freshness).toBe('not_applicable');
      expect(building.latestUpdate).toBe(byName(building, 'Old').lastConfirmedAt);

      // A fresher Vacant space type makes the building fresh and sets its latest update (BR-030).
      const recent = await createSpaceType(landlord.token, buildingId, 'Recent', { vacantCount: 1 });
      await backdate(recent, '2 days');
      building = await mine(landlord.token, buildingId);
      expect(building.freshness).toBe('fresh');
      expect(building.latestUpdate).toBe(byName(building, 'Recent').lastConfirmedAt);
      expect(byName(building, 'Recent').freshness).toBe('fresh');

      // Confirming the stale one removes the label at once (FR-AVL-005).
      expect((await confirm(landlord.token, old)).status).toBe(200);
      expect(byName(await mine(landlord.token, buildingId), 'Old').freshness).toBe('fresh');

      // A building with no Vacant space type has nothing to be outdated.
      await fullyLet(landlord.token, old);
      await fullyLet(landlord.token, recent);
      building = await mine(landlord.token, buildingId);
      expect(building).toMatchObject({ freshness: 'not_applicable', latestUpdate: null });
    });
  });

  // ---- bulk confirm (TX-02) ---------------------------------------------------------------------

  describe('bulk confirm (FR-AVL-004, TX-02)', () => {
    let buildingId = '';
    let ids: string[] = [];
    const shown = async (token = landlord.token) => {
      const building = await mine(token, buildingId);
      return new Map<string, { lastConfirmedAt: string; vacantCount: number }>(
        building.spaceTypes.map((t: Body) => [t.id, { lastConfirmedAt: t.lastConfirmedAt, vacantCount: t.vacantCount }]),
      );
    };
    const item = (id: string, display: { lastConfirmedAt: string; vacantCount: number }) => ({
      spaceTypeId: id,
      lastConfirmedAt: display.lastConfirmedAt,
      vacantCount: display.vacantCount,
    });
    const bulk = (token: string, items: unknown[]) => call('POST', '/availability/bulk-confirm', token, { items });

    beforeAll(async () => {
      buildingId = await createBuilding(landlord.token);
      ids = [
        await createSpaceType(landlord.token, buildingId, 'Unit A', { vacantCount: 3 }),
        await createSpaceType(landlord.token, buildingId, 'Unit B', { vacantCount: 2 }),
        await createSpaceType(landlord.token, buildingId, 'Unit C', { vacantCount: 4 }),
      ];
      for (const id of ids) await backdate(id, '3 days'); // clock_timestamp() keeps microseconds
    });

    it('confirms what the screen showed, skips the space type that changed, and keeps the 3 -> 2 -> 3 case honest', async () => {
      const [a, b, c] = ids as [string, string, string];
      const display = await shown();
      expect(display.get(a)!.lastConfirmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);

      // Another maintainer changes A from 3 to 2 and back to 3 after the screen loaded.
      expect((await put(landlord.token, a, 2)).status).toBe(200);
      expect((await put(landlord.token, a, 3)).status).toBe(200);
      expect((await spaceType(a)).vacant_count).toBe(3); // the count looks untouched

      const res = await bulk(landlord.token, [item(a, display.get(a)!), item(b, display.get(b)!), item(c, display.get(c)!)]);
      expect(res.status).toBe(200);
      expect(res.body.data.skipped).toEqual([{ spaceTypeId: a, reason: 'CHANGED' }]);
      expect(res.body.data.confirmed.map((r: Body) => r.spaceTypeId).sort()).toEqual([b, c].sort());

      for (const id of [b, c]) {
        expect(await lastEvent(id)).toMatchObject({
          event_type: 'confirmed',
          source: 'bulk_confirm',
          actor_user_id: landlord.id,
          acted_as_staff: false,
          old_count: display.get(id)!.vacantCount,
          new_count: display.get(id)!.vacantCount,
        });
        expect((await spaceType(id)).last_confirmed_at.getTime()).toBeGreaterThan(Date.now() - 60_000);
      }
      expect((await lastEvent(a))!.source).toBe('maintainer'); // no bulk event for the skipped one
    });

    it('accepts the timestamps it returned, so a second bulk confirm round-trips', async () => {
      const display = await shown();
      const res = await bulk(landlord.token, ids.map((id) => item(id, display.get(id)!)));
      expect(res.body.data.skipped).toEqual([]);
      expect(res.body.data.confirmed).toHaveLength(3);
      const returned = new Map<string, string>(res.body.data.confirmed.map((r: Body) => [r.spaceTypeId, r.lastConfirmedAt]));
      const next = await bulk(landlord.token, ids.map((id) => ({ spaceTypeId: id, lastConfirmedAt: returned.get(id), vacantCount: display.get(id)!.vacantCount })));
      expect(next.body.data.confirmed).toHaveLength(3);
    });

    it('skips removed space types and withdrawn buildings, and rejects Fully let and malformed items', async () => {
      const display = await shown();
      const extra = await createSpaceType(landlord.token, buildingId, 'Unit D', { vacantCount: 2 });
      const extraDisplay = (await shown()).get(extra)!;
      expect((await call('DELETE', `/space-types/${extra}`, landlord.token)).status).toBe(200);

      const withdrawn = await createBuilding(landlord.token);
      const inWithdrawn = await createSpaceType(landlord.token, withdrawn, 'Unit E', { vacantCount: 2 });
      const withdrawnDisplay = (await mine(landlord.token, withdrawn)).spaceTypes[0];
      expect((await call('POST', `/buildings/${withdrawn}/withdraw`, landlord.token)).status).toBe(200);

      const res = await bulk(landlord.token, [
        item(extra, extraDisplay),
        { spaceTypeId: inWithdrawn, lastConfirmedAt: withdrawnDisplay.lastConfirmedAt, vacantCount: withdrawnDisplay.vacantCount },
        item(ids[0]!, display.get(ids[0]!)!),
      ]);
      expect(res.status).toBe(200);
      expect(res.body.data.skipped).toEqual(
        expect.arrayContaining([
          { spaceTypeId: extra, reason: 'REMOVED' },
          { spaceTypeId: inWithdrawn, reason: 'BUILDING_UNAVAILABLE' },
        ]),
      );
      expect(res.body.data.confirmed.map((r: Body) => r.spaceTypeId)).toEqual([ids[0]]);

      const good = item(ids[0]!, display.get(ids[0]!)!);
      expect((await bulk(landlord.token, [{ ...good, vacantCount: 0 }])).status).toBe(400); // Fully let is excluded
      expect((await bulk(landlord.token, [{ ...good, lastConfirmedAt: 'yesterday' }])).status).toBe(400);
      expect((await bulk(landlord.token, [good, good])).status).toBe(400);
      expect((await bulk(landlord.token, [])).status).toBe(400);
      expect((await bulk(landlord.token, [{ ...good, spaceTypeId: generateUuidV7() }])).status).toBe(404);
    });

    it('refuses the whole request when any space type is not the caller\'s, and records an Admin as staff', async () => {
      const [a, b] = ids as [string, string];
      const display = await shown();
      const foreign = await createBuilding(landlord2.token);
      const foreignType = await createSpaceType(landlord2.token, foreign, 'Theirs', { vacantCount: 2 });
      const foreignDisplay = (await mine(landlord2.token, foreign)).spaceTypes[0];
      const before = await spaceType(a);

      const refused = await bulk(landlord.token, [
        item(a, display.get(a)!),
        { spaceTypeId: foreignType, lastConfirmedAt: foreignDisplay.lastConfirmedAt, vacantCount: foreignDisplay.vacantCount },
      ]);
      expect(refused.status).toBe(403);
      expect((await spaceType(a)).last_confirmed_at).toEqual(before.last_confirmed_at);

      const byAdmin = await bulk(admin.token, [item(b, display.get(b)!)]);
      expect(byAdmin.body.data.confirmed).toHaveLength(1);
      expect(await lastEvent(b)).toMatchObject({ source: 'bulk_confirm', actor_user_id: admin.id, acted_as_staff: true });
    });
  });

  // ---- history (FR-AVL-008) --------------------------------------------------------------------------

  describe('availability history (FR-AVL-008)', () => {
    let typeId = '';
    beforeAll(async () => {
      const buildingId = await createBuilding(landlord.token);
      typeId = await createSpaceType(landlord.token, buildingId, 'History', { vacantCount: 3 });
      for (const n of [2, 2, 4, 0, 1]) expect((await put(landlord.token, typeId, n)).status).toBe(200);
      expect((await put(admin.token, typeId, 5)).status).toBe(200);
    });

    it('pages newest first with a keyset cursor and shows who acted and whether as staff', async () => {
      const all = await events(typeId);
      expect(all.length).toBe(7); // created + six changes

      const seen: Body[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res: Body = await call('GET', `/space-types/${typeId}/availability-events?limit=3${cursor ? `&cursor=${cursor}` : ''}`, landlord.token);
        expect(res.status).toBe(200);
        seen.push(...res.body.data.items);
        cursor = res.body.data.nextCursor;
        pages += 1;
      } while (cursor);
      expect(pages).toBe(3);
      expect(seen.map((e) => e.id)).toEqual([...all].reverse().map((e) => e.id));
      expect(seen[0]).toMatchObject({ eventType: 'count_changed', newCount: 5, actedAsStaff: true, source: 'admin', actorUserId: admin.id });
      expect(seen[1]).toMatchObject({ actedAsStaff: false, source: 'maintainer', actorName: 'avl-landlord' });
      expect(seen.at(-1)).toMatchObject({ eventType: 'created', oldCount: null, newCount: 3 });
    });

    it('does not skip rows that share a created_at (keyset on created_at and id)', async () => {
      const buildingId = await createBuilding(landlord.token);
      const tied = await createSpaceType(landlord.token, buildingId, 'Ties', { vacantCount: 1 });
      await db('availability_events').insert(
        Array.from({ length: 5 }, (_, i) => ({
          space_type_id: tied,
          event_type: 'confirmed',
          old_count: i,
          new_count: i,
          actor_user_id: landlord.id,
          acted_as_staff: false,
          source: 'maintainer',
          created_at: '2030-01-01 00:00:00.000001+00',
        })),
      );
      const ids = new Set<string>();
      let cursor: string | null = null;
      do {
        const res: Body = await call('GET', `/space-types/${tied}/availability-events?limit=2${cursor ? `&cursor=${cursor}` : ''}`, admin.token);
        for (const e of res.body.data.items) ids.add(e.id);
        cursor = res.body.data.nextCursor;
      } while (cursor);
      expect(ids.size).toBe(6); // the five ties plus the created event
    });

    it('rejects a bad cursor or limit, and keeps the history of a removed space type readable', async () => {
      expect((await call('GET', `/space-types/${typeId}/availability-events?cursor=garbage`, landlord.token)).status).toBe(400);
      expect((await call('GET', `/space-types/${typeId}/availability-events?limit=0`, landlord.token)).status).toBe(400);
      expect((await call('GET', `/space-types/${typeId}/availability-events?limit=101`, landlord.token)).status).toBe(400);

      expect((await call('DELETE', `/space-types/${typeId}`, landlord.token)).status).toBe(200);
      const res = await call('GET', `/space-types/${typeId}/availability-events?limit=1`, landlord.token);
      expect(res.status).toBe(200);
      expect(res.body.data.items[0].eventType).toBe('removed');
    });
  });

  // ---- concurrency ---------------------------------------------------------------------------------

  describe('concurrency (design §9.3)', () => {
    it('serialises two confirmations of the same space type: both succeed, history stays consistent', async () => {
      const buildingId = await createBuilding(landlord.token);
      const typeId = await createSpaceType(landlord.token, buildingId, 'Race', { vacantCount: 3 });

      const [first, second] = await Promise.all([put(landlord.token, typeId, 5), put(landlord.token, typeId, 6)]);
      expect([first.status, second.status]).toEqual([200, 200]);

      const history = (await events(typeId)).slice(1); // after "created"
      expect(history).toHaveLength(2);
      expect(history[0]!.old_count).toBe(3);
      expect(history[1]!.old_count).toBe(history[0]!.new_count); // each saw the other's result under the lock
      expect((await spaceType(typeId)).vacant_count).toBe(history[1]!.new_count);

      const many = await Promise.all(Array.from({ length: 8 }, (_, i) => confirm(landlord.token, typeId, { vacantCount: i + 1 })));
      expect(many.every((r) => r.status === 200)).toBe(true);
      expect((await events(typeId)).length).toBe(3 + 8);
    });

    it('lets confirmations race a publish on the same building without a deadlock', async () => {
      const buildings = await Promise.all(
        [0, 1, 2, 3].map((n) => readyBuilding(n % 2 === 0 ? landlord : landlord2, [`Race A${n}`, `Race B${n}`, `Race C${n}`])),
      );
      const results = await Promise.all(
        buildings.flatMap(({ id, typeIds }, n) => {
          const owner = n % 2 === 0 ? landlord : landlord2;
          return [
            call('POST', `/buildings/${id}/publish`, owner.token),
            ...typeIds.map((typeId, i) => (i === 0 ? confirm(owner.token, typeId) : put(owner.token, typeId, i + 4))),
            bulkOf(owner.token, typeIds),
          ];
        }),
      );
      expect(results.map((r) => r.status)).toEqual(results.map(() => 200));
      for (const { id, typeIds } of buildings) {
        expect((await db('buildings').where({ id }).first()).status).toBe('published');
        for (const typeId of typeIds) {
          expect((await spaceType(typeId)).vacant_count).toBeGreaterThan(0);
          const kinds = (await events(typeId)).map((e) => e.event_type);
          expect(kinds[0]).toBe('created');
          expect(kinds).toContain('published');
        }
      }
    });

    async function bulkOf(token: string, typeIds: string[]) {
      const rows = await db('space_types').whereIn('id', typeIds).select('id', 'vacant_count', db.raw("to_char(last_confirmed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS at"));
      return call('POST', '/availability/bulk-confirm', token, {
        items: rows.map((r) => ({ spaceTypeId: r.id, lastConfirmedAt: r.at, vacantCount: r.vacant_count })),
      });
    }
  });

  // ---- reminders (TX-08, BR-010, FR-AVL-006) ------------------------------------------------------

  describe('reminders (FR-AVL-006, BR-010, TX-08)', () => {
    let p1: { id: string; typeIds: string[] };
    let p2: { id: string; typeIds: string[] };
    let p3: { id: string; typeIds: string[] };
    let draftType = '';

    const remindersFor = (userId: string) => db('notifications').where({ user_id: userId, event_code: 'N-04' }).orderBy('created_at');
    const logFor = (spaceTypeId: string) => db('reminder_log').where({ space_type_id: spaceTypeId }).orderBy('seq');

    beforeAll(async () => {
      p1 = await publishedBuilding(landlord, ['R1 early', 'R1 outdated'], [2, 2]);
      p2 = await publishedBuilding(landlord, ['R2 weekly'], [2]);
      p3 = await publishedBuilding(landlord2, ['R3 outdated', 'R3 fresh', 'R3 fully let'], [2, 2, 2]);
      const draft = await createBuilding(landlord.token);
      draftType = await createSpaceType(landlord.token, draft, 'Draft old', { vacantCount: 2 });

      await backdate(p1.typeIds[0]!, '6 days 12 hours'); // inside the lead window: seq 0
      await backdate(p1.typeIds[1]!, '8 days'); // label appeared: seq 1
      await backdate(p2.typeIds[0]!, '15 days'); // a week after the label: seq 2
      await backdate(p3.typeIds[0]!, '10 days'); // seq 1
      await backdate(p3.typeIds[1]!, '3 days'); // not due
      await backdate(p3.typeIds[2]!, '20 days');
      await db('space_types').where({ id: p3.typeIds[2]! }).update({ vacant_count: 0 }); // Fully let: never reminded
      await backdate(draftType, '30 days'); // unpublished: never reminded
    });

    it('sends each maintainer one combined notification covering all their due space types', async () => {
      const result = await sendReminders();
      expect(result.logged).toBeGreaterThanOrEqual(4);
      expect(result.notificationsCreated).toBeGreaterThanOrEqual(2);

      const forLandlord = await remindersFor(landlord.id);
      expect(forLandlord).toHaveLength(1); // two buildings, three space types, ONE notification
      const payload = forLandlord[0]!.payload;
      expect(payload.count).toBe(3);
      expect(payload.spaceTypes.map((s: Body) => [s.spaceTypeId, s.reminderSeq]).sort()).toEqual(
        [[p1.typeIds[0], 0], [p1.typeIds[1], 1], [p2.typeIds[0], 2]].sort(),
      );
      expect(payload.spaceTypes.find((s: Body) => s.spaceTypeId === p1.typeIds[1])).toMatchObject({
        buildingName: 'Availability Court',
        vacantCount: 2,
        daysSinceConfirmed: 8,
        outdated: true,
      });

      const forLandlord2 = await remindersFor(landlord2.id);
      expect(forLandlord2).toHaveLength(1);
      expect(forLandlord2[0]!.payload.spaceTypes.map((s: Body) => s.spaceTypeId)).toEqual([p3.typeIds[0]]);

      // a pending email delivery per notification, and nothing sent
      for (const notification of [forLandlord[0]!, forLandlord2[0]!]) {
        const deliveries = await db('notification_deliveries').where({ notification_id: notification.id });
        expect(deliveries).toHaveLength(1);
        expect(deliveries[0]).toMatchObject({ channel: 'email', status: 'pending', attempts: 0, sent_at: null });
      }

      // every log row points at the lister's notification; not-due space types have none
      for (const [typeId, seq] of [[p1.typeIds[0], 0], [p1.typeIds[1], 1], [p2.typeIds[0], 2]] as const) {
        const log = await logFor(typeId!);
        expect(log.map((l) => l.seq)).toEqual([seq]);
        expect(log[0]!.notification_id).toBe(forLandlord[0]!.id);
      }
      expect((await logFor(p3.typeIds[0]!))[0]!.notification_id).toBe(forLandlord2[0]!.id);
      for (const never of [p3.typeIds[1]!, p3.typeIds[2]!, draftType]) expect(await logFor(never)).toHaveLength(0);
    });

    it('creates nothing when it runs again', async () => {
      const logsBefore = Number((await db('reminder_log').count({ n: '*' }).first())!.n);
      const again = await sendReminders();
      expect(again).toMatchObject({ logged: 0, notificationsCreated: 0 });
      expect(await remindersFor(landlord.id)).toHaveLength(1);
      expect(await remindersFor(landlord2.id)).toHaveLength(1);
      expect(Number((await db('reminder_log').count({ n: '*' }).first())!.n)).toBe(logsBefore);
    });

    it('skips space types confirmed since the reminder point, and reminds again in the next cycle', async () => {
      const typeId = p3.typeIds[0]!;
      expect((await confirm(landlord2.token, typeId)).status).toBe(200);
      expect((await sendReminders()).logged).toBe(0);
      expect(await remindersFor(landlord2.id)).toHaveLength(1);

      await backdate(typeId, '8 days'); // a new cycle: its own seq 1 is due
      await sendReminders();
      expect(await remindersFor(landlord2.id)).toHaveLength(2);
      expect(await logFor(typeId)).toHaveLength(2); // the old cycle and the new one
    });

    it('creates exactly one notification per lister when two runs overlap (two PM2 instances)', async () => {
      for (const typeId of [p1.typeIds[0]!, p2.typeIds[0]!, p3.typeIds[0]!]) {
        expect((await confirm(typeId === p3.typeIds[0] ? landlord2.token : landlord.token, typeId)).status).toBe(200);
        await backdate(typeId, '8 days');
      }
      const before = [(await remindersFor(landlord.id)).length, (await remindersFor(landlord2.id)).length];

      const results = await Promise.all([sendReminders(), sendReminders(), sendReminders()]);
      const after = [(await remindersFor(landlord.id)).length, (await remindersFor(landlord2.id)).length];
      expect(after).toEqual([before[0]! + 1, before[1]! + 1]);
      expect(results.reduce((sum, r) => sum + r.logged, 0)).toBe(3);
      for (const typeId of [p1.typeIds[0]!, p2.typeIds[0]!, p3.typeIds[0]!]) {
        const cycleLogs = (await logFor(typeId)).filter((l) => l.seq === 1);
        expect(cycleLogs.length).toBeGreaterThanOrEqual(1);
      }
      const duplicates = await db('reminder_log')
        .groupBy('space_type_id', 'cycle_confirmed_at', 'seq')
        .havingRaw('count(*) > 1')
        .select('space_type_id');
      expect(duplicates).toEqual([]);
    });
  });

  // ---- follow-up queue (FR-ADM-002) -------------------------------------------------------------------

  describe('Admin follow-up queue (FR-ADM-002)', () => {
    let q1: { id: string; typeIds: string[] };
    let q2: { id: string; typeIds: string[] };
    const queue = async (): Promise<Body[]> => {
      const res = await call('GET', '/admin/follow-ups', admin.token);
      expect(res.status).toBe(200);
      return res.body.data.filter((b: Body) => [q1.id, q2.id].includes(b.buildingId));
    };
    const post = (token: string | null, spaceTypeId: string, body: unknown) =>
      call('POST', `/admin/space-types/${spaceTypeId}/follow-ups`, token, body);
    const inQueue = async (typeId: string) => (await queue()).flatMap((b) => b.spaceTypes).find((t: Body) => t.id === typeId);

    beforeAll(async () => {
      q1 = await publishedBuilding(landlord, ['Q a', 'Q b', 'Q c', 'Q let'], [3, 2, 2, 2]);
      q2 = await publishedBuilding(landlord2, ['Q d'], [2]);
      await backdate(q1.typeIds[0]!, '20 days');
      await backdate(q1.typeIds[1]!, '9 days');
      await backdate(q1.typeIds[2]!, '2 days'); // fresh: not queued
      await backdate(q1.typeIds[3]!, '40 days');
      await db('space_types').where({ id: q1.typeIds[3]! }).update({ vacant_count: 0 }); // Fully let: not queued
      await backdate(q2.typeIds[0]!, '30 days');
    });

    it('lists stale Vacant space types grouped by building, most overdue first, with contacts', async () => {
      const result = await queue();
      expect(result.map((b) => b.buildingId)).toEqual([q2.id, q1.id]); // 30 days before 20 days
      const first = result[1]!;
      expect(first.spaceTypes.map((t: Body) => [t.name, t.daysSinceLastUpdate])).toEqual([['Q a', 20], ['Q b', 9]]);
      expect(first.spaceTypes[0]).toMatchObject({ vacantCount: 3, unreachable: false, lastFollowUp: null });
      expect(first.lister).toMatchObject({ userId: landlord.id, displayName: 'avl-landlord', email: 'avl-landlord@example.com', phone: '+254700000101' });
      expect(first.designatedContact).toMatchObject({ userId: landlord.id });
      expect(first.noActiveMaintainer).toBe(false);
      expect(result[0]!.lister).toMatchObject({ userId: landlord2.id, phone: '+254700000102' });
    });

    it('is Admin only', async () => {
      for (const token of [landlord.token, client.token]) {
        expect((await call('GET', '/admin/follow-ups', token)).status).toBe(403);
        expect((await post(token, q1.typeIds[0]!, { outcome: 'unreachable' })).status).toBe(403);
      }
      expect((await call('GET', '/admin/follow-ups', null)).status).toBe(401);
      expect((await post(null, q1.typeIds[0]!, { outcome: 'unreachable' })).status).toBe(401);
    });

    it('logs "unreachable" with a note, flags the space type, and leaves it queued with the count untouched', async () => {
      const [a] = q1.typeIds as [string];
      const before = await spaceType(a);
      const res = await post(admin.token, a, { outcome: 'unreachable', note: 'Phone off, tried twice' });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ spaceTypeId: a, outcome: 'unreachable', note: 'Phone off, tried twice', change: null });

      const row = await inQueue(a);
      expect(row).toMatchObject({ unreachable: true, vacantCount: 3 });
      expect(row.lastFollowUp).toMatchObject({ outcome: 'unreachable', note: 'Phone off, tried twice', staffUserId: admin.id });
      const after = await spaceType(a);
      expect(after.last_confirmed_at).toEqual(before.last_confirmed_at);
      expect(after.vacant_count).toBe(3);
      expect((await db('followups').where({ space_type_id: a })).map((f) => f.outcome)).toEqual(['unreachable']);
    });

    it('applies TX-01 as staff for "confirmed", and the space type leaves the queue', async () => {
      const b = q1.typeIds[1]!;
      expect((await post(admin.token, b, { outcome: 'confirmed' })).status).toBe(400); // needs the count
      expect((await post(admin.token, b, { outcome: 'confirmed', vacantCount: 0 })).status).toBe(400);
      expect((await post(admin.token, b, { outcome: 'unreachable', vacantCount: 2 })).status).toBe(400);
      expect((await post(admin.token, b, { outcome: 'called' })).status).toBe(400);
      expect(await inQueue(b)).toBeDefined();

      const res = await post(admin.token, b, { outcome: 'confirmed', vacantCount: 1, note: 'One let last week' });
      expect(res.status).toBe(201);
      expect(res.body.data.change).toMatchObject({ previousCount: 2, vacantCount: 1, eventType: 'count_changed' });
      expect(await lastEvent(b)).toMatchObject({ source: 'follow_up', actor_user_id: admin.id, acted_as_staff: true, new_count: 1 });
      expect((await spaceType(b)).vacant_count).toBe(1);
      expect(await inQueue(b)).toBeUndefined();
      expect((await mine(landlord.token, q1.id)).spaceTypes.find((t: Body) => t.id === b).freshness).toBe('fresh');
    });

    it('applies TX-01 for "fully_let": count 0, enquiries closed, viewings cancelled, out of the queue', async () => {
      const a = q1.typeIds[0]!;
      const [enquiry] = await db('enquiries').insert({ space_type_id: a, client_id: client.id }).returning('id');
      const [viewing] = await db('viewing_requests')
        .insert({ space_type_id: a, client_id: client.id, requested_for: db.raw("now() + interval '3 days'") })
        .returning('id');

      const res = await post(admin.token, a, { outcome: 'fully_let', note: 'Let to a tenant' });
      expect(res.status).toBe(201);
      expect(res.body.data.change).toMatchObject({ previousCount: 3, vacantCount: 0, closedEnquiries: 1, cancelledViewings: 1 });
      expect((await spaceType(a)).vacant_count).toBe(0);
      expect(await db('enquiries').where({ id: enquiry.id }).first()).toMatchObject({ status: 'closed', closed_reason: 'fully_let' });
      expect(await db('viewing_requests').where({ id: viewing.id }).first()).toMatchObject({ status: 'cancelled', cancel_reason: 'fully_let' });
      expect(await lastEvent(a)).toMatchObject({ source: 'follow_up', acted_as_staff: true, new_count: 0 });
      expect(await inQueue(a)).toBeUndefined();
      expect((await db('followups').where({ space_type_id: a }).orderBy('created_at')).map((f) => f.outcome)).toEqual(['unreachable', 'fully_let']);
    });

    it('clears the unreachable flag once the lister confirms, but keeps the note as history', async () => {
      const d = q2.typeIds[0]!;
      expect((await post(admin.token, d, { outcome: 'unreachable', note: 'No answer' })).status).toBe(201);
      expect(await inQueue(d)).toMatchObject({ unreachable: true });

      expect((await confirm(landlord2.token, d)).status).toBe(200);
      expect(await inQueue(d)).toBeUndefined();
      // Time-travel the whole story: the call was 20 days ago, the confirmation 12, and it went stale again.
      await db('followups').where({ space_type_id: d }).update({ created_at: db.raw("now() - interval '20 days'") });
      await backdate(d, '12 days');
      expect(await inQueue(d)).toMatchObject({ unreachable: false, lastFollowUp: expect.objectContaining({ note: 'No answer' }) });
    });

    it('answers 404 for a removed or unknown space type and 409 for a withdrawn building', async () => {
      const removed = q1.typeIds[2]!;
      expect((await call('DELETE', `/space-types/${removed}`, landlord.token)).status).toBe(200);
      expect((await post(admin.token, removed, { outcome: 'unreachable' })).status).toBe(404);
      expect((await post(admin.token, generateUuidV7(), { outcome: 'unreachable' })).status).toBe(404);

      const withdrawn = await createBuilding(landlord.token);
      const type = await createSpaceType(landlord.token, withdrawn, 'W', { vacantCount: 2 });
      expect((await call('POST', `/buildings/${withdrawn}/withdraw`, landlord.token)).status).toBe(200);
      expect((await post(admin.token, type, { outcome: 'confirmed', vacantCount: 2 })).status).toBe(409);
      expect((await db('followups').where({ space_type_id: type })).length).toBe(0);
    });
  });
});
