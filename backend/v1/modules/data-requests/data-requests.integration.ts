import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Server } from 'node:http';
import { createApp } from '../../../app.js';
import db, { closeDb } from '../../db/knex.js';
import { closeAuthPool } from '../../lib/auth.js';
import { setCloudinaryClient } from '../../lib/cloudinary.js';
import { mailTestAddress } from '../../lib/mail-test-address.js';
import { generateUuidV7 } from '../../lib/uuid.js';
import { createFakeCloudinary } from '../files/fake-cloudinary.js';
import { purgeFiles } from '../files/purge.js';
import { deliverNotifications, type EmailSender } from '../notifications/deliver.js';
import { completeDeletionRequest, setCompletionEmailSender } from './erasure.js';
import { EXPORT_SECTIONS } from './export.js';
import { purgeExpiredAuth } from './purge-expired-auth.js';

// Real mail is never sent: erasure and the delivery worker both get this fake sender.
const mails: Array<{ to: string; subject: string; text: string; idempotencyKey?: string; wasErasedWhenSent: boolean | null }> = [];
let failNextMail = false;
const fakeSender: EmailSender = async (m) => {
  if (failNextMail) {
    failNextMail = false;
    throw Object.assign(new Error(`provider rejected ${m.to}`), { code: 'ECONNRESET' });
  }
  // At send time the address must still belong to a real, not yet erased account (step 2 runs before the transaction).
  const who = (await db('auth_users as u').join('profiles as p', 'p.user_id', 'u.id').where('u.email', m.to).first('p.erased_at')) as { erased_at: Date | null } | undefined;
  mails.push({ to: m.to, subject: m.subject, text: m.text, idempotencyKey: m.idempotencyKey, wasErasedWhenSent: who ? who.erased_at !== null : null });
  return { sent: true, provider: 'gmail' };
};
const fakeCloud = createFakeCloudinary();

let server: Server;
let baseUrl: string;
let previousVerifiedRule = 1;

beforeAll(async () => {
  setCloudinaryClient(fakeCloud.client);
  setCompletionEmailSender(fakeSender);
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to bind ephemeral port');
  baseUrl = `http://127.0.0.1:${addr.port}`;
  // Fixtures build Published buildings directly; BR-005 (verified lister) is not what is tested here.
  previousVerifiedRule = ((await db('settings').where({ key: 'require_verified_lister_to_publish' }).first('value')) as { value: number }).value;
  await db('settings').where({ key: 'require_verified_lister_to_publish' }).update({ value: 0 });
  admin1 = await loginAdmin();
  const [area] = await db('areas')
    .insert({ name: 'Privacy Area', slug: `privacy-area-${Date.now()}`, centre_lat: -1.28, centre_lng: 36.82 })
    .returning('id');
  areaId = area.id;
  categoryId = (await db('space_categories').where({ is_active: true }).first('id')).id;
  currencyId = (await db('currencies').where({ is_active: true }).first('id')).id;
});

afterAll(async () => {
  await db('settings').where({ key: 'require_verified_lister_to_publish' }).update({ value: previousVerifiedRule });
  setCloudinaryClient(null);
  setCompletionEmailSender(null);
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await closeAuthPool();
  await closeDb();
});

// biome-ignore lint/suspicious/noExplicitAny: response bodies are asserted field by field
type Body = any;

async function call(method: string, path: string, token: string | null, body?: unknown, extraHeaders: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'api-v': 'v1',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...extraHeaders,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: Body = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body: json, text, headers: res.headers };
}

interface Account {
  id: string;
  email: string;
  token: string;
  name: string;
}

let seq = 0;
let phoneSeq = 0;
const nextPhone = () => `+2547${String((phoneSeq += 1)).padStart(3, '0')}${String(Date.now()).slice(-6)}`;

async function register(role: 'client' | 'landlord' | 'agent', opts: { phone?: boolean; name?: string } = {}): Promise<Account> {
  seq += 1;
  const email = mailTestAddress(`dsr-${Date.now()}-${seq}`);
  const name = opts.name ?? `Privacy User ${seq}`;
  const res = await call('POST', '/auth/register', null, { email, password: 'password123', displayName: name, role, privacyNoticeAccepted: true });
  expect(res.status).toBe(201);
  const account = { id: res.body.data.user.id as string, email, token: res.body.data.tokens.accessToken as string, name };
  if (opts.phone) await db('profiles').where({ user_id: account.id }).update({ phone: nextPhone() });
  return account;
}

async function loginAdmin(): Promise<Account> {
  const res = await call('POST', '/auth/login', null, { email: 'admin@khunt.local', password: 'password' });
  expect(res.status).toBe(200);
  return { id: res.body.data.user.id, email: 'admin@khunt.local', token: res.body.data.tokens.accessToken, name: 'Admin' };
}

let admin1: Account;
async function makeAdmin(): Promise<Account> {
  const account = await register('client');
  await db('user_roles').insert({ user_id: account.id, role: 'admin', granted_by: admin1.id });
  return account;
}

let areaId = '';
let categoryId = '';
let currencyId = '';

async function addFile(uploadedBy: string, o: { visibility?: 'public' | 'restricted'; name?: string } = {}): Promise<{ id: string; public_id: string }> {
  const restricted = o.visibility === 'restricted';
  const [file] = await db('files')
    .insert({
      public_id: `test/${generateUuidV7()}`,
      resource_type: restricted ? 'raw' : 'image',
      delivery_type: restricted ? 'authenticated' : 'upload',
      format: restricted ? 'pdf' : 'jpg',
      original_name: o.name ?? 'p.jpg',
      mime_type: restricted ? 'application/pdf' : 'image/jpeg',
      size_bytes: 10,
      visibility: o.visibility ?? 'public',
      uploaded_by: uploadedBy,
    })
    .returning(['id', 'public_id']);
  return file;
}

async function addPhotos(owner: { buildingId: string; category: 'cover' | 'grounds' | 'surroundings' } | { spaceTypeId: string }, count: number, uploadedBy: string) {
  for (let i = 0; i < count; i += 1) {
    const file = await addFile(uploadedBy);
    await db('photos').insert({
      building_id: 'buildingId' in owner ? owner.buildingId : null,
      space_type_id: 'spaceTypeId' in owner ? owner.spaceTypeId : null,
      category: 'buildingId' in owner ? owner.category : 'space_type',
      file_id: file.id,
      uploaded_by: uploadedBy,
    });
  }
}

type FixtureStatus = 'draft' | 'pending' | 'published' | 'withdrawn' | 'admin_suspended';

/** A building built straight in SQL, complete enough to pass the publish gate (T5). */
async function newBuilding(o: { name: string; maintainers: Account[]; contact?: Account | null; status?: FixtureStatus }): Promise<string> {
  const lister = o.maintainers[0]!;
  const [b] = await db('buildings')
    .insert({
      name: o.name, area_id: areaId, latitude: -1.28, longitude: 36.82, management_type: 'landlord', landlord_name: 'Test Landlord',
      lister_id: lister.id, created_by: lister.id, status: 'draft',
    })
    .returning('id');
  await db('building_maintainers').insert(o.maintainers.map((m) => ({ building_id: b.id, user_id: m.id, added_by: lister.id })));
  if (o.contact) await db('buildings').where({ id: b.id }).update({ contact_user_id: o.contact.id });
  const [st] = await db('space_types')
    .insert({
      building_id: b.id, name: 'Studio', category_id: categoryId, rent_mode: 'fixed', rent_amount: 15000, currency_id: currencyId,
      deposit_amount: 15000, vacant_count: 2, created_by: lister.id,
    })
    .returning('id');
  await addPhotos({ buildingId: b.id, category: 'cover' }, 1, lister.id);
  await addPhotos({ buildingId: b.id, category: 'grounds' }, 3, lister.id);
  await addPhotos({ buildingId: b.id, category: 'surroundings' }, 1, lister.id);
  await addPhotos({ spaceTypeId: st.id }, 3, lister.id);

  const status = o.status ?? 'draft';
  if (status === 'published' || status === 'admin_suspended') {
    await db('buildings').where({ id: b.id }).update({ status: 'published', published_at: db.fn.now() });
  }
  if (status === 'pending') await db('buildings').where({ id: b.id }).update({ status: 'pending' });
  if (status === 'withdrawn') await db('buildings').where({ id: b.id }).update({ status: 'withdrawn' });
  if (status === 'admin_suspended') {
    await db('buildings').where({ id: b.id }).update({
      status: 'suspended', status_before_suspension: 'published', suspension_cause: 'admin',
      suspended_reason: 'earlier admin decision', suspended_at: db.fn.now(), suspended_by: admin1.id,
    });
  }
  return b.id as string;
}

