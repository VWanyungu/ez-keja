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
  setVerified,
  startApp,
  stopApp,
  type Account,
  type Body,
} from './search-fixtures.js';

const PHONE = '+254700100001';

beforeAll(startApp);
afterAll(stopApp);

async function search(query: Record<string, string>, token: string | null = null) {
  return call('GET', `/search/buildings?${new URLSearchParams(query)}`, token);
}

const idsOf = (res: { body: Body }): string[] => res.body.data.items.map((i: Body) => i.id);
const sorted = (ids: string[]) => [...ids].sort();

const suspend = (userId: string) =>
  db('profiles')
    .where({ user_id: userId })
    .update({ account_status: 'suspended', suspended_reason: 'test', suspended_at: db.fn.now() });

describe('Public search (PostgreSQL integration)', () => {
  let landlord: Account;
  let agent: Account;
  let ref: Awaited<ReturnType<typeof referenceData>>;

  beforeAll(async () => {
    landlord = await register('p7s-landlord@example.com', 'landlord', PHONE);
    agent = await register('p7s-agent@example.com', 'agent', '+254700100002');
    ref = await referenceData();
  });

  const vacant = (extra: Record<string, unknown> = {}) => ({
    categoryId: ref.categoryA,
    currencyId: ref.kes,
    vacant: 2,
    ...extra,
  });

  describe('which buildings appear (BR-002, FR-SRC-001)', () => {
    it('lists only Published buildings with a live Vacant space type', async () => {
      const areaId = await makeArea('P7 BR-002');
      const shown = await seedBuilding({ areaId, listerId: landlord.id, types: [vacant()] });
      const fullyLet = await seedBuilding({ areaId, listerId: landlord.id, types: [vacant({ vacant: 0 })] });
      const removedOnly = await seedBuilding({ areaId, listerId: landlord.id, types: [vacant({ removed: true })] });
      const noTypes = await seedBuilding({ areaId, listerId: landlord.id, types: [] });
      for (const status of ['draft', 'pending', 'withdrawn'] as const) {
        await seedBuilding({ areaId, listerId: landlord.id, status, publishedAt: status === 'withdrawn', types: [vacant()] });
      }
      await seedBuilding({ areaId, listerId: landlord.id, status: 'suspended', types: [vacant()] });

      const res = await search({ areaId });
      expect(res.status).toBe(200);
      expect(idsOf(res)).toEqual([shown.id]);
      expect(idsOf(res)).not.toContain(fullyLet.id);
      expect(idsOf(res)).not.toContain(removedOnly.id);
      expect(idsOf(res)).not.toContain(noTypes.id);
      expect(res.body.data.nextCursor).toBeNull();
    });

    it('answers an empty page for an area with nothing, and works with no location filter at all', async () => {
      const empty = await search({ areaId: await makeArea('P7 Empty') });
      expect(empty.status).toBe(200);
      expect(empty.body.data).toEqual({ items: [], nextCursor: null });
      expect((await search({})).status).toBe(200);
    });
  });

  describe('category filter (FR-SRC-002)', () => {
    it('matches a building only through a Vacant space type in the category', async () => {
      const areaId = await makeArea('P7 Category');
      const b1 = await seedBuilding({ areaId, listerId: landlord.id, types: [vacant({ categoryId: ref.categoryA }), vacant({ categoryId: ref.categoryB, vacant: 0 })] });
      const b2 = await seedBuilding({ areaId, listerId: landlord.id, types: [vacant({ categoryId: ref.categoryB, vacant: 1 })] });
      const b3 = await seedBuilding({ areaId, listerId: landlord.id, types: [vacant({ categoryId: ref.categoryA, vacant: 0 }), vacant({ categoryId: ref.categoryB, vacant: 1 })] });

      expect(idsOf(await search({ areaId, categoryId: ref.categoryA }))).toEqual([b1.id]);
      expect(sorted(idsOf(await search({ areaId, categoryId: ref.categoryB })))).toEqual(sorted([b2.id, b3.id]));
    });
  });

  describe('rent and currency filters (FR-SRC-003)', () => {
    let areaId: string;
    let r1: string;
    let r2: string;
    let r3: string;
    let r4: string;

    beforeAll(async () => {
      areaId = await makeArea('P7 Rent');
      r1 = (await seedBuilding({ areaId, listerId: landlord.id, types: [vacant({ rentAmount: 8000 })] })).id;
      r2 = (await seedBuilding({ areaId, listerId: landlord.id, types: [vacant({ currencyId: ref.usd, rentAmount: 500 })] })).id;
      // A cheap Fully let type must not make the building match a low range.
      r3 = (await seedBuilding({ areaId, listerId: landlord.id, types: [vacant({ rentAmount: 20000 }), vacant({ rentAmount: 5000, vacant: 0 })] })).id;
      r4 = (await seedBuilding({ areaId, listerId: landlord.id, types: [vacant({ rentMode: 'on_interest' })] })).id;
    });

    const kes = (extra: Record<string, string>) => search({ areaId, currencyId: ref.kes, ...extra });

    it('matches Vacant space types priced in that currency within the range', async () => {
      expect(idsOf(await kes({ rentMin: '7000', rentMax: '9500' }))).toEqual([r1]);
      expect(idsOf(await search({ areaId, currencyId: ref.usd, rentMin: '400', rentMax: '600' }))).toEqual([r2]);
      expect(idsOf(await kes({ rentMin: '4000', rentMax: '6000' }))).toEqual([]);
      expect(sorted(idsOf(await kes({})))).toEqual(sorted([r1, r3]));
      expect(idsOf(await kes({ rentMax: '9500' }))).toEqual([r1]);
    });

    it('lets Rent on interest match only when the user opts in', async () => {
      expect(idsOf(await kes({ rentMin: '7000', rentMax: '9500' }))).not.toContain(r4);
      expect(sorted(idsOf(await kes({ rentMin: '7000', rentMax: '9500', includeRentOnInterest: 'true' })))).toEqual(sorted([r1, r4]));
      expect(idsOf(await kes({ rentMin: '4000', rentMax: '6000', includeRentOnInterest: 'true' }))).toEqual([r4]);
      expect(idsOf(await kes({ includeRentOnInterest: 'false' }))).not.toContain(r4);
    });
  });

  describe('verification and management filters (FR-SRC-004, FR-VER-005)', () => {
    it('filters on the building indicator and on the management designation', async () => {
      const areaId = await makeArea('P7 Verified');
      const verified = await seedBuilding({ areaId, listerId: landlord.id, buildingVerified: true, types: [vacant()] });
      const byAgent = await seedBuilding({ areaId, listerId: agent.id, managementType: 'agent', types: [vacant()] });

      expect(idsOf(await search({ areaId, verifiedOnly: 'true' }))).toEqual([verified.id]);
      expect(sorted(idsOf(await search({ areaId, verifiedOnly: 'false' })))).toEqual(sorted([verified.id, byAgent.id]));
      expect(idsOf(await search({ areaId, management: 'agent' }))).toEqual([byAgent.id]);
      expect(idsOf(await search({ areaId, management: 'landlord' }))).toEqual([verified.id]);
    });

    it('keeps the account indicator and the building indicator separate on the card', async () => {
      const areaId = await makeArea('P7 Indicators');
      const verifiedAccount = await register('p7s-vacct@example.com', 'landlord', '+254700100003');
      await setVerified('profiles', verifiedAccount.id);
      const unverifiedAccount = await register('p7s-uacct@example.com', 'landlord', '+254700100004');
      await seedBuilding({ areaId, listerId: verifiedAccount.id, types: [vacant()], name: 'Verified account only' });
      await seedBuilding({ areaId, listerId: unverifiedAccount.id, buildingVerified: true, types: [vacant()], name: 'Verified building only' });

      const items = (await search({ areaId })).body.data.items as Body[];
      const byName = (name: string) => items.find((i) => i.name === name);
      expect(byName('Verified account only').verification).toEqual({ account: 'verified', building: 'unverified' });
      expect(byName('Verified building only').verification).toEqual({ account: 'unverified', building: 'verified' });
    });
  });

  describe('the card (FR-SRC-005, BR-030)', () => {
    it('carries cover photo, area, rent per currency, designation, latest update and the outdated flag, and no phone', async () => {
      const areaId = await makeArea('P7 Card');
      const mixed = await seedBuilding({
        areaId,
        listerId: landlord.id,
        name: 'Mixed currencies',
        types: [
          vacant({ rentAmount: 7000, confirmedAt: daysAgo(1) }),
          vacant({ rentAmount: 9500, name: 'Bigger', confirmedAt: daysAgo(2) }),
          vacant({ currencyId: ref.usd, rentAmount: 50, name: 'Dollar', confirmedAt: daysAgo(3) }),
          vacant({ rentMode: 'on_interest', name: 'Ask', confirmedAt: daysAgo(3) }),
        ],
      });
      const onInterest = await seedBuilding({ areaId, listerId: landlord.id, name: 'Ask only', types: [vacant({ rentMode: 'on_interest' })] });

      const items = (await search({ areaId })).body.data.items as Body[];
      const card = items.find((i) => i.id === mixed.id)!;
      expect(card.coverPhoto.thumb).toContain('/320/');
      expect(card.coverPhoto.medium).toContain('/800/');
      expect(card.area.name).toBe('P7 Card');
      expect(card.rent).toEqual({
        ranges: [
          { currencyId: ref.kes, currencyCode: 'KES', min: 7000, max: 9500 },
          { currencyId: ref.usd, currencyCode: 'USD', min: 50, max: 50 },
        ],
        rentOnInterest: false,
      });
      expect(card.management).toMatchObject({ type: 'landlord', name: 'p7s-landlord', profileUserId: landlord.id });
      expect(card.latestUpdate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      expect(card.outdated).toBe(false);

      expect(items.find((i) => i.id === onInterest.id)!.rent).toEqual({ ranges: [], rentOnInterest: true });
      expect(JSON.stringify(items)).not.toContain(PHONE);
      expect(JSON.stringify(items)).not.toContain('phone');
    });

    it('flags outdated from the building-level rule: only Vacant types count, and one fresh type is enough', async () => {
      const areaId = await makeArea('P7 Outdated');
      const stale = await seedBuilding({ areaId, listerId: landlord.id, types: [vacant({ confirmedAt: daysAgo(9) }), vacant({ confirmedAt: daysAgo(10), name: 'B' })] });
      const oneFresh = await seedBuilding({ areaId, listerId: landlord.id, types: [vacant({ confirmedAt: daysAgo(9) }), vacant({ confirmedAt: daysAgo(1), name: 'B' })] });
      // A Fully let type updated just now does not make a stale building look fresh (BR-030).
      const letIgnored = await seedBuilding({ areaId, listerId: landlord.id, types: [vacant({ confirmedAt: daysAgo(9) }), vacant({ vacant: 0, name: 'B' })] });
      const exactlySeven = await seedBuilding({ areaId, listerId: landlord.id, types: [vacant({ confirmedAt: daysAgo(7 - 1 / 1440) })] });

      const items = (await search({ areaId })).body.data.items as Body[];
      const flag = (id: string) => items.find((i) => i.id === id)!.outdated;
      expect(flag(stale.id)).toBe(true);
      expect(flag(oneFresh.id)).toBe(false);
      expect(flag(letIgnored.id)).toBe(true);
      expect(flag(exactlySeven.id)).toBe(false); // one minute short of 7 days is not outdated
    });
  });

  describe('sorting (FR-SRC-006)', () => {
    let areaId: string;
    const expectedAsc: string[] = [];

    beforeAll(async () => {
      areaId = await makeArea('P7 Sort');
      const make = async (types: Body[]) => (await seedBuilding({ areaId, listerId: landlord.id, types })).id;
      const five = await make([vacant({ rentAmount: 5000 })]);
      const nine = await make([vacant({ rentAmount: 9000 })]);
      const ask = await make([vacant({ rentMode: 'on_interest' })]);
      const seven1 = await make([vacant({ rentAmount: 7000 }), vacant({ rentAmount: 12000, name: 'B' })]);
      const seven2 = await make([vacant({ rentAmount: 7000 })]);
      const sevens = [seven1, seven2].sort().reverse(); // tie: building id descending
      expectedAsc.push(five, ...sevens, nine, ask);
    });

    const base = () => ({ areaId, currencyId: ref.kes, includeRentOnInterest: 'true' });

    async function walk(query: Record<string, string>, limit: number): Promise<string[]> {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 20; guard += 1) {
        const res = await search({ ...query, limit: String(limit), ...(cursor ? { cursor } : {}) });
        expect(res.status).toBe(200);
        seen.push(...idsOf(res));
        cursor = res.body.data.nextCursor;
        if (!cursor) return seen;
      }
      throw new Error('pagination did not end');
    }

    it('refuses a rent sort without a currency', async () => {
      for (const sort of ['rent_asc', 'rent_desc']) {
        const res = await search({ areaId, sort });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('SORT_REQUIRES_CURRENCY');
      }
    });

    it('sorts by lowest Vacant rent, Rent on interest last, ties by id, stable across pages', async () => {
      const asc = await search({ ...base(), sort: 'rent_asc' });
      expect(idsOf(asc)).toEqual(expectedAsc);
      expect(await walk({ ...base(), sort: 'rent_asc' }, 2)).toEqual(expectedAsc);

      // descending: 9000, then the 7000 pair (id descending, as in ascending), then 5000, then on interest
      const expectedDesc = [expectedAsc[3]!, expectedAsc[1]!, expectedAsc[2]!, expectedAsc[0]!, expectedAsc[4]!];
      expect(idsOf(await search({ ...base(), sort: 'rent_desc' }))).toEqual(expectedDesc);
      expect(await walk({ ...base(), sort: 'rent_desc' }, 2)).toEqual(expectedDesc);
    });

    it('does not accept a cursor from the other sort', async () => {
      const page = await search({ areaId, limit: '1' });
      const res = await search({ ...base(), sort: 'rent_asc', cursor: page.body.data.nextCursor ?? 'x' });
      expect(res.status).toBe(400);
    });
  });

  describe('keyset pagination (design 7.4)', () => {
    it('is stable when buildings share the exact timestamp, and keeps microseconds', async () => {
      const areaId = await makeArea('P7 Keyset');
      const make = async (ts: string, n: number) => {
        const ids: string[] = [];
        for (let i = 0; i < n; i += 1) {
          ids.push((await seedBuilding({ areaId, listerId: landlord.id, types: [vacant({ confirmedAt: ts })] })).id);
        }
        return ids.sort().reverse(); // same timestamp: building id descending
      };
      // Seven share one value; three differ from it only in the last microsecond digit.
      const older = await make('2026-11-20T09:00:00.000001+00', 2);
      const tied = await make('2026-11-20T10:00:00.123456+00', 7);
      const newer = await make('2026-11-20T10:00:00.123457+00', 3);
      const expected = [...newer, ...tied, ...older];

      const first = await search({ areaId, limit: '3' });
      expect(JSON.parse(Buffer.from(first.body.data.nextCursor, 'base64url').toString()).t).toContain('.123457');

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res = await search({ areaId, limit: '3', ...(cursor ? { cursor } : {}) });
        seen.push(...idsOf(res));
        cursor = res.body.data.nextCursor;
        pages += 1;
      } while (cursor && pages < 10);
      expect(seen).toEqual(expected);
      expect(new Set(seen).size).toBe(12);
      expect(pages).toBe(4);
    });
  });

  describe('radius search (QP-02)', () => {
    it('keeps buildings inside the exact distance, not just the bounding box', async () => {
      const areaId = await makeArea('P7 Radius', 5, 20);
      const at = (dLat: number, dLng = 0) => seedBuilding({ areaId, listerId: landlord.id, lat: 5 + dLat, lng: 20 + dLng, types: [vacant()] });
      const near = await at(0.01); // about 1.1 km
      const mid = await at(0.04); // about 4.4 km
      const far = await at(0.2); // about 22 km
      // Inside the 2 km bounding box (0.018 deg each way) but 2.5 km away on the diagonal.
      const corner = await at(0.0179, 0.0179 * 1.0);
      const radius = (km: number) => search({ lat: '5', lng: '20', radiusKm: String(km) });

      expect(sorted(idsOf(await radius(2)))).toEqual(sorted([near.id]));
      expect(sorted(idsOf(await radius(5)))).toEqual(sorted([near.id, mid.id, corner.id]));
      expect(sorted(idsOf(await radius(30)))).toEqual(sorted([near.id, mid.id, far.id, corner.id]));
    });

    it('refuses an incomplete radius and area plus radius', async () => {
      const incomplete = await search({ lat: '5', lng: '20' });
      expect(incomplete.status).toBe(400);
      expect(incomplete.body.code).toBe('RADIUS_INCOMPLETE');
      const both = await search({ areaId: generateUuidV7(), lat: '5', lng: '20', radiusKm: '2' });
      expect(both.status).toBe(400);
      expect(both.body.code).toBe('AREA_OR_RADIUS');
    });
  });

  describe('hidden listers (FR-ACC-004)', () => {
    it('hides buildings whose only maintainers are suspended or erased, keeps those with another active one', async () => {
      const areaId = await makeArea('P7 Hidden');
      const sole = await register('p7s-sole@example.com', 'landlord', '+254700100005');
      const erased = await register('p7s-erased@example.com', 'landlord', '+254700100006');
      const shared = await register('p7s-shared@example.com', 'landlord', '+254700100007');
      const soleBuilding = await seedBuilding({ areaId, listerId: sole.id, types: [vacant()] });
      const erasedBuilding = await seedBuilding({ areaId, listerId: erased.id, types: [vacant()] });
      const sharedBuilding = await seedBuilding({ areaId, listerId: shared.id, maintainers: [landlord.id], types: [vacant()] });
      expect(sorted(idsOf(await search({ areaId })))).toEqual(sorted([soleBuilding.id, erasedBuilding.id, sharedBuilding.id]));

      await suspend(sole.id);
      await db('profiles').where({ user_id: erased.id }).update({ erased_at: db.fn.now() });
      await suspend(shared.id);
      expect(idsOf(await search({ areaId }))).toEqual([sharedBuilding.id]);
    });
  });

  describe('sessions (optional auth)', () => {
    it('serves Guests and logged-in users alike, and never downgrades a bad token to Guest', async () => {
      const areaId = await makeArea('P7 Auth');
      await seedBuilding({ areaId, listerId: landlord.id, types: [vacant()] });
      expect((await search({ areaId })).status).toBe(200);
      expect((await search({ areaId }, landlord.token)).status).toBe(200);

      const bad = await search({ areaId }, 'not-a-token');
      expect(bad.status).toBe(401);
      expect(bad.body.code).toBe('INVALID_ACCESS_TOKEN');

      const gone = await register('p7s-gone@example.com', 'client');
      await suspend(gone.id);
      const suspended = await search({ areaId }, gone.token);
      expect(suspended.status).toBe(403);
      expect(suspended.body.code).toBe('ACCOUNT_SUSPENDED');
    });
  });

  describe('validation', () => {
    it('rejects what it does not understand', async () => {
      const cases: Array<Record<string, string>> = [
        { colour: 'red' },
        { areaId: 'nope' },
        { limit: '0' },
        { limit: '51' },
        { rentMin: '5000' }, // no currency
        { includeRentOnInterest: 'true' }, // no currency
        { currencyId: generateUuidV7(), rentMin: '9', rentMax: '1' },
        { management: 'caretaker' },
        { sort: 'newest' },
        { cursor: 'garbage' },
        { verifiedOnly: 'yes' },
        { lat: '95', lng: '20', radiusKm: '2' },
        { lat: '5', lng: '20', radiusKm: '900' },
      ];
      for (const query of cases) {
        const res = await search(query);
        expect({ query, status: res.status }).toEqual({ query, status: 400 });
      }
    });
  });
});
