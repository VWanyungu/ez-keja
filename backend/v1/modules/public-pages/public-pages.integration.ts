import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import db from '../../db/knex.js';
import { generateUuidV7 } from '../../lib/uuid.js';
import {
  call,
  daysAgo,
  makeArea,
  referenceData,
  register,
  seedBuilding,
  startApp,
  stopApp,
  type Account,
  type Body,
} from '../search/search-fixtures.js';

const LANDLORD_PHONE = '+254700200001';

beforeAll(startApp);
afterAll(stopApp);

const suspend = (userId: string) =>
  db('profiles')
    .where({ user_id: userId })
    .update({ account_status: 'suspended', suspended_reason: 'test', suspended_at: db.fn.now() });

describe('Public pages, lister profiles, contact events and commute (PostgreSQL integration)', () => {
  let landlord: Account;
  let client: Account;
  let areaId: string;
  let ref: Awaited<ReturnType<typeof referenceData>>;

  const type = (extra: Record<string, unknown> = {}) => ({
    categoryId: ref.categoryA,
    currencyId: ref.kes,
    vacant: 2,
    ...extra,
  });
  const building = (extra: Record<string, unknown> = {}) =>
    seedBuilding({ areaId, listerId: landlord.id, types: [type()], ...extra });

  beforeAll(async () => {
    landlord = await register('p7p-landlord@example.com', 'landlord', LANDLORD_PHONE);
    client = await register('p7p-client@example.com', 'client');
    areaId = await makeArea('P7 Pages');
    ref = await referenceData();
  });

  describe('building page (FR-SRC-008)', () => {
    let id: string;
    let typeIds: string[];

    beforeAll(async () => {
      const seeded = await seedBuilding({
        areaId,
        listerId: landlord.id,
        lat: -1.286389,
        lng: 36.817223,
        description: 'Quiet, near the stage',
        grounds: 2,
        surroundings: 1,
        types: [
          type({ name: 'Bedsitter A', rentAmount: 12000, deposit: 12000, vacant: 3, sizeSqm: 25, confirmedAt: daysAgo(2), photos: 3 }),
          type({ name: 'Fully let one', vacant: 0 }),
          type({ name: 'Removed one', removed: true }),
          type({ name: 'Ask USD', currencyId: ref.usd, rentMode: 'on_interest', vacant: 1, confirmedAt: daysAgo(9) }),
        ],
      });
      id = seeded.id;
      typeIds = seeded.typeIds;
    });

    it('lists the photos, designation, indicators, latest update and every live space type, Fully let labelled', async () => {
      const res = await call('GET', `/buildings/${id}/public`, null);
      expect(res.status).toBe(200);
      const page = res.body.data;
      expect(page).toMatchObject({
        id,
        description: 'Quiet, near the stage',
        area: { name: 'P7 Pages' },
        // The pin exactly as stored (BR-019 / G-06 default).
        location: { latitude: -1.286389, longitude: 36.817223 },
        management: { type: 'landlord', name: 'p7p-landlord', profileUserId: landlord.id },
        verification: { account: 'unverified', building: 'unverified' },
        outdated: false, // the latest Vacant update is 2 days old
      });
      expect(page.latestUpdate).toMatch(/\.\d{6}Z$/);
      expect(page.photos.cover.urls.thumb).toContain('/320/');
      expect(page.photos.grounds).toHaveLength(2);
      expect(page.photos.surroundings).toHaveLength(1);
      expect('promotedServices' in page).toBe(false); // advertising is on hold

      expect(page.spaceTypes.map((t: Body) => t.name)).toEqual(['Bedsitter A', 'Fully let one', 'Ask USD']);
      const [a, fullyLet, ask] = page.spaceTypes;
      expect(a).toMatchObject({
        id: typeIds[0],
        rentOnInterest: false,
        rentAmount: 12000,
        depositAmount: 12000,
        currency: { code: 'KES' },
        sizeSqm: 25,
        vacantCount: 3,
        fullyLet: false,
        confirmedDaysAgo: 2,
        outdated: false,
      });
      expect(a.category.code).toBeString();
      expect(a.photo.thumb).toContain('/320/');
      expect(fullyLet).toMatchObject({ vacantCount: 0, fullyLet: true, confirmedDaysAgo: null, outdated: false });
      expect(ask).toMatchObject({ rentOnInterest: true, rentAmount: null, currency: { code: 'USD' }, outdated: true });
    });

    it('masks the phone for a Guest and shows it to a logged-in user (BR-009)', async () => {
      const guest = await call('GET', `/buildings/${id}/public`, null);
      expect(guest.body.data.contact).toEqual({ displayName: 'p7p-landlord', phone: null, phoneRequiresLogin: true });
      expect(JSON.stringify(guest.body)).not.toContain(LANDLORD_PHONE);

      const member = await call('GET', `/buildings/${id}/public`, client.token);
      expect(member.body.data.contact).toEqual({ displayName: 'p7p-landlord', phone: LANDLORD_PHONE, phoneRequiresLogin: false });
    });

    it('refuses a bad token and a suspended account instead of treating them as a Guest', async () => {
      const bad = await call('GET', `/buildings/${id}/public`, 'not-a-token');
      expect(bad.status).toBe(401);
      const gone = await register('p7p-suspended@example.com', 'client');
      await suspend(gone.id);
      const suspended = await call('GET', `/buildings/${id}/public`, gone.token);
      expect(suspended.status).toBe(403);
      expect(suspended.body.code).toBe('ACCOUNT_SUSPENDED');
    });

    it('answers 400 for a malformed id', async () => {
      expect((await call('GET', '/buildings/nope/public', null)).status).toBe(400);
    });

    describe('space-type page (FR-SRC-007)', () => {
      it('shows the space type with its building link, designation and indicators, and the contact per BR-009', async () => {
        const guest = await call('GET', `/space-types/${typeIds[0]}/public`, null);
        expect(guest.status).toBe(200);
        expect(guest.body.data).toMatchObject({
          id: typeIds[0],
          name: 'Bedsitter A',
          sizeSqm: 25,
          rentAmount: 12000,
          depositAmount: 12000,
          vacantCount: 3,
          confirmedDaysAgo: 2,
          fullyLet: false,
          building: { id, name: expect.any(String), area: { name: 'P7 Pages' } },
          management: { type: 'landlord', name: 'p7p-landlord' },
          verification: { account: 'unverified', building: 'unverified' },
          contact: { displayName: 'p7p-landlord', phone: null, phoneRequiresLogin: true },
        });
        expect(guest.body.data.photos).toHaveLength(3);
        expect(JSON.stringify(guest.body)).not.toContain(LANDLORD_PHONE);

        const member = await call('GET', `/space-types/${typeIds[0]}/public`, client.token);
        expect(member.body.data.contact).toEqual({ displayName: 'p7p-landlord', phone: LANDLORD_PHONE, phoneRequiresLogin: false });
      });

      it('gives a Fully let space type no contact actions, and a removed one is not found', async () => {
        for (const token of [null, client.token]) {
          const res = await call('GET', `/space-types/${typeIds[1]}/public`, token);
          expect(res.status).toBe(200);
          expect(res.body.data).toMatchObject({ fullyLet: true, vacantCount: 0, contact: null });
        }
        const removed = await call('GET', `/space-types/${typeIds[2]}/public`, null);
        expect(removed.status).toBe(404);
        expect(removed.body.code).toBe('SPACE_TYPE_NOT_FOUND');
        expect((await call('GET', `/space-types/${generateUuidV7()}/public`, null)).status).toBe(404);
      });
    });
  });

  describe('buildings that are not on display', () => {
    it('answers 410 BUILDING_UNAVAILABLE for a building that was public and is not now', async () => {
      const withdrawn = await building({ status: 'withdrawn', publishedAt: true });
      const suspended = await building({ status: 'suspended', suspendedFrom: 'published' });
      const soleOwner = await register('p7p-sole@example.com', 'landlord', '+254700200002');
      const orphaned = await seedBuilding({ areaId, listerId: soleOwner.id, types: [type()] });
      await suspend(soleOwner.id);

      for (const b of [withdrawn, suspended, orphaned]) {
        for (const path of [`/buildings/${b.id}/public`, `/space-types/${b.typeIds[0]}/public`]) {
          for (const token of [null, client.token]) {
            const res = await call('GET', path, token);
            expect({ path, status: res.status }).toEqual({ path, status: 410 });
            expect(res.body.code).toBe('BUILDING_UNAVAILABLE');
            expect(res.body.message).toBe('This building is no longer available.');
          }
        }
      }
    });

    it('keeps a building with another active maintainer on display when one is suspended', async () => {
      const other = await register('p7p-other@example.com', 'landlord', '+254700200003');
      const shared = await seedBuilding({ areaId, listerId: other.id, maintainers: [landlord.id], types: [type()] });
      await suspend(other.id);
      expect((await call('GET', `/buildings/${shared.id}/public`, null)).status).toBe(200);
    });

    it('looks the same as an unknown building for drafts, pending and never-public ones', async () => {
      const cases = [
        await building({ status: 'draft' }),
        await building({ status: 'pending' }),
        await building({ status: 'withdrawn' }), // withdrawn before it was ever published
        await building({ status: 'suspended', suspendedFrom: 'draft' }),
      ];
      const unknown = await call('GET', `/buildings/${generateUuidV7()}/public`, null);
      expect(unknown.status).toBe(404);
      for (const b of cases) {
        const res = await call('GET', `/buildings/${b.id}/public`, client.token);
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ ...unknown.body });
        expect((await call('GET', `/space-types/${b.typeIds[0]}/public`, null)).status).toBe(404);
      }
    });
  });

  describe('lister profile (FR-ACC-004)', () => {
    let lister: Account;

    beforeAll(async () => {
      lister = await register('p7p-lister@example.com', 'agent', '+254700200010');
      await db('profiles').where({ user_id: lister.id }).update({ agent_type: 'caretaker' });
      const [file] = await db('files')
        .insert({
          public_id: `test/${generateUuidV7()}`,
          resource_type: 'image',
          delivery_type: 'upload',
          format: 'jpg',
          original_name: 'me.jpg',
          mime_type: 'image/jpeg',
          size_bytes: 10,
          visibility: 'public',
          uploaded_by: lister.id,
        })
        .returning('id');
      await db('profiles').where({ user_id: lister.id }).update({ photo_file_id: file.id });
      await seedBuilding({ areaId, listerId: lister.id, managementType: 'agent', types: [type()] });
      await seedBuilding({ areaId, listerId: lister.id, managementType: 'agent', types: [type({ vacant: 0 })] }); // still Published
      await seedBuilding({ areaId, listerId: lister.id, managementType: 'agent', status: 'draft', types: [type()] });
      await seedBuilding({ areaId, listerId: lister.id, managementType: 'agent', status: 'withdrawn', publishedAt: true, types: [type()] });
    });

    it('shows name, photo, type, verification and the Published count, with the phone only to a logged-in user', async () => {
      const guest = await call('GET', `/listers/${lister.id}`, null);
      expect(guest.status).toBe(200);
      expect(guest.body.data).toMatchObject({
        userId: lister.id,
        displayName: 'p7p-lister',
        agentType: 'caretaker',
        accountVerification: 'unverified',
        publishedBuildings: 2,
        phone: null,
        phoneRequiresLogin: true,
      });
      expect(guest.body.data.photo.thumb).toContain('/320/');
      expect(JSON.stringify(guest.body)).not.toContain('+254700200010');

      const member = await call('GET', `/listers/${lister.id}`, client.token);
      expect(member.body.data).toMatchObject({ phone: '+254700200010', phoneRequiresLogin: false });
    });

    it('is 404 for a suspended, erased or non-lister account, and for an unknown id', async () => {
      const suspended = await register('p7p-lsusp@example.com', 'landlord', '+254700200011');
      const erased = await register('p7p-lerased@example.com', 'landlord', '+254700200012');
      await suspend(suspended.id);
      await db('profiles').where({ user_id: erased.id }).update({ erased_at: db.fn.now() });
      for (const id of [suspended.id, erased.id, client.id, generateUuidV7()]) {
        const res = await call('GET', `/listers/${id}`, null);
        expect({ id, status: res.status }).toEqual({ id, status: 404 });
        expect(res.body.code).toBe('LISTER_NOT_FOUND');
      }
      expect((await call('GET', '/listers/nope', null)).status).toBe(400);
    });
  });

  describe('contact events (FR-ENQ-004)', () => {
    it('stores no identifier for a Guest tap and the user for a logged-in tap', async () => {
      const b = await building();
      const guest = await call('POST', `/buildings/${b.id}/contact-events`, null);
      expect(guest.status).toBe(201);
      const member = await call('POST', `/buildings/${b.id}/contact-events`, client.token, { spaceTypeId: b.typeIds[0] });
      expect(member.status).toBe(201);

      const rows = await db('contact_events').where({ building_id: b.id }).orderBy('created_at');
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ user_id: null, space_type_id: null });
      expect(rows[1]).toMatchObject({ user_id: client.id, space_type_id: b.typeIds[0] });

      // The table has no column that could hold an IP address or a user agent.
      const columns = (await db('information_schema.columns').where({ table_name: 'contact_events' }).pluck('column_name')) as string[];
      expect(columns.sort()).toEqual(['building_id', 'created_at', 'id', 'space_type_id', 'user_id']);
    });

    it('refuses buildings that are not on display and space types of another building, recording nothing', async () => {
      const b = await building();
      const other = await building();
      const withdrawn = await building({ status: 'withdrawn', publishedAt: true });
      const draft = await building({ status: 'draft' });
      const removed = await seedBuilding({ areaId, listerId: landlord.id, types: [type(), type({ removed: true, name: 'Gone' })] });
      const before = Number((await db('contact_events').count({ n: '*' }).first())!.n);

      expect((await call('POST', `/buildings/${withdrawn.id}/contact-events`, null)).status).toBe(404);
      expect((await call('POST', `/buildings/${draft.id}/contact-events`, null)).status).toBe(404);
      expect((await call('POST', `/buildings/${generateUuidV7()}/contact-events`, null)).status).toBe(404);
      expect((await call('POST', `/buildings/${b.id}/contact-events`, null, { spaceTypeId: other.typeIds[0] })).status).toBe(404);
      expect((await call('POST', `/buildings/${removed.id}/contact-events`, null, { spaceTypeId: removed.typeIds[1] })).status).toBe(404);

      expect((await call('POST', `/buildings/${b.id}/contact-events`, null, { spaceTypeId: 'nope' })).status).toBe(400);
      expect((await call('POST', `/buildings/${b.id}/contact-events`, null, { phone: '+254700000000' })).status).toBe(400);
      expect((await call('POST', `/buildings/${b.id}/contact-events`, 'not-a-token')).status).toBe(401);

      expect(Number((await db('contact_events').count({ n: '*' }).first())!.n)).toBe(before);
    });
  });

  describe('commute endpoint over HTTP (FR-CMT-005)', () => {
    it('answers 200 "unavailable" when no Maps key is configured, never a 5xx', async () => {
      const saved = process.env.GOOGLE_MAPS_API_KEY;
      delete process.env.GOOGLE_MAPS_API_KEY;
      try {
        const b = await building();
        const res = await call('GET', `/commute?buildingId=${b.id}&destination=${encodeURIComponent('Westlands, Nairobi')}`, null);
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ available: false, notice: 'Commute information unavailable' });
      } finally {
        if (saved !== undefined) process.env.GOOGLE_MAPS_API_KEY = saved;
      }
    });

    it('applies the same visibility rules as the building page, and validates the destination', async () => {
      const withdrawn = await building({ status: 'withdrawn', publishedAt: true });
      const draft = await building({ status: 'draft' });
      const dest = `destination=${encodeURIComponent('CBD')}`;
      const gone = await call('GET', `/commute?buildingId=${withdrawn.id}&${dest}`, null);
      expect(gone.status).toBe(410);
      expect(gone.body.code).toBe('BUILDING_UNAVAILABLE');
      expect((await call('GET', `/commute?buildingId=${draft.id}&${dest}`, null)).status).toBe(404);

      const ok = await building();
      expect((await call('GET', `/commute?buildingId=${ok.id}`, null)).status).toBe(400);
      expect((await call('GET', `/commute?buildingId=${ok.id}&destination=${'x'.repeat(201)}`, null)).status).toBe(400);
      expect((await call('GET', `/commute?buildingId=${ok.id}&${dest}&mode=flying`, null)).status).toBe(400);
    });
  });
});