const building = async (id: string): Promise<Body> => db('buildings').where({ id }).first();
const profile = async (id: string): Promise<Body> => db('profiles').where({ user_id: id }).first();
const authUser = async (id: string): Promise<Body> => db('auth_users').where({ id }).first();
const dsr = async (id: string): Promise<Body> => db('data_subject_requests').where({ id }).first();
const audits = (where: Record<string, unknown>): Promise<Body[]> => db('audit_log').where(where).orderBy('created_at').orderBy('id');
const notifs = (userId: string, code: string): Promise<Body[]> =>
  db('notifications').where({ user_id: userId, event_code: code }).orderBy('created_at').orderBy('id');

const requestData = (user: Account, type: string, note?: string) =>
  call('POST', '/me/data-requests', user.token, note === undefined ? { type } : { type, note });
const start = (admin: Account, id: string) => call('POST', `/admin/data-requests/${id}/start`, admin.token);
const complete = (admin: Account, id: string, outcome?: string) =>
  call('POST', `/admin/data-requests/${id}/complete`, admin.token, outcome === undefined ? {} : { outcome });
const reject = (admin: Account, id: string, outcome?: string) =>
  call('POST', `/admin/data-requests/${id}/reject`, admin.token, outcome === undefined ? {} : { outcome });

/** A request created through the API and moved to the wanted status through the Admin endpoints. */
async function request(user: Account, type: string, upTo: 'open' | 'in_progress' | 'completed', admin = admin1): Promise<string> {
  const res = await requestData(user, type);
  expect(res.status).toBe(201);
  const id = res.body.data.id as string;
  if (upTo !== 'open') expect((await start(admin, id)).status).toBe(200);
  if (upTo === 'completed') expect((await complete(admin, id, 'Done')).status).toBe(200);
  return id;
}

/** Suspends every other active Admin for the duration of `fn`, so "the last active Admin" is exact. */
async function onlyAdmins(keep: string[], fn: () => Promise<void>): Promise<void> {
  const others = (await db('user_roles as r')
    .join('profiles as p', 'p.user_id', 'r.user_id')
    .where('r.role', 'admin')
    .where('p.account_status', 'active')
    .whereNotIn('r.user_id', keep)
    .pluck('r.user_id')) as string[];
  await db('profiles').whereIn('user_id', others).update({ account_status: 'suspended', suspended_reason: 'test', suspended_at: db.fn.now() });
  try {
    await fn();
  } finally {
    await db('profiles').whereIn('user_id', others).update({ account_status: 'active', suspended_reason: null, suspended_at: null });
  }
}

const constraintOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return (err as { constraint?: string }).constraint;
  }
};

