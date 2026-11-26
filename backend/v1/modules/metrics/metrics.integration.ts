import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Server } from 'node:http';
import { createApp } from '../../../app.js';
import db, { closeDb } from '../../db/knex.js';
import { closeAuthPool } from '../../lib/auth.js';
import { mailTestAddress } from '../../lib/mail-test-address.js';
import { generateUuidV7 } from '../../lib/uuid.js';
import { isoWeekStart, snapshotMetrics } from './snapshots.js';

let server: Server;
let baseUrl: string;
let previousVerifiedRule = 1;
let T0 = new Date(); // set again as the first thing in beforeAll: everything this file registers happens after it

beforeAll(async () => {
  T0 = new Date();
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to bind ephemeral port');
  baseUrl = `http://127.0.0.1:${addr.port}`;
  previousVerifiedRule = ((await db('settings').where({ key: 'require_verified_lister_to_publish' }).first('value')) as { value: number }).value;
  await db('settings').where({ key: 'require_verified_lister_to_publish' }).update({ value: 0 });
});

afterAll(async () => {
  await db('settings').where({ key: 'require_verified_lister_to_publish' }).update({ value: previousVerifiedRule });
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
  const text = await res.text();
  let json: Body = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON (a CSV export)
  }
  return { status: res.status, body: json, text, headers: res.headers };
}

interface Account {
  id: string;
  token: string;
}

let seq = 0;
let phoneSeq = 0;
let landlordsRegistered = 0;
let registered = 0;
const nextPhone = () => `+2547${String((phoneSeq += 1)).padStart(3, '0')}${String(Date.now()).slice(-6)}`;

async function register(role: 'client' | 'landlord' | 'agent', phone = false): Promise<Account> {
  seq += 1;
  const res = await call('POST', '/auth/register', null, {
    email: mailTestAddress(`rpt-${Date.now()}-${seq}`), password: 'password123', displayName: `Report User ${seq}`, role, privacyNoticeAccepted: true,
  });
  expect(res.status).toBe(201);
  registered += 1;
  if (role === 'landlord') landlordsRegistered += 1;
  const account = { id: res.body.data.user.id as string, token: res.body.data.tokens.accessToken as string };
  if (phone) await db('profiles').where({ user_id: account.id }).update({ phone: nextPhone() });
  return account;
}

let admin: Account;
let areaA1 = '';
let areaA2 = '';
let areaA3 = ''; // never gets a building: the "filter with no data" case
let catC1 = '';
let catC2 = '';
let currencyId = '';