// ==============================================================================================
describe('Data subject requests: filing, Admin queue and transitions (FR-PRV-002)', () => {
  let alice: Account;
  let bob: Account;
  let admin2: Account;
  const ids = {} as Record<'access' | 'correction' | 'export' | 'deletion', string>;

  beforeAll(async () => {
    alice = await register('client', { name: 'Alice Requester' });
    bob = await register('client', { name: 'Bob Other' });
    admin2 = await makeAdmin();
  });

  it('lets a signed-in user file each type, with an optional note (201), and refuses a Guest and a bad body', async () => {
    for (const type of ['access', 'correction', 'export', 'deletion'] as const) {
      const res = await requestData(alice, type, type === 'correction' ? 'Please fix my phone number' : undefined);
      expect(res.status, type).toBe(201);
      expect(res.body.data).toMatchObject({ type, status: 'open', completedAt: null, outcome: null });
      ids[type] = res.body.data.id;
    }
    expect((await dsr(ids.correction)).note).toBe('Please fix my phone number');
    expect((await call('POST', '/me/data-requests', null, { type: 'export' })).status).toBe(401);
    for (const body of [{}, { type: 'wipe' }, { type: 'export', userId: bob.id }, { type: 'export', note: 'x'.repeat(1001) }]) {
      expect((await call('POST', '/me/data-requests', alice.token, body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('refuses a second OPEN request of the same type (409), but allows another type', async () => {
    const again = await requestData(alice, 'export');
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('REQUEST_ALREADY_OPEN');
    expect(await db('data_subject_requests').where({ user_id: alice.id, request_type: 'export' })).toHaveLength(1);
    // The same type by someone else is fine.
    expect((await requestData(bob, 'export')).status).toBe(201);
  });

  it('allows a new request of a type once the earlier one is closed', async () => {
    const carol = await register('client');
    const first = await request(carol, 'access', 'open');
    expect((await reject(admin1, first, 'Not needed')).status).toBe(200);
    expect((await requestData(carol, 'access')).status).toBe(201);
  });

  it('acknowledges to the requester and tells every other Admin (N-12), with no personal text in the payload', async () => {
    const ack = (await notifs(alice.id, 'N-12')).filter((n) => n.payload.kind === 'acknowledged');
    expect(ack.map((n) => n.payload.requestType).sort()).toEqual(['access', 'correction', 'deletion', 'export']);
    for (const admin of [admin1, admin2]) {
      const received = (await notifs(admin.id, 'N-12')).filter((n) => n.payload.kind === 'received' && n.payload.requestId === ids.correction);
      expect(received, admin.email).toHaveLength(1);
      expect(received[0].payload).toEqual({ kind: 'received', requestId: ids.correction, requestType: 'correction' });
    }
    expect(JSON.stringify(await notifs(admin1.id, 'N-12'))).not.toContain('Please fix my phone number');
    const delivery = await db('notification_deliveries').where({ notification_id: ack[0].id }).first();
    expect(delivery).toMatchObject({ channel: 'email', status: 'pending' });
  });

  it('shows a user only their own requests, newest first, keyset paged', async () => {
    const mine = await call('GET', '/me/data-requests', alice.token);
    expect(mine.status).toBe(200);
    expect(mine.body.data.items.map((r: Body) => r.id).sort()).toEqual(Object.values(ids).sort());
    expect(mine.body.data.items[0]).not.toHaveProperty('userId');
    expect(mine.body.data.items[0]).not.toHaveProperty('handledBy');

    const page1 = await call('GET', '/me/data-requests?limit=3', alice.token);
    expect(page1.body.data.items).toHaveLength(3);
    const page2 = await call('GET', `/me/data-requests?limit=3&cursor=${page1.body.data.nextCursor}`, alice.token);
    expect(page2.body.data.items).toHaveLength(1);
    expect(page2.body.data.nextCursor).toBeNull();

    const theirs = await call('GET', '/me/data-requests', bob.token);
    expect(theirs.body.data.items.every((r: Body) => !Object.values(ids).includes(r.id))).toBe(true);
    expect((await call('GET', '/me/data-requests', null)).status).toBe(401);
  });

  it('keeps the Admin routes for Admins (403) and answers 404 for an unknown request', async () => {
    expect((await call('GET', '/admin/data-requests', alice.token)).status).toBe(403);
    for (const action of ['start', 'complete', 'reject']) {
      expect((await call('POST', `/admin/data-requests/${ids.access}/${action}`, alice.token, { outcome: 'x' })).status, action).toBe(403);
    }
    expect((await start(admin1, generateUuidV7())).status).toBe(404);
    expect((await call('GET', '/admin/data-requests', null)).status).toBe(401);
  });

  it('lists the open queue oldest first and writes ONE pii.view row per page, with no personal values', async () => {
    const before = (await audits({ action: 'pii.view', object_type: 'data_subject_request' })).length;
    const page1 = await call('GET', '/admin/data-requests?limit=2', admin1.token);
    expect(page1.status).toBe(200);
    expect(page1.body.data.items).toHaveLength(2);
    expect((await audits({ action: 'pii.view', object_type: 'data_subject_request' })).length).toBe(before + 1);

    const all = await call('GET', '/admin/data-requests?limit=100', admin1.token);
    const times = all.body.data.items.map((r: Body) => r.requestedAt);
    expect([...times].sort()).toEqual(times); // oldest first
    expect(all.body.data.items.every((r: Body) => ['open', 'in_progress'].includes(r.status))).toBe(true);
    const mine = all.body.data.items.find((r: Body) => r.id === ids.correction);
    expect(mine).toMatchObject({ userId: alice.id, email: alice.email, displayName: 'Alice Requester', note: 'Please fix my phone number' });

    const page2 = await call('GET', `/admin/data-requests?limit=2&cursor=${page1.body.data.nextCursor}`, admin1.token);
    expect(page2.body.data.items[0].id).not.toBe(page1.body.data.items[0].id);

    const rows = await audits({ action: 'pii.view', object_type: 'data_subject_request', actor_user_id: admin1.id });
    const row = rows[rows.length - 1]!;
    expect(row.actor_type).toBe('staff');
    expect(row.changes).toMatchObject({ view: 'data_request_list', fields: ['email', 'displayName', 'note'] });
    const written = JSON.stringify(rows.map((r) => r.changes));
    for (const secret of [alice.email, 'Alice Requester', 'Please fix my phone number', bob.email]) expect(written).not.toContain(secret);

    expect((await call('GET', '/admin/data-requests?status=nonsense', admin1.token)).status).toBe(400);
    const closed = await call('GET', '/admin/data-requests?status=rejected&type=access', admin1.token);
    expect(closed.body.data.items.every((r: Body) => r.status === 'rejected' && r.type === 'access')).toBe(true);
  });

  it('starts a request once (compare-and-swap): open -> in_progress with handled_by, a second start is 409', async () => {
    const first = await start(admin1, ids.correction);
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ id: ids.correction, status: 'in_progress' });
    expect(await dsr(ids.correction)).toMatchObject({ status: 'in_progress', handled_by: admin1.id, completed_at: null });
    const again = await start(admin2, ids.correction);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_STATE');
    expect((await dsr(ids.correction)).handled_by).toBe(admin1.id);
  });

  it('lets exactly one of two simultaneous starts win', async () => {
    const dave = await register('client');
    const id = await request(dave, 'access', 'open');
    const results = await Promise.all([start(admin1, id), start(admin2, id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('needs an outcome to complete or reject, and completes only from in_progress', async () => {
    for (const fn of [complete, reject]) {
      const res = await fn(admin1, ids.correction);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('OUTCOME_REQUIRED');
    }
    const notStarted = await complete(admin1, ids.access, 'Done'); // still open
    expect(notStarted.status).toBe(409);
    expect(notStarted.body.code).toBe('INVALID_STATE');
    expect((await dsr(ids.access)).status).toBe('open');
  });

  it('completes a correction request: outcome recorded, completed_at set, requester told (N-12), audit written', async () => {
    const res = await complete(admin1, ids.correction, 'Phone number corrected.');
    expect(res.status).toBe(200);
    expect(await dsr(ids.correction)).toMatchObject({ status: 'completed', outcome: 'Phone number corrected.', handled_by: admin1.id });
    expect((await dsr(ids.correction)).completed_at).not.toBeNull();

    const told = (await notifs(alice.id, 'N-12')).filter((n) => n.payload.kind === 'completed');
    expect(told).toHaveLength(1);
    expect(told[0].payload).toMatchObject({ requestId: ids.correction, requestType: 'correction', exportDays: 7 });
    expect(JSON.stringify(told[0].payload)).not.toContain('Phone number corrected');

    for (const action of ['data_request.create', 'data_request.start', 'data_request.complete']) {
      const rows = await audits({ action, object_id: ids.correction });
      expect(rows, action).toHaveLength(1);
      expect(rows[0].object_type).toBe('data_subject_request');
    }
    // Closed requests cannot be completed or rejected again.
    expect((await complete(admin1, ids.correction, 'again')).status).toBe(409);
    expect((await reject(admin1, ids.correction, 'again')).status).toBe(409);
  });

  it('rejects an open or in-progress request with a reason shown to the requester', async () => {
    const res = await reject(admin1, ids.access, 'We could not confirm who you are.');
    expect(res.status).toBe(200);
    expect(await dsr(ids.access)).toMatchObject({ status: 'rejected', outcome: 'We could not confirm who you are.' });
    const told = (await notifs(alice.id, 'N-12')).filter((n) => n.payload.kind === 'rejected');
    expect(told[0].payload).toMatchObject({ requestType: 'access', reason: 'We could not confirm who you are.' });
    const mine = (await call('GET', '/me/data-requests?limit=10', alice.token)).body.data.items.find((r: Body) => r.id === ids.access);
    expect(mine).toMatchObject({ status: 'rejected', outcome: 'We could not confirm who you are.' });
  });

  it('keeps ck_dsr_closed: a closed status needs completed_at and an open one cannot have it', async () => {
    const eve = await register('client');
    const id = await request(eve, 'export', 'open');
    expect(await constraintOf(db('data_subject_requests').where({ id }).update({ status: 'completed' }))).toBe('ck_dsr_closed');
    expect(await constraintOf(db('data_subject_requests').where({ id }).update({ completed_at: db.fn.now() }))).toBe('ck_dsr_closed');
    expect(await constraintOf(db('data_subject_requests').where({ id }).update({ status: 'rejected', completed_at: db.fn.now() }))).toBeUndefined();
  });

  it('stops an Admin from actioning a request for their own account', async () => {
    const own = await requestData(admin2, 'correction');
    expect(own.status).toBe(201);
    const id = own.body.data.id as string;
    for (const res of [await start(admin2, id), await complete(admin2, id, 'x'), await reject(admin2, id, 'x')]) {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('CANNOT_ACTION_OWN_REQUEST');
    }
    expect((await dsr(id)).status).toBe('open');
    // Another Admin can. Admins are not told about their own request, only the other Admin is.
    expect((await notifs(admin2.id, 'N-12')).filter((n) => n.payload.requestId === id && n.payload.kind === 'received')).toHaveLength(0);
    expect((await notifs(admin1.id, 'N-12')).filter((n) => n.payload.requestId === id && n.payload.kind === 'received')).toHaveLength(1);
    expect((await start(admin1, id)).status).toBe(200);
  });
});

// ==============================================================================================
describe('Personal data export (access and portability, NFR-PRV-02)', () => {
  let client: Account; // started a thread with the maintainer
  let maintainer: Account; // wrote in two threads
  let stranger: Account; // the maintainer's other thread
  let b1: string;
  let secret = { passwordHash: '', sessionToken: '', refreshHash: '' };
  let clientRequest = '';
  let maintainerRequest = '';

  beforeAll(async () => {
    client = await register('client', { name: 'Chloe Client' });
    maintainer = await register('landlord', { phone: true, name: 'Mary Maintainer' });
    stranger = await register('client', { name: 'Zed Stranger' });
    b1 = await newBuilding({ name: 'Export Court', maintainers: [maintainer], contact: maintainer, status: 'published' });
    const st = (await db('space_types').where({ building_id: b1 }).first('id')).id as string;

    const [t1] = await db('enquiries').insert({ space_type_id: st, client_id: client.id }).returning('id');
    const [t2] = await db('enquiries').insert({ space_type_id: st, client_id: stranger.id }).returning('id');
    const say = (enquiry: string, sender: Account, body: string) => db('enquiry_messages').insert({ enquiry_id: enquiry, sender_id: sender.id, body });
    await say(t1.id, client, 'CLIENT-MSG-ONE hello');
    await say(t1.id, maintainer, 'MAINTAINER-MSG-TO-CLIENT secret-of-the-maintainer');
    await say(t1.id, client, 'CLIENT-MSG-TWO again');
    await say(t2.id, stranger, 'STRANGER-MSG private words');
    await say(t2.id, maintainer, 'MAINTAINER-MSG-TO-STRANGER');

    await db('viewing_requests').insert({ space_type_id: st, client_id: client.id, requested_for: new Date(Date.now() + 5 * 86_400_000) });
    await db('reports').insert({ building_id: b1, client_id: client.id, reason: 'inaccurate', comment: 'CLIENT-REPORT-COMMENT' });
    await db('contact_events').insert({ building_id: b1, user_id: client.id });
    const evidenceFile = await addFile(client.id, { visibility: 'restricted', name: 'national-id.pdf' });
    const [vc] = await db('verification_cases').insert({ subject_type: 'account', subject_user_id: client.id, submitted_by: client.id }).returning('id');
    await db('verification_evidence').insert({ case_id: vc.id, evidence_type: 'national_id', file_id: evidenceFile.id });
    await db('verification_cases').where({ id: vc.id }).update({ status: 'rejected', decided_by: admin1.id, decided_at: db.fn.now(), decision_reason: 'The photo was unreadable' });
    await db('notifications').insert({ user_id: client.id, event_code: 'N-10', payload: JSON.stringify({ subject: 'account', action: 'reinstated' }) });

    // Credentials that must never appear in an export.
    const login = await call('POST', '/auth/login', null, { email: client.email, password: 'password123' });
    expect(login.status).toBe(200);
    secret = {
      passwordHash: (await db('auth_accounts').where({ user_id: client.id }).first('password')).password,
      sessionToken: (await db('auth_sessions').where({ user_id: client.id }).first('token')).token,
      refreshHash: (await db('auth_refresh_tokens').where({ user_id: client.id }).first('token_hash')).token_hash,
    };
    expect(secret.passwordHash.length).toBeGreaterThan(20);

    clientRequest = await request(client, 'export', 'completed');
    maintainerRequest = await request(maintainer, 'access', 'completed');
  });

  const exportOf = (user: Account, id: string) => call('GET', `/me/data-requests/${id}/export`, user.token);

  it('contains exactly the documented sections, built from the requester\'s own rows', async () => {
    const res = await exportOf(client, clientRequest);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.userId).toBe(client.id);
    expect(Object.keys(data.sections)).toEqual([...EXPORT_SECTIONS]);
    const s = data.sections;
    expect(s.account).toMatchObject({ id: client.id, email: client.email, name: 'Chloe Client' });
    expect(s.profile).toMatchObject({ displayName: 'Chloe Client', language: 'en', accountStatus: 'active' });
    expect(s.roles.map((r: Body) => r.role)).toEqual(['client']);
    expect(s.consents).toHaveLength(1);
    expect(s.consents[0]).toHaveProperty('version');
    expect(s.buildings).toEqual([]);
    expect(s.viewingRequests).toHaveLength(1);
    expect(s.reports).toMatchObject([{ buildingId: b1, reason: 'inaccurate', comment: 'CLIENT-REPORT-COMMENT' }]);
    expect(s.contactEvents).toMatchObject([{ buildingId: b1 }]);
    expect(s.notifications.map((n: Body) => n.eventCode)).toContain('N-10');
    expect(s.files).toMatchObject([{ originalName: 'national-id.pdf', visibility: 'restricted', mimeType: 'application/pdf' }]);
    expect(s.files[0]).not.toHaveProperty('publicId');
    expect(s.verificationCases).toMatchObject([
      { subjectType: 'account', status: 'rejected', decisionReason: 'The photo was unreadable', evidence: [{ evidenceType: 'national_id' }] },
    ]);
    expect(s.dataRequests).toHaveLength(1);
    expect(s.dataRequests[0]).toMatchObject({ id: clientRequest, type: 'export', status: 'completed', outcome: 'Done' });
  });

  it('never includes a password hash, a session token, a refresh token or token data', async () => {
    const text = (await exportOf(client, clientRequest)).text;
    for (const value of [secret.passwordHash, secret.sessionToken, secret.refreshHash]) expect(text).not.toContain(value);
    expect(text).not.toMatch(/token_hash|token_version|"password"|accessToken|refreshToken/);
  });

  it('returns only the requester\'s own messages in a thread, and nobody else\'s personal data (two users in one thread)', async () => {
    const own = (await exportOf(client, clientRequest)).body.data.sections.enquiries;
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ asClient: true });
    expect(own[0].messages.map((m: Body) => m.body)).toEqual(['CLIENT-MSG-ONE hello', 'CLIENT-MSG-TWO again']);
    const clientText = JSON.stringify(own);
    for (const other of ['MAINTAINER-MSG', 'secret-of-the-maintainer', maintainer.email, 'Mary Maintainer', stranger.email, 'STRANGER-MSG']) {
      expect(clientText).not.toContain(other);
    }

    const theirs = await exportOf(maintainer, maintainerRequest);
    expect(theirs.status).toBe(200);
    const threads = theirs.body.data.sections.enquiries;
    expect(threads).toHaveLength(2);
    expect(threads.every((t: Body) => t.asClient === false)).toBe(true);
    expect(threads.flatMap((t: Body) => t.messages.map((m: Body) => m.body)).sort()).toEqual(
      ['MAINTAINER-MSG-TO-CLIENT secret-of-the-maintainer', 'MAINTAINER-MSG-TO-STRANGER'].sort(),
    );
    for (const other of ['CLIENT-MSG', 'STRANGER-MSG', client.email, 'Chloe Client', stranger.email, 'Zed Stranger', 'CLIENT-REPORT-COMMENT']) {
      expect(theirs.text, other).not.toContain(other);
    }
    expect(theirs.body.data.sections.buildings).toMatchObject([{ id: b1, name: 'Export Court', isLister: true, isContact: true }]);
  });

  it('writes one export.run audit row per generation, with section names and counts but no personal values', async () => {
    const before = (await audits({ action: 'export.run', object_id: clientRequest })).length;
    expect((await exportOf(client, clientRequest)).status).toBe(200);
    expect((await exportOf(client, clientRequest)).status).toBe(200);
    const rows = await audits({ action: 'export.run', object_id: clientRequest });
    expect(rows).toHaveLength(before + 2);
    expect(rows[0]).toMatchObject({ actor_user_id: client.id, actor_type: 'user', object_type: 'data_subject_request' });
    expect(rows[0].changes.sections).toEqual([...EXPORT_SECTIONS]);
    expect(rows[0].changes.counts.enquiries).toBe(1);
    const written = JSON.stringify(rows.map((r) => r.changes));
    for (const secretText of [client.email, 'Chloe Client', 'CLIENT-MSG', 'CLIENT-REPORT-COMMENT', 'national-id.pdf']) expect(written).not.toContain(secretText);
  });

  it('refuses unless the request is the caller\'s own, an export or access request, and completed', async () => {
    expect((await exportOf(stranger, clientRequest)).status).toBe(404); // someone else's looks like a missing one
    expect((await exportOf(client, generateUuidV7())).status).toBe(404);
    expect((await call('GET', `/me/data-requests/${clientRequest}/export`, null)).status).toBe(401);
    expect((await call('GET', '/me/data-requests/not-a-uuid/export', client.token)).status).toBe(400);

    const open = await request(stranger, 'export', 'open');
    const running = await request(maintainer, 'export', 'in_progress');
    for (const [user, id] of [[stranger, open], [maintainer, running]] as const) {
      const res = await exportOf(user, id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('REQUEST_NOT_COMPLETED');
    }
    const rejected = await request(client, 'access', 'open');
    expect((await reject(admin1, rejected, 'No')).status).toBe(200);
    expect((await exportOf(client, rejected)).body.code).toBe('REQUEST_NOT_COMPLETED');

    const correction = await request(client, 'correction', 'completed');
    const res = await exportOf(client, correction);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_AN_EXPORT_REQUEST');
  });

  it('stops serving the download 7 days after completion', async () => {
    const day = 86_400_000;
    await db('data_subject_requests').where({ id: clientRequest }).update({ completed_at: new Date(Date.now() - 6 * day - 3_600_000) });
    expect((await exportOf(client, clientRequest)).status).toBe(200);
    await db('data_subject_requests').where({ id: clientRequest }).update({ completed_at: new Date(Date.now() - 7 * day - 60_000) });
    const expired = await exportOf(client, clientRequest);
    expect(expired.status).toBe(410);
    expect(expired.body.code).toBe('EXPORT_EXPIRED');
    expect(expired.text).not.toContain('CLIENT-MSG');
  });

  it('serves "my data" with the account, profile, roles, consents and verification status only', async () => {
    const res = await call('GET', '/me/data', maintainer.token);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data)).toEqual(['account', 'profile', 'roles', 'consents', 'verification']);
    expect(res.body.data.account).toMatchObject({ id: maintainer.id, email: maintainer.email });
    expect(res.body.data.verification).toEqual({ status: 'unverified' });
    expect(res.body.data.profile).not.toHaveProperty('verificationStatus');
    expect((await call('GET', '/me/data', null)).status).toBe(401);
  });
});

// ==============================================================================================
describe('Erasure: TX-10 through the Admin completing a deletion request (design §10.6)', () => {
  let target: Account; // erased in this block
  let other: Account; // active co-maintainer with a phone
  let noPhone: Account; // active co-maintainer without a phone
  let peer: Account; // the other side of a thread
  let bearer = '';
  let sessionCookie = '';
  let refreshCookie = '';
  let deletionId = '';
  let profilePhoto: { id: string; public_id: string };
  let evidence: { id: string; public_id: string };
  let result: Body;
  const ids = {} as Record<'sole' | 'draft' | 'pending' | 'coContact' | 'coNoPhone' | 'coOther' | 'adminSuspended' | 'withdrawn', string>;
  const before = {} as { auditCount: number; notifCount: number; messageCount: number };

  beforeAll(async () => {
    target = await register('landlord', { phone: true, name: 'Terry Target' });
    other = await register('landlord', { phone: true });
    noPhone = await register('landlord');
    peer = await register('client', { name: 'Penny Peer' });
    ids.sole = await newBuilding({ name: 'Erase Sole Published', maintainers: [target], contact: target, status: 'published' });
    ids.draft = await newBuilding({ name: 'Erase Sole Draft', maintainers: [target], contact: target, status: 'draft' });
    ids.pending = await newBuilding({ name: 'Erase Sole Pending', maintainers: [target], contact: target, status: 'pending' });
    ids.coContact = await newBuilding({ name: 'Erase Co Contact Reassigned', maintainers: [target, other], contact: target, status: 'published' });
    ids.coNoPhone = await newBuilding({ name: 'Erase Co Contact No Phone', maintainers: [target, noPhone], contact: target, status: 'published' });
    ids.coOther = await newBuilding({ name: 'Erase Co Other Is Contact', maintainers: [other, target], contact: other, status: 'published' });
    ids.adminSuspended = await newBuilding({ name: 'Erase Admin Suspended', maintainers: [target], contact: target, status: 'admin_suspended' });
    ids.withdrawn = await newBuilding({ name: 'Erase Withdrawn', maintainers: [target], contact: target, status: 'withdrawn' });

    // Personal data of every kind the procedure touches.
    profilePhoto = await addFile(target.id, { name: 'my-face.jpg' });
    await db('profiles').where({ user_id: target.id }).update({ photo_file_id: profilePhoto.id });
    evidence = await addFile(target.id, { visibility: 'restricted', name: 'title-deed.pdf' });
    const [vc] = await db('verification_cases').insert({ subject_type: 'account', subject_user_id: target.id, submitted_by: target.id }).returning('id');
    await db('verification_evidence').insert({ case_id: vc.id, evidence_type: 'title_deed', file_id: evidence.id });
    const st = (await db('space_types').where({ building_id: ids.coOther }).first('id')).id as string;
    const [thread] = await db('enquiries').insert({ space_type_id: st, client_id: peer.id }).returning('id');
    await db('enquiry_messages').insert([
      { enquiry_id: thread.id, sender_id: peer.id, body: 'Is it still free?' },
      { enquiry_id: thread.id, sender_id: target.id, body: 'TARGET-MSG yes it is' },
    ]);
    await db('viewing_requests').insert({ space_type_id: st, client_id: target.id, requested_for: new Date(Date.now() + 86_400_000) });
    await db('reports').insert({ building_id: ids.coOther, client_id: target.id, reason: 'suspicious', comment: 'TARGET-REPORT' });
    await db('contact_events').insert([{ building_id: ids.coOther, user_id: target.id }, { building_id: ids.coOther, user_id: target.id }]);
    const [note] = await db('notifications').insert({ user_id: target.id, event_code: 'N-10', payload: JSON.stringify({ subject: 'account', action: 'reinstated' }) }).returning('id');
    await db('notification_deliveries').insert({ notification_id: note.id, channel: 'email', status: 'failed', attempts: 2, last_error: 'send_failed:ECONNRESET to target' });
    await db('auth_verifications').insert([
      { identifier: target.email, value: 'verify-me', expires_at: new Date(Date.now() + 3_600_000) },
      { identifier: `reset-password:${generateUuidV7()}`, value: target.id, expires_at: new Date(Date.now() + 3_600_000) },
      { identifier: 'someone-else@khunt.local', value: 'not-the-target', expires_at: new Date(Date.now() + 3_600_000) },
    ]);

    const login = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-v': 'v1' },
      body: JSON.stringify({ email: target.email, password: 'password123' }),
    });
    expect(login.status).toBe(200);
    const cookies = login.headers.getSetCookie().map((c) => c.split(';')[0]!);
    sessionCookie = cookies.filter((c) => !c.startsWith('khunt_refresh=')).join('; ');
    refreshCookie = cookies.find((c) => c.startsWith('khunt_refresh=')) ?? '';
    bearer = ((await login.json()) as Body).data.tokens.accessToken;
    expect((await call('GET', '/me', bearer)).status).toBe(200);
    expect((await call('GET', '/me', null, undefined, { cookie: sessionCookie })).status).toBe(200);

    // A second open request of the same user, closed by the erasure.
    expect((await requestData(target, 'export')).status).toBe(201);
    deletionId = await request(target, 'deletion', 'open');
    await db('data_subject_requests').where({ id: deletionId }).update({ note: 'TARGET-NOTE please delete me' });
    expect((await start(admin1, deletionId)).status).toBe(200);

    before.auditCount = Number((await db('audit_log').where({ actor_user_id: target.id }).count({ n: '*' }).first())!.n);
    before.notifCount = Number((await db('notifications').where({ user_id: target.id }).count({ n: '*' }).first())!.n);
    before.messageCount = Number((await db('enquiry_messages').where({ sender_id: target.id }).count({ n: '*' }).first())!.n);
  });

  it('refuses to erase before the request is in progress, for a non-deletion type and for the Admin\'s own account', async () => {
    const fresh = await register('client');
    const open = await request(fresh, 'deletion', 'open');
    const notStarted = await complete(admin1, open, 'Erased');
    expect(notStarted.status).toBe(409);
    expect(notStarted.body.code).toBe('INVALID_STATE');
    expect(await profile(fresh.id)).toMatchObject({ erased_at: null });

    const ownAdmin = await makeAdmin();
    const own = await requestData(ownAdmin, 'deletion');
    expect(own.status).toBe(201);
    const self = await complete(ownAdmin, own.body.data.id, 'Erased');
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('CANNOT_ACTION_OWN_REQUEST');

    const direct = await completeDeletionRequest(
      { user: { id: admin1.id } } as never, (await request(fresh, 'export', 'in_progress')), 'x', { sender: fakeSender },
    ).catch((e) => e);
    expect(direct).toMatchObject({ status: 409, code: 'NOT_A_DELETION_REQUEST' });
    expect(mails).toHaveLength(0);
  });

  it('does not erase when the completion e-mail cannot be sent, and lets a retry through', async () => {
    const mailFail = await register('client', { name: 'Mail Failure' });
    const id = await request(mailFail, 'deletion', 'in_progress');
    failNextMail = true;
    const res = await complete(admin1, id, 'Erased');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('COMPLETION_EMAIL_FAILED');
    expect(JSON.stringify(res.body)).not.toContain(mailFail.email); // no provider text leaks
    expect(await profile(mailFail.id)).toMatchObject({ erased_at: null, display_name: 'Mail Failure' });
    expect(await dsr(id)).toMatchObject({ status: 'in_progress', completion_email_sent_at: null, completion_email_claimed_at: null });

    const retry = await complete(admin1, id, 'Erased');
    expect(retry.status).toBe(200);
    expect(retry.body.data.erasure.completionEmail).toBe('sent');
    expect((await profile(mailFail.id)).erased_at).not.toBeNull();
    expect(mails.filter((m) => m.to === mailFail.email)).toHaveLength(1);
    mails.length = 0;
  });

  it('completes the deletion: 200, the e-mail goes out exactly once and BEFORE the account is erased', async () => {
    const res = await complete(admin1, deletionId, 'Your personal data was erased on request.');
    expect(res.status).toBe(200);
    result = res.body.data;
    expect(result).toMatchObject({ id: deletionId, status: 'completed' });

    const sent = mails.filter((m) => m.to === target.email);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.wasErasedWhenSent).toBe(false); // the address still belonged to a live account
    expect(sent[0]!.subject).toBe('Your personal data has been erased');
    expect(sent[0]!.idempotencyKey).toBe(`data-request-${deletionId}-completed`);
    expect((await dsr(deletionId)).completion_email_sent_at).not.toBeNull();
    expect(result.erasure.completionEmail).toBe('sent');
  });

  it('anonymises the profile and the account: placeholder address, name and photo gone, account_status untouched', async () => {
    const p = await profile(target.id);
    expect(p).toMatchObject({ display_name: 'Deleted user', phone: null, photo_file_id: null, account_status: 'active' });
    expect(p.erased_at).not.toBeNull();
    const u = await authUser(target.id);
    expect(u).toMatchObject({ email: `erased+${target.id}@invalid`, name: 'Deleted user', image: null, email_verified: false });
    expect(u.email.endsWith('@invalid')).toBe(true);
    expect(await db('auth_users').where({ email: target.email })).toHaveLength(0); // the real address is gone from the table
    // Unique per user (ux_auth_users_email): a second erasure cannot collide.
    expect(u.email).not.toBe(`erased+${other.id}@invalid`);
  });

  it('removes sessions, accounts, verifications and refresh tokens, and only this user\'s', async () => {
    expect(await db('auth_sessions').where({ user_id: target.id })).toHaveLength(0);
    expect(await db('auth_accounts').where({ user_id: target.id })).toHaveLength(0);
    expect(await db('auth_refresh_tokens').where({ user_id: target.id })).toHaveLength(0);
    expect(await db('auth_verifications').where({ value: target.id })).toHaveLength(0);
    expect(await db('auth_verifications').where({ identifier: target.email })).toHaveLength(0);
    expect(await db('auth_verifications').where({ identifier: 'someone-else@khunt.local' })).toHaveLength(1);
    expect(await db('auth_accounts').where({ user_id: other.id })).toHaveLength(1);
  });

  it('kills every old credential and keeps the person out: login, bearer token, cookie and refresh token', async () => {
    const withBearer = await call('GET', '/me', bearer);
    expect(withBearer.status).toBe(401);
    expect((await call('GET', '/me', null, undefined, { cookie: sessionCookie })).status).toBe(401);
    expect((await call('POST', '/auth/refresh', null, undefined, { cookie: refreshCookie })).status).toBe(401);
    for (const email of [target.email, `erased+${target.id}@invalid`]) {
      const login = await call('POST', '/auth/login', null, { email, password: 'password123' });
      expect(login.status, email).toBeGreaterThanOrEqual(400);
      expect(login.status, email).toBeLessThan(500);
      expect(login.text).not.toContain('accessToken');
    }
    // A password reset for the old address finds no account either.
    expect((await call('POST', '/auth/forgot-password', null, { email: target.email })).status).toBeLessThan(500);
    expect(await db('auth_sessions').where({ user_id: target.id })).toHaveLength(0);
  });

  it('withdraws or reassigns the buildings first, so T8 (a published contact keeps a phone) is never tripped', async () => {
    // Sole maintainer: published, Draft, Pending and admin-suspended-from-published are all withdrawn.
    for (const key of ['sole', 'draft', 'pending', 'adminSuspended'] as const) {
      expect(await building(ids[key]), key).toMatchObject({
        status: 'withdrawn', status_before_suspension: null, suspension_cause: null, suspended_reason: null, suspended_at: null, suspended_by: null,
      });
    }
    // Co-maintained, the user was the contact: an ACTIVE maintainer with a phone takes over and the building stays published...
    expect(await building(ids.coContact)).toMatchObject({ status: 'published', contact_user_id: other.id });
    // ...with none it is withdrawn.
    expect((await building(ids.coNoPhone)).status).toBe('withdrawn');
    // Co-maintained and not the contact: untouched. Already withdrawn: still withdrawn.
    expect(await building(ids.coOther)).toMatchObject({ status: 'published', contact_user_id: other.id });
    expect((await building(ids.withdrawn)).status).toBe('withdrawn');

    expect(await db('buildings').where({ contact_user_id: target.id }).whereIn('status', ['published'])).toHaveLength(0);
    const b = result.erasure.buildings;
    expect(b.withdrawn.map((x: Body) => x.id).sort()).toEqual([ids.sole, ids.draft, ids.pending, ids.adminSuspended, ids.coNoPhone].sort());
    expect(b.contactReassigned).toEqual([{ id: ids.coContact, name: 'Erase Co Contact Reassigned', newContactUserId: other.id }]);
    const withdrawAudits = (await audits({ action: 'building.withdraw', actor_user_id: admin1.id })).filter((r) => r.changes.cause === 'account_erased');
    expect(withdrawAudits.map((r) => r.building_id).sort()).toEqual(b.withdrawn.map((x: Body) => x.id).sort());
    expect((await audits({ action: 'building.contact.set', building_id: ids.coContact }))[0].changes).toMatchObject({
      before: { contactUserId: target.id }, after: { contactUserId: other.id }, cause: 'account_erased',
    });
  });

  it('sets landlord_name to "Deleted user" (never NULL) where the user listed the building or was its only maintainer', async () => {
    for (const key of ['sole', 'draft', 'pending', 'adminSuspended', 'withdrawn', 'coContact', 'coNoPhone'] as const) {
      expect((await building(ids[key])).landlord_name, key).toBe('Deleted user');
    }
    // Listed by someone else and co-maintained: not the user's to rename.
    expect((await building(ids.coOther)).landlord_name).toBe('Test Landlord');
  });

  it('clears contact events\' user ids, delivery errors and the request notes; keeps the rows', async () => {
    expect(await db('contact_events').where({ user_id: target.id })).toHaveLength(0);
    expect(await db('contact_events').where({ building_id: ids.coOther }).whereNull('user_id')).toHaveLength(2);
    const delivery = await db('notification_deliveries as d').join('notifications as n', 'n.id', 'd.notification_id').where('n.user_id', target.id).select('d.last_error');
    expect(delivery.length).toBeGreaterThan(0);
    expect(delivery.every((d: Body) => d.last_error === null)).toBe(true);
    const requests = await db('data_subject_requests').where({ user_id: target.id });
    expect(requests.length).toBe(2);
    expect(requests.every((r: Body) => r.note === null)).toBe(true);
  });

  it('marks the request completed with the outcome, and closes the user\'s other open requests', async () => {
    expect(await dsr(deletionId)).toMatchObject({
      status: 'completed', outcome: 'Your personal data was erased on request.', handled_by: admin1.id, user_id: target.id,
    });
    expect((await dsr(deletionId)).completed_at).not.toBeNull();
    const closed = await db('data_subject_requests').where({ user_id: target.id, request_type: 'export' }).first();
    expect(closed).toMatchObject({ status: 'rejected', outcome: 'Closed because the account was erased.' });
    expect(closed.completed_at).not.toBeNull();
  });

  it('keeps messages (shown as "Deleted user"), viewings, reports, consents, availability and the whole audit trail', async () => {
    const messages = await db('enquiry_messages as m').join('profiles as p', 'p.user_id', 'm.sender_id').where('m.sender_id', target.id).select('m.body', 'p.display_name');
    expect(messages).toHaveLength(before.messageCount);
    expect(messages[0]).toMatchObject({ body: 'TARGET-MSG yes it is', display_name: 'Deleted user' });
    expect(await db('viewing_requests').where({ client_id: target.id })).toHaveLength(1);
    expect(await db('reports').where({ client_id: target.id })).toHaveLength(1);
    expect(await db('consent_records').where({ user_id: target.id })).toHaveLength(1);
    expect(Number((await db('audit_log').where({ actor_user_id: target.id }).count({ n: '*' }).first())!.n)).toBeGreaterThanOrEqual(before.auditCount);
    expect(await db('availability_events').count({ n: '*' }).first()).toBeTruthy();
    // No notification row was written for a user about to be erased: the e-mail replaced it.
    expect(Number((await db('notifications').where({ user_id: target.id }).count({ n: '*' }).first())!.n)).toBe(before.notifCount);

    const [erase] = await audits({ action: 'user.erase', object_id: target.id });
    expect(erase).toMatchObject({ actor_user_id: admin1.id, actor_type: 'staff' });
    expect(erase.changes).toMatchObject({ requestId: deletionId, completionEmail: 'sent', buildingsWithdrawn: 5, contactsReassigned: 1 });
    const written = JSON.stringify((await audits({ object_id: target.id })).map((r) => r.changes));
    for (const secretText of [target.email, 'Terry Target', 'TARGET-NOTE', 'TARGET-MSG']) expect(written).not.toContain(secretText);
  });

  it('queues the profile photo and the evidence for deletion, blanks every file name, and leaves catalogue photos alone', async () => {
    const photo = await db('files').where({ id: profilePhoto.id }).first();
    const proof = await db('files').where({ id: evidence.id }).first();
    for (const f of [photo, proof]) {
      expect(f.purge_requested_at).not.toBeNull();
      expect(f.purged_at).toBeNull(); // the purge job sets this once Cloudinary has answered
      expect(f.original_name).toBe('');
    }
    const kept = await db('files as f').join('photos as ph', 'ph.file_id', 'f.id').where('f.uploaded_by', target.id).select('f.original_name', 'f.purge_requested_at', 'f.purged_at');
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((f: Body) => f.original_name === '' && f.purge_requested_at === null && f.purged_at === null)).toBe(true);
    expect(result.erasure.filesQueuedForPurge).toBe(2);
  });

  it('has the purge job destroy exactly those Cloudinary assets (the trap in design §10.6 step 6), once', async () => {
    const run = await purgeFiles({ client: fakeCloud.client });
    expect(run.erasedFilesPurged).toBe(2);
    expect(run.failures).toBe(0);
    const destroyed = fakeCloud.destroyed.map((d) => d.publicId);
    expect(destroyed).toContain(profilePhoto.public_id);
    expect(destroyed).toContain(evidence.public_id);
    expect(fakeCloud.destroyed.find((d) => d.publicId === evidence.public_id)).toMatchObject({ resourceType: 'raw', deliveryType: 'authenticated' });
    for (const id of [profilePhoto.id, evidence.id]) {
      const f = await db('files').where({ id }).first(); // the row stays; only the object is gone
      expect(f.purged_at).not.toBeNull();
      expect(f.original_name).toBe('');
    }
    const catalogue = await db('photos').where({ 'photos.uploaded_by': target.id }).join('files as f', 'f.id', 'photos.file_id').select('f.public_id');
    for (const { public_id } of catalogue) expect(destroyed).not.toContain(public_id);

    const count = fakeCloud.destroyed.length;
    const again = await purgeFiles({ client: fakeCloud.client });
    expect(again.erasedFilesPurged).toBe(0);
    expect(fakeCloud.destroyed.length).toBe(count);
    // A file waiting for the job cannot be downloaded in the meantime (410, like a purged one).
    const waiting = await addFile(target.id, { visibility: 'restricted' });
    await db('files').where({ id: waiting.id }).update({ purge_requested_at: db.fn.now() });
    expect((await call('GET', `/files/${waiting.id}/download`, admin1.token)).status).toBe(410);
  });

  it('reports an already erased user (409) instead of redoing it, and does not send the e-mail again', async () => {
    const sentBefore = mails.length;
    const [again] = await db('data_subject_requests').insert({ user_id: target.id, request_type: 'deletion', status: 'in_progress', handled_by: admin1.id }).returning('id');
    const res = await complete(admin1, again.id, 'Again');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_ERASED');
    expect(mails).toHaveLength(sentBefore);
    expect(await db('audit_log').where({ action: 'user.erase', object_id: target.id })).toHaveLength(1);
    // The completed request cannot be completed again either.
    const second = await complete(admin1, deletionId, 'Again');
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('INVALID_STATE');
    expect(mails).toHaveLength(sentBefore);
  });

  it('does not re-send the e-mail when a retry follows a failed transaction', async () => {
    const victim = await register('landlord', { phone: true, name: 'Retry Victim' });
    await newBuilding({ name: 'Retry Building', maintainers: [victim], contact: victim, status: 'published' });
    const id = await request(victim, 'deletion', 'in_progress');
    const fn = `test_block_erase_${victim.id.replaceAll('-', '')}`;
    await db.raw(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated failure inside the erasure transaction'; END $$`);
    await db.raw(`CREATE TRIGGER ${fn} BEFORE UPDATE OF erased_at ON profiles FOR EACH ROW WHEN (NEW.user_id = '${victim.id}') EXECUTE FUNCTION ${fn}()`);
    const sentBefore = mails.filter((m) => m.to === victim.email).length;
    try {
      const failed = await complete(admin1, id, 'Erased');
      expect(failed.status).toBe(500);
      expect(mails.filter((m) => m.to === victim.email)).toHaveLength(sentBefore + 1); // out before the transaction
      // The whole transaction rolled back: nothing half-erased.
      expect(await profile(victim.id)).toMatchObject({ erased_at: null, display_name: 'Retry Victim' });
      expect(await dsr(id)).toMatchObject({ status: 'in_progress' });
      expect((await dsr(id)).completion_email_sent_at).not.toBeNull();
    } finally {
      await db.raw(`DROP TRIGGER ${fn} ON profiles`);
      await db.raw(`DROP FUNCTION ${fn}()`);
    }
    const retry = await complete(admin1, id, 'Erased');
    expect(retry.status).toBe(200);
    expect(retry.body.data.erasure.completionEmail).toBe('already_sent');
    expect(mails.filter((m) => m.to === victim.email)).toHaveLength(sentBefore + 1); // still exactly one
    expect((await profile(victim.id)).erased_at).not.toBeNull();
  });

  it('refuses to erase the last active Admin, before any e-mail is sent', async () => {
    const lastAdmin = await makeAdmin();
    const id = await request(lastAdmin, 'deletion', 'in_progress');
    const actor = { user: { id: generateUuidV7() } } as never; // someone with no admin standing at all
    const sentBefore = mails.length;
    await onlyAdmins([lastAdmin.id], async () => {
      const res = await completeDeletionRequest(actor, id, 'Erased', { sender: fakeSender }).catch((e) => e);
      expect(res).toMatchObject({ status: 409, code: 'LAST_ADMIN' });
    });
    expect(mails).toHaveLength(sentBefore);
    expect(await profile(lastAdmin.id)).toMatchObject({ erased_at: null });
    expect(await dsr(id)).toMatchObject({ status: 'in_progress', completion_email_sent_at: null });
  });

  it('lets only one of two Admins erase each other when they are the last two (no race to zero Admins)', async () => {
    const a = await makeAdmin();
    const b = await makeAdmin();
    const aRequest = await request(a, 'deletion', 'in_progress', admin1);
    const bRequest = await request(b, 'deletion', 'in_progress', admin1);
    await onlyAdmins([a.id, b.id], async () => {
      const results = await Promise.all([complete(b, aRequest, 'Erased'), complete(a, bRequest, 'Erased')]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses[0]).toBe(200);
      expect([401, 409]).toContain(statuses[1]!); // 409 LAST_ADMIN, or 401 once the loser's own session is gone
      const active = await db('user_roles as r').join('profiles as p', 'p.user_id', 'r.user_id').where('r.role', 'admin').whereIn('r.user_id', [a.id, b.id]).whereNull('p.erased_at').count({ n: '*' }).first();
      expect(Number(active!.n)).toBe(1);
    });
  });

  it('survives an erasure racing the publish of one of the user\'s buildings: no deadlock, a consistent end state', async () => {
    for (let round = 0; round < 4; round += 1) {
      const racer = await register('landlord', { phone: true, name: `Racer ${round}` });
      const draft = await newBuilding({ name: `Race Building ${round}`, maintainers: [racer], contact: racer, status: 'draft' });
      const id = await request(racer, 'deletion', 'in_progress');
      const [erased, published] = await Promise.all([
        complete(admin1, id, 'Erased'),
        call('POST', `/buildings/${draft}/publish`, admin1.token), // an Admin publishing on the lister's behalf
      ]);
      expect(erased.status, `erase round ${round}: ${erased.text}`).toBe(200);
      expect([200, 409], `publish round ${round}: ${published.text}`).toContain(published.status);
      // Published first then withdrawn, or withdrawn first then the publish refused: the end state is the same.
      expect(await building(draft)).toMatchObject({ status: 'withdrawn', suspension_cause: null });
      expect((await profile(racer.id)).erased_at).not.toBeNull();
      expect(await db('buildings').where({ contact_user_id: racer.id, status: 'published' })).toHaveLength(0);
    }
  });

  it('never lets the delivery worker mail an erased user\'s old notifications', async () => {
    const mailsBefore = mails.length;
    const run = await deliverNotifications({ sender: fakeSender, batchSize: 500 });
    expect(run.claimed).toBeGreaterThanOrEqual(0);
    expect(mails.slice(mailsBefore).every((m) => m.to !== target.email && !m.to.endsWith('@invalid'))).toBe(true);
    const pending = await db('notification_deliveries as d').join('notifications as n', 'n.id', 'd.notification_id').where('n.user_id', target.id).select('d.status', 'd.last_error');
    expect(pending.every((d: Body) => d.last_error === null || d.last_error === 'no_deliverable_email')).toBe(true);
    expect(pending.every((d: Body) => d.status !== 'sent')).toBe(true);
  });
});

// ==============================================================================================
describe('Expired credential cleanup (design §10.7)', () => {
  const hour = 3_600_000;
  const day = 24 * hour;

  it('deletes expired sessions and verifications and refresh tokens expired over 30 days ago, and nothing live; twice is safe', async () => {
    const user = await register('client');
    const now = new Date();
    const session = (label: string, expiresAt: Date) =>
      db('auth_sessions').insert({ token: `purge-${label}-${generateUuidV7()}`, expires_at: expiresAt, user_id: user.id }).returning('id');
    const [expiredSession] = await session('expired', new Date(now.getTime() - hour));
    const [liveSession] = await session('live', new Date(now.getTime() + hour));
    const verification = (label: string, expiresAt: Date) =>
      db('auth_verifications').insert({ identifier: `purge-${label}`, value: 'v', expires_at: expiresAt }).returning('id');
    const [expiredVerification] = await verification('expired', new Date(now.getTime() - hour));
    const [liveVerification] = await verification('live', new Date(now.getTime() + hour));
    const token = (label: string, expiresAt: Date, sessionId: string | null) =>
      db('auth_refresh_tokens')
        .insert({ user_id: user.id, session_id: sessionId, family_id: generateUuidV7(), token_hash: `purge-${label}-${generateUuidV7()}`, expires_at: expiresAt })
        .returning('id');
    const [longGone] = await token('long-gone', new Date(now.getTime() - 31 * day), null);
    const [recentlyExpired] = await token('recently-expired', new Date(now.getTime() - 10 * day), null);
    const [live] = await token('live', new Date(now.getTime() + 10 * day), liveSession.id);

    const first = await purgeExpiredAuth({ now });
    expect(first.sessions).toBeGreaterThanOrEqual(1);
    expect(first.verifications).toBeGreaterThanOrEqual(1);
    expect(first.refreshTokens).toBeGreaterThanOrEqual(1);

    expect(await db('auth_sessions').where({ id: expiredSession.id })).toHaveLength(0);
    expect(await db('auth_sessions').where({ id: liveSession.id })).toHaveLength(1);
    expect(await db('auth_verifications').where({ id: expiredVerification.id })).toHaveLength(0);
    expect(await db('auth_verifications').where({ id: liveVerification.id })).toHaveLength(1);
    expect(await db('auth_refresh_tokens').where({ id: longGone.id })).toHaveLength(0);
    expect(await db('auth_refresh_tokens').where({ id: recentlyExpired.id })).toHaveLength(1); // kept for 30 days
    expect(await db('auth_refresh_tokens').where({ id: live.id })).toHaveLength(1);

    const second = await purgeExpiredAuth({ now });
    expect(second).toEqual({ sessions: 0, verifications: 0, refreshTokens: 0 });

    // Thirty-one days later the once-recent token goes too, and the live rows are still left alone.
    const later = await purgeExpiredAuth({ now: new Date(now.getTime() + 21 * day + hour) });
    expect(later.refreshTokens).toBeGreaterThanOrEqual(1);
    expect(await db('auth_refresh_tokens').where({ id: recentlyExpired.id })).toHaveLength(0);
  });

  it('keeps a real login working after the job (the live session is untouched)', async () => {
    const user = await register('client');
    await purgeExpiredAuth();
    expect((await call('GET', '/me', user.token)).status).toBe(200);
  });
});