async function addPhotos(owner: { buildingId: string; category: 'cover' | 'grounds' | 'surroundings' } | { spaceTypeId: string }, count: number, uploadedBy: string) {
  for (let i = 0; i < count; i += 1) {
    const [file] = await db('files')
      .insert({
        public_id: `test/${generateUuidV7()}`, resource_type: 'image', delivery_type: 'upload', format: 'jpg',
        original_name: 'p.jpg', mime_type: 'image/jpeg', size_bytes: 10, visibility: 'public', uploaded_by: uploadedBy,
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

type Status = 'draft' | 'published' | 'withdrawn' | 'suspended';

/** One complete building (so it can pass the publish gate), then optional extra Vacant space types added in bulk afterwards. */
async function newBuilding(o: {
  name: string; area: string; category: string; lister: Account; agentManaged?: boolean; status: Status;
  fresh?: number; stale?: number;
}): Promise<string> {
  const [b] = await db('buildings')
    .insert({
      name: o.name, area_id: o.area, latitude: -1.28, longitude: 36.82,
      management_type: o.agentManaged ? 'agent' : 'landlord',
      managing_agent_id: o.agentManaged ? o.lister.id : null,
      landlord_name: o.agentManaged ? null : 'Test Landlord',
      lister_id: o.lister.id, created_by: o.lister.id, status: 'draft', contact_user_id: null,
    })
    .returning('id');
  await db('building_maintainers').insert({ building_id: b.id, user_id: o.lister.id, added_by: o.lister.id });
  await db('buildings').where({ id: b.id }).update({ contact_user_id: o.lister.id });
  const [st] = await db('space_types')
    .insert({
      building_id: b.id, name: `${o.name} base`, category_id: o.category, rent_mode: 'fixed', rent_amount: 15000, currency_id: currencyId,
      deposit_amount: 15000, vacant_count: 2, created_by: o.lister.id,
    })
    .returning('id');
  await addPhotos({ buildingId: b.id, category: 'cover' }, 1, o.lister.id);
  await addPhotos({ buildingId: b.id, category: 'grounds' }, 2, o.lister.id);
  await addPhotos({ buildingId: b.id, category: 'surroundings' }, 1, o.lister.id);
  await addPhotos({ spaceTypeId: st.id }, 3, o.lister.id);
  if (o.status !== 'draft') await db('buildings').where({ id: b.id }).update({ status: 'published', published_at: db.fn.now() });
  if (o.status === 'withdrawn') await db('buildings').where({ id: b.id }).update({ status: 'withdrawn' });
  if (o.status === 'suspended') {
    await db('buildings').where({ id: b.id }).update({
      status: 'suspended', status_before_suspension: 'published', suspension_cause: 'admin',
      suspended_reason: 'fixture', suspended_at: db.fn.now(), suspended_by: admin.id,
    });
  }
  // The gate (T5) only runs when the status changes, so the bulk of the space types goes in afterwards.
  const row = (name: string, age: string) => ({
    building_id: b.id, name, category_id: o.category, rent_mode: 'fixed', rent_amount: 1000, currency_id: currencyId,
    deposit_amount: 0, vacant_count: 2, created_by: o.lister.id, last_confirmed_at: db.raw(`now() - interval '${age}'`),
  });
  const rows = [
    ...Array.from({ length: o.fresh ?? 0 }, (_, i) => row(`${o.name} fresh ${i}`, '1 day')),
    ...Array.from({ length: o.stale ?? 0 }, (_, i) => row(`${o.name} stale ${i}`, '10 days')),
  ];
  if (rows.length > 0) await db('space_types').insert(rows);
  return b.id as string;
}

const spaceTypeOf = async (buildingId: string, name: string): Promise<string> =>
  ((await db('space_types').where({ building_id: buildingId, name }).first('id')) as { id: string }).id;

/** A verification case decided `decidedAgo` after being submitted `submittedAgo` ago, written the way T3 expects. */
async function decidedCase(o: { subject: { userId: string } | { buildingId: string }; submittedBy: string; submittedAgo: string; decidedAgo: string; decision: 'approved' | 'rejected' }) {
  const [c] = await db('verification_cases')
    .insert({
      subject_type: 'userId' in o.subject ? 'account' : 'building',
      subject_user_id: 'userId' in o.subject ? o.subject.userId : null,
      subject_building_id: 'buildingId' in o.subject ? o.subject.buildingId : null,
      submitted_by: o.submittedBy,
      submitted_at: db.raw(`now() - interval '${o.submittedAgo}'`),
    })
    .returning('id');
  await db('verification_cases').where({ id: c.id }).update({
    status: o.decision, decided_by: admin.id, decided_at: db.raw(`now() - interval '${o.decidedAgo}'`),
    ...(o.decision === 'rejected' ? { decision_reason: 'fixture' } : {}),
  });
}

// Fixture handles
let L1: Account; // verified lister, landlord-managed B1
let L2: Account; // NOT verified (rejected), agent-managed B2
let B1 = '';
let B2 = '';
let B5 = ''; // area A2
const FROM = new Date(Date.now() - 3 * 86_400_000).toISOString();
const q = (extra: string) => `from=${FROM}&${extra}`;
const metrics = async (qs: string): Promise<Body> => {
  const res = await call('GET', `/admin/metrics?${qs}`, admin.token);
  expect(res.status).toBe(200);
  return res.body.data;
};

beforeAll(async () => {
  const login = await call('POST', '/auth/login', null, { email: 'admin@khunt.local', password: 'password' });
  admin = { id: login.body.data.user.id, token: login.body.data.tokens.accessToken };

  const mk = async (name: string) =>
    ((await db('areas').insert({ name, slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${Date.now()}`, centre_lat: -1.28, centre_lng: 36.82 }).returning('id')) as Body[])[0].id as string;
  areaA1 = await mk('Metrics Area One');
  areaA2 = await mk('Metrics Area Two');
  areaA3 = await mk('Metrics Area Empty');
  const cats = (await db('space_categories').where({ is_active: true }).orderBy('id').limit(2).pluck('id')) as string[];
  [catC1, catC2] = [cats[0]!, cats[1]!];
  currencyId = (await db('currencies').where({ is_active: true }).first('id')).id;

  L1 = await register('landlord', true);
  L2 = await register('landlord', true);
  const [c1, c2, c3] = [await register('client'), await register('client'), await register('client')];

  // B1: lister L1, landlord-managed, category C1: 40 Vacant types, 30 fresh (1 day) and 10 stale (10 days).
  B1 = await newBuilding({ name: 'B1', area: areaA1, category: catC1, lister: L1, status: 'published', fresh: 29, stale: 10 });
  // B2: lister L2, agent-managed, category C2: 60 Vacant types, 30 fresh and 30 stale.
  B2 = await newBuilding({ name: 'B2', area: areaA1, category: catC2, lister: L2, agentManaged: true, status: 'published', fresh: 29, stale: 30 });
  // Together: 100 Vacant space types, 60 updated within 7 days. Noise that must NOT be counted:
  await db('space_types').insert({
    building_id: B1, name: 'Fully let', category_id: catC1, rent_mode: 'fixed', rent_amount: 1000, currency_id: currencyId, deposit_amount: 0, vacant_count: 0, created_by: L1.id,
  });
  await db('space_types').insert({
    building_id: B1, name: 'Removed', category_id: catC1, rent_mode: 'fixed', rent_amount: 1000, currency_id: currencyId, deposit_amount: 0, vacant_count: 3, created_by: L1.id,
    removed_at: db.fn.now(), removed_by: admin.id,
  });
  await newBuilding({ name: 'Draft', area: areaA1, category: catC1, lister: L1, status: 'draft', stale: 5 });
  await newBuilding({ name: 'Suspended', area: areaA1, category: catC1, lister: L1, status: 'suspended', stale: 5 });
  await newBuilding({ name: 'Withdrawn', area: areaA1, category: catC1, lister: L1, status: 'withdrawn', stale: 5 });
  B5 = await newBuilding({ name: 'Other Area', area: areaA2, category: catC1, lister: L1, status: 'published', stale: 5 });

  // Verification: B1 and B2 are Verified buildings; L1 is a Verified lister, L2 is not (rejected).
  await decidedCase({ subject: { userId: L1.id }, submittedBy: L1.id, submittedAgo: '10 hours', decidedAgo: '6 hours', decision: 'approved' }); // 4 h
  await decidedCase({ subject: { userId: L2.id }, submittedBy: L2.id, submittedAgo: '5 hours', decidedAgo: '3 hours', decision: 'rejected' }); // 2 h
  await decidedCase({ subject: { buildingId: B1 }, submittedBy: L1.id, submittedAgo: '9 hours', decidedAgo: '3 hours', decision: 'approved' }); // 6 h
  await decidedCase({ subject: { buildingId: B2 }, submittedBy: L2.id, submittedAgo: '12 hours', decidedAgo: '4 hours', decision: 'approved' }); // 8 h

  // Enquiries two days ago: E1 (B1) 2 h to reply, E2 (B1) 4 h, E3 (B2) 10 h, E4 (B2) never.
  const enquiry = async (building: string, name: string, replyAfter: string | null) => {
    await db('enquiries').insert({
      space_type_id: await spaceTypeOf(building, name), client_id: c1.id,
      status: replyAfter ? 'responded' : 'new',
      created_at: db.raw("now() - interval '2 days'"),
      first_response_at: replyAfter ? db.raw(`now() - interval '2 days' + interval '${replyAfter}'`) : null,
    });
  };
  await enquiry(B1, 'B1 fresh 0', '2 hours');
  await enquiry(B1, 'B1 fresh 1', '4 hours');
  await enquiry(B2, 'B2 fresh 0', '10 hours');
  await enquiry(B2, 'B2 fresh 1', null);
  // Taps: one on a B1 space type, one on B1 as a whole, one in the other area.
  await db('contact_events').insert([
    { building_id: B1, space_type_id: await spaceTypeOf(B1, 'B1 fresh 2') },
    { building_id: B1 },
    { building_id: B5, space_type_id: await spaceTypeOf(B5, 'Other Area base') },
  ]);
  // Reports: two "unavailable" in A1 (B1 as a whole; a B2 space type), one "inaccurate", one in A2.
  await db('reports').insert([
    { building_id: B1, client_id: c1.id, reason: 'unavailable' },
    { space_type_id: await spaceTypeOf(B2, 'B2 fresh 2'), client_id: c2.id, reason: 'unavailable' },
    { building_id: B1, client_id: c3.id, reason: 'inaccurate' },
    { building_id: B5, client_id: c1.id, reason: 'unavailable' },
  ]);
});

// ==============================================================================================
describe('Admin metrics (FR-RPT-001, SRS §10.3) against a hand-built fixture', () => {
  it('needs the Admin role', async () => {
    expect((await call('GET', '/admin/metrics', L1.token)).status).toBe(403);
    expect((await call('GET', '/admin/metrics', null)).status).toBe(401);
  });

  it('RPT-M01 counts Published buildings and their Vacant space types, ignoring draft, suspended, withdrawn, fully let and removed', async () => {
    const m = (await metrics(`areaId=${areaA1}`)).metrics['RPT-M01'];
    expect(m).toEqual({ publishedBuildings: 2, buildingsWithVacancy: 2, vacantSpaceTypes: 100, totalVacantUnits: 200 });
  });

  it('RPT-M02: 100 Vacant space types of which 60 updated within 7 days gives 60%', async () => {
    expect((await metrics(`areaId=${areaA1}`)).metrics['RPT-M02']).toEqual({ vacantSpaceTypes: 100, updatedWithinThreshold: 60, percent: 60 });
  });

  it('RPT-M03 is the median days since the last update', async () => {
    const m = (await metrics(`areaId=${areaA1}`)).metrics['RPT-M03'];
    expect(m).toEqual({ vacantSpaceTypes: 100, medianDays: 1 }); // 60 at 1 day (and 2 at 0) below 40 at 10 days: the 50th/51st are 1 day
  });

  it('RPT-M04 gives BOTH figures: in a Verified building, and lister Verified', async () => {
    const m = (await metrics(`areaId=${areaA1}`)).metrics['RPT-M04'];
    expect(m).toEqual({
      vacantSpaceTypes: 100,
      inVerifiedBuilding: { count: 100, percent: 100 }, // B1 and B2 are both Verified
      listerVerified: { count: 40, percent: 40 }, // only L1 (B1's 40) is a Verified lister
    });
  });

  it('RPT-M05 gives each lister their own compliance, worst first', async () => {
    const m = (await metrics(`areaId=${areaA1}`)).metrics['RPT-M05'];
    expect(m.listers).toEqual([
      { listerId: L2.id, vacantSpaceTypes: 60, updatedWithinThreshold: 30, compliancePercent: 50 },
      { listerId: L1.id, vacantSpaceTypes: 40, updatedWithinThreshold: 30, compliancePercent: 75 },
    ]);
  });

  it('RPT-M06 is (enquiries + tap-to-call) over the Vacant space types, and says how the denominator was found (ASM-15)', async () => {
    const m = (await metrics(q(`areaId=${areaA1}`))).metrics['RPT-M06'];
    // 4 enquiries + 2 taps in the area (the tap in the other area is left out); no snapshot yet, so today's 100.
    expect(m).toEqual({
      enquiries: 4, tapToCallEvents: 2,
      averageVacantSpaceTypes: { value: 100, method: 'current_count', snapshots: 0 },
      perVacantSpaceType: 0.06,
    });
  });

  it('RPT-M07 is the median time to the first reply, over enquiries that got one', async () => {
    const m = (await metrics(q(`areaId=${areaA1}`))).metrics['RPT-M07'];
    expect(m).toEqual({ enquiries: 4, responded: 3, medianSeconds: 14400, medianHours: 4 }); // 2 h, 4 h, 10 h
  });

  it('RPT-M08 counts only "unavailable" reports over the Vacant space types', async () => {
    const m = (await metrics(q(`areaId=${areaA1}`))).metrics['RPT-M08'];
    expect(m).toEqual({ unavailableReports: 2, averageVacantSpaceTypes: { value: 100, method: 'current_count', snapshots: 0 }, ratePercent: 2 });
  });

  it('RPT-M09 counts new registrations and active users by role within the period', async () => {
    const m = (await metrics(`from=${T0.toISOString()}`)).metrics['RPT-M09'];
    expect(m.total).toEqual({ newRegistrations: registered, activeUsers: registered + 1 }); // + the seeded Admin who signed in
    expect(m.roles.client).toEqual({ newRegistrations: registered, activeUsers: registered }); // every account is a client
    expect(m.roles.landlord).toEqual({ newRegistrations: landlordsRegistered, activeUsers: landlordsRegistered });
    expect(m.roles.agent).toEqual({ newRegistrations: 0, activeUsers: 0 });
    expect(m.roles.admin).toEqual({ newRegistrations: 0, activeUsers: 1 });
  });

  it('RPT-M10 is the median Pending-to-decision time, for accounts and for buildings', async () => {
    const both = (await metrics(q(`listerId=${L1.id}`))).metrics['RPT-M10'];
    const lister = ['listerId', 'dateRange'];
    expect(both).toEqual({
      accounts: { decisions: 1, medianHours: 4, filtersApplied: lister },
      buildings: { decisions: 1, medianHours: 6, filtersApplied: lister },
    });
    const l2 = (await metrics(q(`listerId=${L2.id}`))).metrics['RPT-M10'];
    expect(l2).toEqual({
      accounts: { decisions: 1, medianHours: 2, filtersApplied: lister },
      buildings: { decisions: 1, medianHours: 8, filtersApplied: lister },
    });
    const area = (await metrics(q(`areaId=${areaA1}`))).metrics['RPT-M10'];
    expect(area.buildings).toEqual({ decisions: 2, medianHours: 7, filtersApplied: ['areaId', 'dateRange'] }); // 6 h and 8 h
  });

  it('RPT-M10: an area filter changes the building row but not the account row, and each half says what it applied', async () => {
    const inArea = (await metrics(q(`areaId=${areaA1}&managementType=agent`))).metrics['RPT-M10'];
    const empty = (await metrics(q(`areaId=${areaA3}`))).metrics['RPT-M10'];
    expect(inArea.accounts.decisions).toBeGreaterThanOrEqual(2); // L1's and L2's decisions, whatever the area
    expect(inArea.accounts.decisions).toBe(empty.accounts.decisions);
    expect(inArea.accounts.medianHours).toBe(empty.accounts.medianHours);
    expect(inArea.accounts.filtersApplied).toEqual(['dateRange']);
    expect(empty.accounts.filtersApplied).toEqual(['dateRange']);
    expect(inArea.buildings).toEqual({ decisions: 1, medianHours: 8, filtersApplied: ['areaId', 'managementType', 'dateRange'] }); // only B2 is agent-managed
    expect(empty.buildings).toEqual({ decisions: 0, medianHours: null, filtersApplied: ['areaId', 'dateRange'] });
    // The CSV table is unchanged: one row per subject.
    const csv = await call('GET', `/admin/metrics/export?metric=RPT-M10&areaId=${areaA3}&from=${FROM}`, admin.token);
    expect(csv.text.split('\r\n').slice(0, 1)).toEqual(['subject,decisions,median_hours']);
    expect(csv.text.split('\r\n')[2]).toBe('building,0,');
  });

  it('applies each filter only where the metric can honour it, and says which', async () => {
    const data = await metrics(q(`areaId=${areaA1}&categoryId=${catC1}&managementType=landlord&listerId=${L1.id}`));
    // Area, category, management type and lister all narrow RPT-M02 to B1's 40 types.
    expect(data.metrics['RPT-M02']).toEqual({ vacantSpaceTypes: 40, updatedWithinThreshold: 30, percent: 75 });
    const support = data.meta.filterSupport;
    expect(support['RPT-M02']).toEqual({ applied: ['areaId', 'categoryId', 'managementType', 'listerId'], partial: [], ignored: ['dateRange'] });
    expect(support['RPT-M06'].ignored).toEqual([]);
    expect(support['RPT-M09']).toEqual({ applied: ['dateRange'], partial: [], ignored: ['areaId', 'categoryId', 'managementType', 'listerId'] });
    // M10: area and management type narrow the building half only, so they are "partial", not applied.
    expect(support['RPT-M10']).toEqual({ applied: ['listerId', 'dateRange'], partial: ['areaId', 'managementType'], ignored: ['categoryId'] });
    expect(data.meta.pointInTime).toEqual(['RPT-M01', 'RPT-M02', 'RPT-M03', 'RPT-M04', 'RPT-M05']);
    expect(data.filters).toMatchObject({ areaId: areaA1, categoryId: catC1, managementType: 'landlord', listerId: L1.id });
  });

  it('narrows by management type, lister and category on their own', async () => {
    expect((await metrics(`areaId=${areaA1}&managementType=agent`)).metrics['RPT-M02']).toEqual({ vacantSpaceTypes: 60, updatedWithinThreshold: 30, percent: 50 });
    expect((await metrics(`areaId=${areaA1}&listerId=${L1.id}`)).metrics['RPT-M02']).toEqual({ vacantSpaceTypes: 40, updatedWithinThreshold: 30, percent: 75 });
    expect((await metrics(`areaId=${areaA1}&categoryId=${catC2}`)).metrics['RPT-M01'].vacantSpaceTypes).toBe(60);
    // Period metrics follow the filters: only B2 is agent-managed, so only E3 and E4 count.
    expect((await metrics(q(`areaId=${areaA1}&managementType=agent`))).metrics['RPT-M07']).toEqual({ enquiries: 2, responded: 1, medianSeconds: 36000, medianHours: 10 });
    // A category filter keeps taps and reports that name a space type of that category and leaves the building-level ones out.
    expect((await metrics(q(`areaId=${areaA1}&categoryId=${catC1}`))).metrics['RPT-M06']).toMatchObject({ enquiries: 2, tapToCallEvents: 1 });
    expect((await metrics(q(`areaId=${areaA1}&categoryId=${catC2}`))).metrics['RPT-M08']).toMatchObject({ unavailableReports: 1, ratePercent: 1.67 });
  });

  it('a filter with no data gives zeros and nulls, not an error', async () => {
    const data = await metrics(q(`areaId=${areaA3}`));
    expect(data.metrics['RPT-M01']).toEqual({ publishedBuildings: 0, buildingsWithVacancy: 0, vacantSpaceTypes: 0, totalVacantUnits: 0 });
    expect(data.metrics['RPT-M02']).toEqual({ vacantSpaceTypes: 0, updatedWithinThreshold: 0, percent: null });
    expect(data.metrics['RPT-M03']).toEqual({ vacantSpaceTypes: 0, medianDays: null });
    expect(data.metrics['RPT-M04']).toEqual({ vacantSpaceTypes: 0, inVerifiedBuilding: { count: 0, percent: null }, listerVerified: { count: 0, percent: null } });
    expect(data.metrics['RPT-M05']).toEqual({ listers: [] });
    expect(data.metrics['RPT-M06']).toMatchObject({ enquiries: 0, tapToCallEvents: 0, perVacantSpaceType: null });
    expect(data.metrics['RPT-M07']).toEqual({ enquiries: 0, responded: 0, medianSeconds: null, medianHours: null });
    expect(data.metrics['RPT-M08']).toMatchObject({ unavailableReports: 0, ratePercent: null });
    const noUsers = await metrics('from=2000-01-01&to=2000-01-02');
    expect(noUsers.metrics['RPT-M09'].total).toEqual({ newRegistrations: 0, activeUsers: 0 });
    expect(noUsers.metrics['RPT-M10']).toEqual({
      accounts: { decisions: 0, medianHours: null, filtersApplied: ['dateRange'] },
      buildings: { decisions: 0, medianHours: null, filtersApplied: ['dateRange'] },
    });
  });

  it('returns exactly RPT-M01 to M10: no M11 (withdrawn) and no M12 or M13 (ads on hold)', async () => {
    const data = await metrics(`areaId=${areaA1}`);
    expect(Object.keys(data.metrics)).toEqual(['RPT-M01', 'RPT-M02', 'RPT-M03', 'RPT-M04', 'RPT-M05', 'RPT-M06', 'RPT-M07', 'RPT-M08', 'RPT-M09', 'RPT-M10']);
  });

  it('refuses bad filters', async () => {
    for (const qs of ['areaId=nope', 'managementType=owner', 'from=soon', 'from=2026-12-01&to=2026-11-01']) {
      expect((await call('GET', `/admin/metrics?${qs}`, admin.token)).status, qs).toBe(400);
    }
  });
});

// ==============================================================================================
describe('CSV export of metrics (FR-RPT-002)', () => {
  const exportOf = (qs: string) => call('GET', `/admin/metrics/export?${qs}`, admin.token);
  const lastExportLog = async (since: Date): Promise<Body> =>
    (await db('audit_log').where({ action: 'export.run', actor_user_id: admin.id }).where('created_at', '>=', since).orderBy('created_at', 'desc').first());

  it('downloads a text/csv table and logs who exported what, with the filters and the row count', async () => {
    const since = new Date();
    await new Promise((r) => setTimeout(r, 20));
    const res = await exportOf(`metric=RPT-M02&areaId=${areaA1}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('rpt-m02.csv');
    expect(res.text).toBe('vacant_space_types,updated_within_threshold,percent\r\n100,60,60\r\n');
    const log = await lastExportLog(since);
    expect(log).toMatchObject({ actor_type: 'staff', object_type: 'export', object_id: null });
    expect(log.changes).toMatchObject({ export: 'RPT-M02', rowCount: 1, filters: { areaId: areaA1, listerId: null } });
  });

  it('exports the per-lister table and the verified-share table with both figures', async () => {
    const lister = await exportOf(`metric=RPT-M05&areaId=${areaA1}`);
    expect(lister.text).toBe(
      ['lister_id,vacant_space_types,updated_within_threshold,compliance_percent', `${L2.id},60,30,50`, `${L1.id},40,30,75`].join('\r\n') + '\r\n',
    );
    const verified = await exportOf(`metric=RPT-M04&areaId=${areaA1}`);
    expect(verified.text).toBe(
      ['measure,vacant_space_types,verified,percent', 'in_verified_building,100,100,100', 'lister_verified,100,40,40'].join('\r\n') + '\r\n',
    );
  });

  it('gives a headers-only file for zero rows and still logs the export with rowCount 0', async () => {
    const since = new Date();
    await new Promise((r) => setTimeout(r, 20));
    const res = await exportOf(`metric=RPT-M05&areaId=${areaA3}`);
    expect(res.status).toBe(200);
    expect(res.text).toBe('lister_id,vacant_space_types,updated_within_threshold,compliance_percent\r\n');
    expect((await lastExportLog(since)).changes).toMatchObject({ export: 'RPT-M05', rowCount: 0, filters: { areaId: areaA3 } });
  });

  it('writes no personal value into the export log', async () => {
    const since = new Date();
    await new Promise((r) => setTimeout(r, 20));
    await exportOf(`metric=RPT-M09&from=${T0.toISOString()}`);
    const text = JSON.stringify((await lastExportLog(since)).changes);
    expect(text).not.toMatch(/@|\+254/);
  });

  it('refuses unknown, withdrawn and ad metrics, and anyone but an Admin', async () => {
    for (const metric of ['RPT-M11', 'RPT-M12', 'RPT-M13', 'nope', '']) {
      expect((await exportOf(`metric=${metric}`)).status, metric).toBe(400);
    }
    expect((await exportOf('')).status).toBe(400);
    expect((await call('GET', '/admin/metrics/export?metric=RPT-M01', L1.token)).status).toBe(403);
  });
});

// ==============================================================================================
describe('Weekly snapshots (RPT-M02 weekly snapshot)', () => {
  const now = new Date();
  const week = isoWeekStart(now);
  const rowsOf = (date: string): Promise<Body[]> => db('metric_snapshots').where({ snapshot_date: date }).orderBy('metric_code').orderBy('id');
  const slice = (rows: Body[], code: string, where: Record<string, string | null>) =>
    rows.find((r) => r.metric_code === code && Object.entries({ area_id: null, category_id: null, management_type: null, ...where }).every(([k, v]) => r[k] === v));

  it('writes the point-in-time metrics for the week, overall and per area, category and management type', async () => {
    const result = await snapshotMetrics({ now });
    expect(result.snapshotDate).toBe(week);
    expect(result.written).toBeGreaterThan(0);
    expect(result.existing).toBe(0);

    const rows = await rowsOf(week);
    expect(rows).toHaveLength(result.written);
    const m02 = slice(rows, 'RPT-M02', { area_id: areaA1 });
    expect([Number(m02.numerator), Number(m02.denominator), Number(m02.value)]).toEqual([60, 100, 60]);
    const m03 = slice(rows, 'RPT-M03', { area_id: areaA1 });
    expect(Number(m03.value)).toBe(1);
    const m04 = slice(rows, 'RPT-M04', { area_id: areaA1 });
    expect([Number(m04.numerator), Number(m04.denominator), Number(m04.value)]).toEqual([100, 100, 100]);
    const byCategory = slice(rows, 'RPT-M02', { category_id: catC2 });
    expect(Number(byCategory.denominator)).toBeGreaterThanOrEqual(60);
    expect(slice(rows, 'RPT-M02', {})).toBeDefined(); // the all-areas row
    expect(slice(rows, 'RPT-M09', {})).toBeDefined();
    expect(slice(rows, 'RPT-M02', { area_id: areaA3 })).toBeUndefined(); // no Vacant space type: no row
    expect(rows.every((r) => ['RPT-M02', 'RPT-M03', 'RPT-M04', 'RPT-M09'].includes(r.metric_code))).toBe(true);
  });

  it('is idempotent: running it again in the same week writes nothing', async () => {
    const before = (await rowsOf(week)).length;
    const again = await snapshotMetrics({ now: new Date(now.getTime() + 60_000) }); // same ISO week, a minute later
    expect(again.written).toBe(0);
    expect(again.existing).toBe(before);
    expect((await rowsOf(week)).length).toBe(before);
  });

  it('is safe when two runs overlap: one set of rows, no error', async () => {
    const later = new Date(now.getTime() + 21 * 86_400_000); // three weeks on: a week with no rows yet
    const date = isoWeekStart(later);
    expect(await rowsOf(date)).toHaveLength(0);
    const [a, b] = await Promise.all([snapshotMetrics({ now: later }), snapshotMetrics({ now: later })]);
    const total = (await rowsOf(date)).length;
    expect(total).toBeGreaterThan(0);
    expect(a.written + b.written).toBe(total);
    expect(Math.min(a.written, b.written)).toBe(0);
  });

  it('feeds the RPT-M06 and M08 denominator: the mean of the snapshots in the period, instead of today\'s count', async () => {
    const data = await metrics(`areaId=${areaA1}&from=${week}`);
    expect(data.metrics['RPT-M06'].averageVacantSpaceTypes).toEqual({ value: 100, method: 'snapshot_average', snapshots: 1 });
    expect(data.metrics['RPT-M08'].averageVacantSpaceTypes).toEqual({ value: 100, method: 'snapshot_average', snapshots: 1 });
    // A lister filter has no snapshot slice (ASM-15): it falls back to the live count.
    const lister = await metrics(`areaId=${areaA1}&listerId=${L1.id}&from=${week}`);
    expect(lister.metrics['RPT-M06'].averageVacantSpaceTypes).toEqual({ value: 40, method: 'current_count', snapshots: 0 });
  });
});
