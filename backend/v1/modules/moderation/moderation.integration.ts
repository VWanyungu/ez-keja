import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Server } from 'node:http';
import { createApp } from '../../../app.js';
import db, { closeDb } from '../../db/knex.js';
import { closeAuthPool } from '../../lib/auth.js';
import { mailTestAddress } from '../../lib/mail-test-address.js';
import { generateUuidV7 } from '../../lib/uuid.js';
import { suspendUser } from './service.js';

let server: Server;
let baseUrl: string;
let previousVerifiedRule = 1;

beforeAll(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to bind ephemeral port');
  baseUrl = `http://127.0.0.1:${addr.port}`;
  // These fixtures build Published buildings directly; BR-005 (verified lister) is not what is tested here.
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
    // not JSON (a CSV export)
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
  const email = mailTestAddress(`mod-${Date.now()}-${seq}`);
  const name = opts.name ?? `Moderation User ${seq}`;
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
const notifs = (userId: string, code: string): Promise<Body[]> =>
  db('notifications').where({ user_id: userId, event_code: code }).orderBy('created_at').orderBy('id');
const audits = (where: Record<string, unknown>): Promise<Body[]> => db('audit_log').where(where).orderBy('created_at').orderBy('id');
const suspend = (admin: Account, userId: string, reason?: string) =>
  call('POST', `/admin/users/${userId}/suspend`, admin.token, reason === undefined ? {} : { reason });
const reinstate = (admin: Account, userId: string, reason?: string) =>
  call('POST', `/admin/users/${userId}/reinstate`, admin.token, reason === undefined ? {} : { reason });

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

beforeAll(async () => {
  admin1 = await loginAdmin();
  const [area] = await db('areas')
    .insert({ name: 'Moderation Area', slug: `moderation-area-${Date.now()}`, centre_lat: -1.28, centre_lng: 36.82 })
    .returning('id');
  areaId = area.id;
  categoryId = (await db('space_categories').where({ is_active: true }).first('id')).id;
  currencyId = (await db('currencies').where({ is_active: true }).first('id')).id;
});

// ==============================================================================================
describe('Suspending a user: TX-09 cascade (FR-ADM-003, G-12, ASM-13)', () => {
  let target: Account; // suspended in this block
  let other: Account; // active co-maintainer with a phone
  let noPhone: Account; // active co-maintainer without a phone
  let bearer = '';
  let sessionCookie = '';
  let refreshCookie = '';
  const ids = {} as Record<'sole' | 'draft' | 'pending' | 'coContact' | 'coNoPhone' | 'coOther' | 'adminSuspended' | 'withdrawn', string>;
  let first: Body;

  beforeAll(async () => {
    target = await register('landlord', { phone: true });
    other = await register('landlord', { phone: true });
    noPhone = await register('landlord');
    ids.sole = await newBuilding({ name: 'Sole Published', maintainers: [target], contact: target, status: 'published' });
    ids.draft = await newBuilding({ name: 'Sole Draft', maintainers: [target], contact: target, status: 'draft' });
    ids.pending = await newBuilding({ name: 'Sole Pending', maintainers: [target], contact: target, status: 'pending' });
    ids.coContact = await newBuilding({ name: 'Co Contact Reassigned', maintainers: [target, other], contact: target, status: 'published' });
    ids.coNoPhone = await newBuilding({ name: 'Co Contact No Phone', maintainers: [target, noPhone], contact: target, status: 'published' });
    ids.coOther = await newBuilding({ name: 'Co Other Is Contact', maintainers: [target, other], contact: other, status: 'published' });
    ids.adminSuspended = await newBuilding({ name: 'Admin Suspended', maintainers: [target], contact: target, status: 'admin_suspended' });
    ids.withdrawn = await newBuilding({ name: 'Withdrawn', maintainers: [target], contact: target, status: 'withdrawn' });

    // A bearer token and a Better Auth cookie, both live before the suspension.
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
    expect(sessionCookie).toContain('session_token=');
    expect(refreshCookie).not.toBe('');
    expect((await call('GET', '/me', bearer)).status).toBe(200);
    expect((await call('GET', '/me', null, undefined, { cookie: sessionCookie })).status).toBe(200);
  });

  it('refuses without a reason (400, nothing changes), for a non-Admin (403), and for an unknown user (404)', async () => {
    for (const reason of [undefined, '', '   ']) {
      const res = await suspend(admin1, target.id, reason);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('REASON_REQUIRED');
    }
    expect((await profile(target.id)).account_status).toBe('active');
    expect((await building(ids.sole)).status).toBe('published');
    expect((await call('POST', `/admin/users/${target.id}/suspend`, other.token, { reason: 'x' })).status).toBe(403);
    expect((await suspend(admin1, generateUuidV7(), 'x')).status).toBe(404);
  });

  it('refuses an Admin suspending themselves', async () => {
    const res = await suspend(admin1, admin1.id, 'oops');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CANNOT_SUSPEND_SELF');
    expect((await profile(admin1.id)).account_status).toBe('active');
  });

  it('suspends the account and cascades to the buildings only this user keeps running', async () => {
    first = await suspend(admin1, target.id, 'Fake ownership documents');
    expect(first.status).toBe(200);

    const p = await profile(target.id);
    expect(p).toMatchObject({ account_status: 'suspended', suspended_reason: 'Fake ownership documents', suspended_by: admin1.id, erased_at: null });
    expect(p.suspended_at).not.toBeNull();

    // Sole maintainer: suspended as owner_suspended, remembering where each one was.
    for (const [key, before] of [['sole', 'published'], ['draft', 'draft'], ['pending', 'pending']] as const) {
      expect(await building(ids[key]!), key).toMatchObject({
        status: 'suspended', suspension_cause: 'owner_suspended', status_before_suspension: before,
        suspended_reason: 'Fake ownership documents', suspended_by: admin1.id,
      });
    }
    // Co-maintained, the suspended user was the contact: another ACTIVE maintainer with a phone takes over...
    expect(await building(ids.coContact)).toMatchObject({ status: 'published', contact_user_id: other.id, suspension_cause: null });
    // ...and with none, the building is suspended.
    expect(await building(ids.coNoPhone)).toMatchObject({ status: 'suspended', suspension_cause: 'owner_suspended', status_before_suspension: 'published' });
    // Co-maintained and not the contact: nothing to do.
    expect(await building(ids.coOther)).toMatchObject({ status: 'published', contact_user_id: other.id });
    // Already suspended by an Admin, or withdrawn: untouched.
    expect(await building(ids.adminSuspended)).toMatchObject({ status: 'suspended', suspension_cause: 'admin', suspended_reason: 'earlier admin decision' });
    expect((await building(ids.withdrawn)).status).toBe('withdrawn');

    const b = first.body.data.buildings;
    expect(b.suspended.map((x: Body) => x.id).sort()).toEqual([ids.sole, ids.draft, ids.pending, ids.coNoPhone].sort());
    expect(b.contactReassigned).toEqual([{ id: ids.coContact, name: 'Co Contact Reassigned', newContactUserId: other.id }]);
    expect(b.skipped.map((x: Body) => x.id).sort()).toEqual([ids.adminSuspended, ids.withdrawn].sort());
  });

  it('writes the audit rows and the N-10 notice to the suspended user in the same transaction', async () => {
    const [row] = await audits({ action: 'user.suspend', object_id: target.id });
    expect(row).toMatchObject({ actor_user_id: admin1.id, actor_type: 'staff', object_type: 'user' });
    expect(row.changes).toMatchObject({ reason: 'Fake ownership documents', buildingsSuspended: 4, contactsReassigned: 1, buildingsSkipped: 2 });
    const suspendedRows = await audits({ action: 'building.suspend', actor_user_id: admin1.id });
    expect(suspendedRows.filter((r) => [ids.sole, ids.draft, ids.pending, ids.coNoPhone].includes(r.building_id))).toHaveLength(4);
    expect(suspendedRows.find((r) => r.building_id === ids.sole).changes).toMatchObject({ cause: 'owner_suspended', from: 'published', userId: target.id });
    const contactRows = await audits({ action: 'building.contact.set', building_id: ids.coContact });
    expect(contactRows[0].changes).toMatchObject({ before: { contactUserId: target.id }, after: { contactUserId: other.id }, cause: 'owner_suspended' });

    const sent = await notifs(target.id, 'N-10');
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toMatchObject({ subject: 'account', action: 'suspended', reason: 'Fake ownership documents', buildingsAffected: 4 });
    const delivery = await db('notification_deliveries').where({ notification_id: sent[0].id }).first();
    expect(delivery).toMatchObject({ channel: 'email', status: 'pending' });
  });

  it('removes access at once: the bearer token and the cookie both stop working, and so does the refresh token', async () => {
    const withBearer = await call('GET', '/me', bearer);
    expect(withBearer.status).toBe(401);
    expect(withBearer.body.code).toBe('SESSION_REVOKED');
    const withCookie = await call('GET', '/me', null, undefined, { cookie: sessionCookie });
    expect(withCookie.status).toBe(401);
    const refresh = await call('POST', '/auth/refresh', null, undefined, { cookie: refreshCookie });
    expect(refresh.status).toBe(401);
    expect(await db('auth_sessions').where({ user_id: target.id })).toHaveLength(0);
    expect(await db('auth_refresh_tokens').where({ user_id: target.id }).whereNull('revoked_at')).toHaveLength(0);
  });

  it('keeps a suspended user out even after a fresh login (403 ACCOUNT_SUSPENDED with the reason)', async () => {
    const login = await call('POST', '/auth/login', null, { email: target.email, password: 'password123' });
    if (login.status === 200) {
      const res = await call('GET', '/me', login.body.data.tokens.accessToken);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ACCOUNT_SUSPENDED');
    } else {
      expect([401, 403]).toContain(login.status);
    }
  });

  it('refuses a second suspension (409) and an erased account (409)', async () => {
    const again = await suspend(admin1, target.id, 'again');
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_SUSPENDED');

    const gone = await register('client');
    await db('profiles').where({ user_id: gone.id }).update({ erased_at: db.fn.now() });
    for (const res of [await suspend(admin1, gone.id, 'x'), await reinstate(admin1, gone.id, 'x')]) {
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('USER_ERASED');
    }
    const p = await profile(gone.id);
    expect(p.account_status).toBe('active'); // never touched
    expect(p.erased_at).not.toBeNull();
  });

  it('does not let an owner_suspended building be reinstated by hand while its only owner is suspended', async () => {
    const res = await call('POST', `/admin/buildings/${ids.sole}/reinstate`, admin1.token, { reason: 'try' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('OWNER_SUSPENDED');
    expect((await building(ids.sole)).status).toBe('suspended');
  });

  it('reinstates the user and restores ONLY the owner_suspended buildings, each to its earlier status', async () => {
    expect((await reinstate(admin1, target.id)).status).toBe(400); // reason is mandatory here too
    expect((await profile(target.id)).account_status).toBe('suspended');

    const res = await reinstate(admin1, target.id, 'Documents checked');
    expect(res.status).toBe(200);
    expect(await profile(target.id)).toMatchObject({ account_status: 'active', suspended_reason: null, suspended_at: null, suspended_by: null, erased_at: null });

    for (const [key, to] of [['sole', 'published'], ['draft', 'draft'], ['pending', 'pending'], ['coNoPhone', 'published']] as const) {
      expect(await building(ids[key]!), key).toMatchObject({
        status: to, status_before_suspension: null, suspension_cause: null, suspended_reason: null, suspended_at: null, suspended_by: null,
      });
    }
    // Suspended by an Admin directly: stays suspended. Withdrawn: stays withdrawn. The reassigned contact stays.
    expect(await building(ids.adminSuspended)).toMatchObject({ status: 'suspended', suspension_cause: 'admin' });
    expect((await building(ids.withdrawn)).status).toBe('withdrawn');
    expect((await building(ids.coContact)).contact_user_id).toBe(other.id);

    expect(res.body.data.buildings.restored.map((x: Body) => x.id).sort()).toEqual([ids.sole, ids.draft, ids.pending, ids.coNoPhone].sort());
    expect(res.body.data.buildings.blocked).toEqual([]);

    const [row] = await audits({ action: 'user.reinstate', object_id: target.id });
    expect(row.changes).toMatchObject({ reason: 'Documents checked', buildingsRestored: 4 });
    expect(await audits({ action: 'building.reinstate', actor_user_id: admin1.id, building_id: ids.sole })).toHaveLength(1);
    const sent = await notifs(target.id, 'N-10');
    expect(sent.map((n) => n.payload.action)).toEqual(['suspended', 'reinstated']);
    // The old sessions stay dead: signing in again is the user's step.
    expect((await call('GET', '/me', bearer)).status).toBe(401);
    expect((await reinstate(admin1, target.id, 'again')).body.code).toBe('NOT_SUSPENDED');
  });

  it('reports a restore that the publish gate (T5) refuses, leaves that building suspended, and still reinstates the user', async () => {
    const owner = await register('landlord', { phone: true });
    const fine = await newBuilding({ name: 'Restores Fine', maintainers: [owner], contact: owner, status: 'published' });
    const blocked = await newBuilding({ name: 'Cover Photo Lost', maintainers: [owner], contact: owner, status: 'published' });
    expect((await suspend(admin1, owner.id, 'Investigation')).status).toBe(200);
    expect((await building(blocked)).status).toBe('suspended');

    // While suspended, the cover photo goes away: the gate will now refuse to publish it.
    await db('photos').where({ building_id: blocked, category: 'cover' }).update({ removed_at: db.fn.now(), removed_by: admin1.id });

    const res = await reinstate(admin1, owner.id, 'Cleared');
    expect(res.status).toBe(200);
    expect((await profile(owner.id)).account_status).toBe('active');
    expect(res.body.data.buildings.restored.map((x: Body) => x.id)).toEqual([fine]);
    expect(res.body.data.buildings.blocked).toHaveLength(1);
    expect(res.body.data.buildings.blocked[0].id).toBe(blocked);
    expect(res.body.data.buildings.blocked[0].blockers.join(' ')).toContain('cover photo');
    expect((await building(fine)).status).toBe('published');
    expect(await building(blocked)).toMatchObject({ status: 'suspended', suspension_cause: 'owner_suspended', status_before_suspension: 'published' });
    const [row] = await audits({ action: 'user.reinstate', object_id: owner.id });
    expect(row.changes.buildingsBlocked).toHaveLength(1);

    // The Admin route says why it cannot restore it yet, then restores it once the cover is back.
    const refused = await call('POST', `/admin/buildings/${blocked}/reinstate`, admin1.token, { reason: 'retry' });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('PUBLISH_BLOCKED');
    expect(refused.body.data.blockers.join(' ')).toContain('cover photo');
    await addPhotos({ buildingId: blocked, category: 'cover' }, 1, owner.id);
    const done = await call('POST', `/admin/buildings/${blocked}/reinstate`, admin1.token, { reason: 'Cover photo added' });
    expect(done.status).toBe(200);
    expect(await building(blocked)).toMatchObject({ status: 'published', suspension_cause: null });
  });
});

// ==============================================================================================
describe('Last active Admin, and Admins suspending each other', () => {
  it('refuses to suspend the last active Admin (service level: the acting account is not an active Admin)', async () => {
    const lone = await makeAdmin();
    const outsider = await register('client'); // any real user id for the audit row
    await onlyAdmins([lone.id], async () => {
      try {
        await suspendUser({ user: { id: outsider.id }, roles: [] } as never, lone.id, 'cannot');
        throw new Error('should have refused');
      } catch (err) {
        expect((err as { code?: string }).code).toBe('LAST_ADMIN');
      }
      expect((await profile(lone.id)).account_status).toBe('active');
    });
  });

  it('two Admins suspending each other at once: one wins, the other is refused, one stays active', async () => {
    const a = await makeAdmin();
    const b = await makeAdmin();
    await onlyAdmins([a.id, b.id], async () => {
      const [r1, r2] = await Promise.all([suspend(a, b.id, 'mutual'), suspend(b, a.id, 'mutual')]);
      expect([r1.status, r2.status].filter((s) => s === 200)).toHaveLength(1);
      const loser = r1.status === 200 ? r2 : r1;
      expect([403, 409]).toContain(loser.status);
      if (loser.status === 409) expect(loser.body.code).toBe('LAST_ADMIN');
      const active = await db('profiles').whereIn('user_id', [a.id, b.id]).where({ account_status: 'active' });
      expect(active).toHaveLength(1);
    });
  });
});

// ==============================================================================================
describe('Suspending a building by hand (FR-ADM-003)', () => {
  let m1: Account;
  let m2: Account;
  let m3: Account; // suspended maintainer
  let id = '';

  beforeAll(async () => {
    m1 = await register('landlord', { phone: true });
    m2 = await register('agent', { phone: true });
    m3 = await register('landlord', { phone: true });
    id = await newBuilding({ name: 'Hand Moderated', maintainers: [m1, m2, m3], contact: m1, status: 'published' });
    await db('profiles').where({ user_id: m3.id }).update({ account_status: 'suspended', suspended_reason: 'x', suspended_at: db.fn.now() });
  });

  it('needs the Admin role, a reason, and an existing building', async () => {
    expect((await call('POST', `/admin/buildings/${id}/suspend`, m1.token, { reason: 'x' })).status).toBe(403);
    const none = await call('POST', `/admin/buildings/${id}/suspend`, admin1.token, {});
    expect(none.status).toBe(400);
    expect(none.body.code).toBe('REASON_REQUIRED');
    expect((await call('POST', `/admin/buildings/${generateUuidV7()}/suspend`, admin1.token, { reason: 'x' })).status).toBe(404);
    expect((await building(id)).status).toBe('published');
  });

  it('suspends with cause "admin", records who and why, and tells the active maintainers (N-10)', async () => {
    const res = await call('POST', `/admin/buildings/${id}/suspend`, admin1.token, { reason: 'Photos are of another building' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ buildingId: id, status: 'suspended', suspensionCause: 'admin' });
    expect(await building(id)).toMatchObject({
      status: 'suspended', status_before_suspension: 'published', suspension_cause: 'admin',
      suspended_reason: 'Photos are of another building', suspended_by: admin1.id,
    });
    expect((await audits({ action: 'building.suspend', building_id: id }))[0].changes).toMatchObject({ cause: 'admin', from: 'published', reason: 'Photos are of another building' });
    for (const m of [m1, m2]) {
      const sent = await notifs(m.id, 'N-10');
      expect(sent).toHaveLength(1);
      expect(sent[0].payload).toMatchObject({ subject: 'building', action: 'suspended', buildingId: id, buildingName: 'Hand Moderated' });
    }
    expect(await notifs(m3.id, 'N-10')).toHaveLength(0); // a suspended maintainer is not an active recipient
  });

  it('refuses a second suspension and a building that is withdrawn', async () => {
    const again = await call('POST', `/admin/buildings/${id}/suspend`, admin1.token, { reason: 'x' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_SUSPENDED');
    const w = await newBuilding({ name: 'Withdrawn For Moderation', maintainers: [m1], contact: m1, status: 'withdrawn' });
    const res = await call('POST', `/admin/buildings/${w}/suspend`, admin1.token, { reason: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_TRANSITION');
  });

  it('reinstates to the earlier status with a reason, clears the suspension, and tells the maintainers', async () => {
    expect((await call('POST', `/admin/buildings/${id}/reinstate`, admin1.token, {})).status).toBe(400);
    const res = await call('POST', `/admin/buildings/${id}/reinstate`, admin1.token, { reason: 'Photos corrected' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ buildingId: id, status: 'published', suspensionCause: null });
    expect(await building(id)).toMatchObject({ status: 'published', status_before_suspension: null, suspension_cause: null, suspended_reason: null, suspended_at: null, suspended_by: null });
    expect((await notifs(m1.id, 'N-10')).map((n) => n.payload.action)).toEqual(['suspended', 'reinstated']);
    expect((await audits({ action: 'building.reinstate', building_id: id }))[0].changes).toMatchObject({ from: 'suspended', to: 'published', reason: 'Photos corrected' });
    const notSuspended = await call('POST', `/admin/buildings/${id}/reinstate`, admin1.token, { reason: 'x' });
    expect(notSuspended.status).toBe(409);
    expect(notSuspended.body.code).toBe('NOT_SUSPENDED');
  });
});

// ==============================================================================================
describe('Photo removal tells the uploader (N-10, FR-ADM-003)', () => {
  it('writes N-10 with the reason when an Admin removes a photo, and nothing when the maintainer does', async () => {
    const owner = await register('landlord', { phone: true });
    const id = await newBuilding({ name: 'Photo Notice', maintainers: [owner], contact: owner, status: 'draft' });
    const photos = (await db('photos').where({ building_id: id, category: 'grounds' }).orderBy('id')) as Body[];

    const noReason = await call('DELETE', `/photos/${photos[0].id}`, admin1.token);
    expect(noReason.status).toBe(403);
    expect(await notifs(owner.id, 'N-10')).toHaveLength(0);

    const removed = await call('DELETE', `/photos/${photos[0].id}`, admin1.token, { reason: 'Shows a different property' });
    expect(removed.status).toBe(200);
    const sent = await notifs(owner.id, 'N-10');
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toMatchObject({ subject: 'photo', action: 'removed', buildingId: id, buildingName: 'Photo Notice', category: 'grounds', reason: 'Shows a different property' });

    const own = await call('DELETE', `/photos/${photos[1].id}`, owner.token);
    expect(own.status).toBe(200);
    expect(await notifs(owner.id, 'N-10')).toHaveLength(1); // still just the Admin's
  });
});

// ==============================================================================================
describe('User administration and personal-data access logging (FR-ADM-003, FR-ADM-006, NFR-AUD-01)', () => {
  const tag = `ModList${Date.now()}`;
  const people: Account[] = [];

  beforeAll(async () => {
    for (let i = 0; i < 5; i += 1) people.push(await register(i < 2 ? 'landlord' : 'client', { phone: i === 0, name: `${tag} Person ${i}` }));
    await suspend(admin1, people[1]!.id, 'for the filter test');
    await db.transaction(async (trx) => {
      await trx.raw("SET LOCAL khunt.verification_writer = 'on'");
      await trx('profiles').where({ user_id: people[2]!.id }).update({ verification_status: 'verified' });
    });
  });

  const piiRows = async (since: Date): Promise<Body[]> =>
    db('audit_log').where({ action: 'pii.view', actor_user_id: admin1.id }).where('created_at', '>=', since).orderBy('created_at').orderBy('id');

  it('searches by name or email, filters by role, status and verification, and pages by keyset', async () => {
    const found = await call('GET', `/admin/users?q=${encodeURIComponent(tag)}&limit=10`, admin1.token);
    expect(found.status).toBe(200);
    expect(found.body.data.items.map((u: Body) => u.id).sort()).toEqual(people.map((p) => p.id).sort());
    const first = found.body.data.items[0];
    expect(first).toMatchObject({ roles: expect.any(Array), accountStatus: expect.any(String), verificationStatus: expect.any(String) });
    expect(first).not.toHaveProperty('phone'); // phone only in the detail view

    const byEmail = await call('GET', `/admin/users?q=${encodeURIComponent(people[3]!.email)}`, admin1.token);
    expect(byEmail.body.data.items.map((u: Body) => u.id)).toEqual([people[3]!.id]);

    const suspended = await call('GET', `/admin/users?q=${encodeURIComponent(tag)}&status=suspended`, admin1.token);
    expect(suspended.body.data.items.map((u: Body) => u.id)).toEqual([people[1]!.id]);
    const landlords = await call('GET', `/admin/users?q=${encodeURIComponent(tag)}&role=landlord`, admin1.token);
    expect(landlords.body.data.items.map((u: Body) => u.id).sort()).toEqual([people[0]!.id, people[1]!.id].sort());
    const verified = await call('GET', `/admin/users?q=${encodeURIComponent(tag)}&verification=verified`, admin1.token);
    expect(verified.body.data.items.map((u: Body) => u.id)).toEqual([people[2]!.id]);
    const none = await call('GET', `/admin/users?q=${encodeURIComponent(`${tag}-nobody`)}`, admin1.token);
    expect(none.body.data).toEqual({ items: [], nextCursor: null });

    // A wildcard typed by the Admin is text, not a pattern.
    const wild = await call('GET', `/admin/users?q=${encodeURIComponent('%')}&limit=100`, admin1.token);
    expect(wild.status).toBe(200);
    expect(wild.body.data.items.every((u: Body) => `${u.email}${u.displayName}`.includes('%'))).toBe(true);

    expect((await call('GET', '/admin/users', people[3]!.token)).status).toBe(403);
    expect((await call('GET', '/admin/users?role=root', admin1.token)).status).toBe(400);
  });

  it('pages without skipping or repeating a user, newest first', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: Body = await call('GET', `/admin/users?q=${encodeURIComponent(tag)}&limit=2${cursor ? `&cursor=${cursor}` : ''}`, admin1.token);
      expect(res.status).toBe(200);
      seen.push(...res.body.data.items.map((u: Body) => u.id));
      cursor = res.body.data.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual([...people].reverse().map((p) => p.id)); // registered in order, listed newest first
  });

  it('writes ONE pii.view row per list page and per detail view, with field names but no personal values', async () => {
    const since = new Date();
    await new Promise((r) => setTimeout(r, 20));
    const list = await call('GET', `/admin/users?q=${encodeURIComponent(people[0]!.email)}&limit=5`, admin1.token);
    expect(list.status).toBe(200);
    const detail = await call('GET', `/admin/users/${people[0]!.id}`, admin1.token);
    expect(detail.status).toBe(200);

    const rows = await piiRows(since);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ actor_type: 'staff', object_type: 'user', object_id: null });
    expect(rows[0].changes).toMatchObject({ view: 'user_list', fields: ['email', 'displayName'], count: 1, filters: ['q'], userIds: [people[0]!.id] });
    expect(rows[1]).toMatchObject({ object_type: 'user', object_id: people[0]!.id });
    expect(rows[1].changes).toMatchObject({ view: 'user_detail', fields: ['email', 'displayName', 'phone'] });

    const phone = ((await profile(people[0]!.id)) as Body).phone as string;
    for (const row of rows) {
      const text = JSON.stringify(row.changes);
      for (const personal of [people[0]!.email, people[0]!.name, phone, tag]) expect(text).not.toContain(personal);
    }
    expect(detail.body.data).toMatchObject({ id: people[0]!.id, email: people[0]!.email, displayName: people[0]!.name, phone, roles: ['client', 'landlord'], buildings: [] });
    // Nothing is returned without a log row: an unknown user answers 404 and logs nothing.
    const before = (await piiRows(since)).length;
    expect((await call('GET', `/admin/users/${generateUuidV7()}`, admin1.token)).status).toBe(404);
    expect((await piiRows(since)).length).toBe(before);
  });

  it('shows the buildings a user maintains and which one they are the contact of', async () => {
    const owner = await register('landlord', { phone: true });
    const id = await newBuilding({ name: 'Detail Court', maintainers: [owner], contact: owner, status: 'draft' });
    const res = await call('GET', `/admin/users/${owner.id}`, admin1.token);
    expect(res.body.data.buildings).toEqual([{ id, name: 'Detail Court', status: 'draft', isContact: true }]);
  });

  it('grants and revokes client, landlord and agent, and writes an audit row for each change', async () => {
    const user = await register('client');
    const grant = await call('POST', `/admin/users/${user.id}/roles`, admin1.token, { role: 'agent' });
    expect(grant.status).toBe(200);
    expect(grant.body.data.roles).toEqual(['agent', 'client']);
    expect(await db('user_roles').where({ user_id: user.id, role: 'agent' }).first()).toMatchObject({ granted_by: admin1.id });
    expect((await call('POST', `/admin/users/${user.id}/roles`, admin1.token, { role: 'agent' })).body.code).toBe('ROLE_ALREADY_GRANTED');

    const revoke = await call('DELETE', `/admin/users/${user.id}/roles/client`, admin1.token);
    expect(revoke.status).toBe(200);
    expect(revoke.body.data.roles).toEqual(['agent']);
    expect((await call('DELETE', `/admin/users/${user.id}/roles/landlord`, admin1.token)).status).toBe(404);

    const last = await call('DELETE', `/admin/users/${user.id}/roles/agent`, admin1.token);
    expect(last.status).toBe(409);
    expect(last.body.code).toBe('LAST_ROLE');
    expect(await db('user_roles').where({ user_id: user.id }).pluck('role')).toEqual(['agent']);

    const rows = await db('audit_log').where({ object_id: user.id }).whereIn('action', ['user.role.grant', 'user.role.revoke']).orderBy('created_at').orderBy('id');
    expect(rows.map((r: Body) => [r.action, r.changes.role])).toEqual([['user.role.grant', 'agent'], ['user.role.revoke', 'client']]);
  });

  it('never grants or revokes the admin role (FR-ADM-006) and refuses an erased or unknown user', async () => {
    const user = await register('client');
    const grant = await call('POST', `/admin/users/${user.id}/roles`, admin1.token, { role: 'admin' });
    expect(grant.status).toBe(400);
    expect(grant.body.code).toBe('ADMIN_ROLE_NOT_ASSIGNABLE');
    expect(await db('user_roles').where({ user_id: user.id, role: 'admin' })).toHaveLength(0);

    const other = await makeAdmin();
    const revoke = await call('DELETE', `/admin/users/${other.id}/roles/admin`, admin1.token);
    expect(revoke.status).toBe(400);
    expect(await db('user_roles').where({ user_id: other.id, role: 'admin' })).toHaveLength(1);
    // An Admin's other roles can still be changed: they keep the admin role, so this is not their last.
    expect((await call('DELETE', `/admin/users/${other.id}/roles/client`, admin1.token)).status).toBe(200);

    const gone = await register('client');
    await db('profiles').where({ user_id: gone.id }).update({ erased_at: db.fn.now() });
    expect((await call('POST', `/admin/users/${gone.id}/roles`, admin1.token, { role: 'agent' })).body.code).toBe('USER_ERASED');
    expect((await call('POST', `/admin/users/${generateUuidV7()}/roles`, admin1.token, { role: 'agent' })).status).toBe(404);
    expect((await call('POST', `/admin/users/${user.id}/roles`, user.token, { role: 'agent' })).status).toBe(403);
  });
});

// ==============================================================================================
describe('Audit search (FR-ADM-007) and its CSV export (FR-RPT-002)', () => {
  let owner: Account;
  let buildingId = '';
  let from = '';

  beforeAll(async () => {
    from = new Date(Date.now() - 1000).toISOString();
    owner = await register('landlord', { phone: true });
    buildingId = await newBuilding({ name: 'Audit Trail Court', maintainers: [owner], contact: owner, status: 'published' });
    // Several rows in ONE transaction share a timestamp: the suspension cascade writes user + building rows together.
    await suspend(admin1, owner.id, 'audit fixture');
    await reinstate(admin1, owner.id, 'audit fixture');
    await db('audit_log').insert({
      id: generateUuidV7(), actor_user_id: admin1.id, actor_type: 'staff', action: '=cmd|calc', object_type: 'building',
      object_id: buildingId, building_id: buildingId, changes: JSON.stringify({ note: '=1+1' }),
    });
  });

  const search = (qs: string) => call('GET', `/admin/audit?${qs}`, admin1.token);

  it('filters by building, newest first, and an empty result is not an error', async () => {
    const res = await search(`buildingId=${buildingId}&limit=200`);
    expect(res.status).toBe(200);
    const items = res.body.data.items as Body[];
    expect(items.length).toBe(3); // suspend, reinstate, and the fixture row (the SQL fixtures write no availability events)
    expect(items.every((i) => i.buildingId === buildingId)).toBe(true);
    const keys = items.map((i) => `${i.occurredAt}|${i.id}`);
    expect(keys).toEqual([...keys].sort().reverse());
    expect(items[0]).toEqual({
      id: expect.any(String), occurredAt: expect.stringMatching(/Z$/), actorUserId: expect.any(String), action: expect.any(String),
      objectType: expect.any(String), objectId: expect.anything(), buildingId, changes: expect.any(Object),
    });
    expect(items.map((i) => i.action)).toContain('building.suspend');
    expect(items.map((i) => i.action)).toContain('building.reinstate');

    const empty = await search(`buildingId=${generateUuidV7()}`);
    expect(empty.status).toBe(200);
    expect(empty.body.data).toEqual({ items: [], nextCursor: null });
    const past = await search(`buildingId=${buildingId}&to=2000-01-01`);
    expect(past.body.data).toEqual({ items: [], nextCursor: null });
  });

  it('filters by user (what they did, and what was done to them), by action, and by date range', async () => {
    const byUser = (await search(`userId=${owner.id}&limit=200`)).body.data.items as Body[];
    expect(byUser.some((i) => i.action === 'user.suspend' && i.objectId === owner.id)).toBe(true); // done to them
    expect(byUser.every((i) => i.actorUserId === owner.id || (i.objectType === 'user' && i.objectId === owner.id))).toBe(true);

    const byAction = (await search(`action=user.reinstate&userId=${owner.id}`)).body.data.items as Body[];
    expect(byAction).toHaveLength(1);
    expect(byAction[0]).toMatchObject({ action: 'user.reinstate', objectId: owner.id, actorUserId: admin1.id });

    const today = new Date().toISOString().slice(0, 10);
    expect(((await search(`buildingId=${buildingId}&from=${today}&to=${today}`)).body.data.items as Body[]).length).toBeGreaterThan(0); // a plain `to` date covers the whole day
    expect((await search(`buildingId=${buildingId}&from=2999-01-01`)).body.data.items).toEqual([]);
    expect((await search('from=nonsense')).status).toBe(400);
    expect((await search('userId=nope')).status).toBe(400);
    expect((await call('GET', '/admin/audit', (await register('client')).token)).status).toBe(403);
  });

  it('pages by (occurred_at, id) without skipping or repeating rows that share a timestamp', async () => {
    // Everything written since this block began: the suspension cascade wrote its rows in one transaction, so they tie.
    const everything = (await search(`from=${from}&limit=200`)).body.data.items as Body[];
    const all = everything.map((i) => i.id);
    const stamps = everything.map((i) => i.occurredAt);
    expect(new Set(stamps).size).toBeLessThan(stamps.length); // there ARE ties: that is what the id tie-break is for
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res: Body = await search(`from=${from}&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.data.items.map((i: Body) => i.id));
      cursor = res.body.data.nextCursor;
    } while (cursor);
    expect(seen).toEqual(all);
    expect(new Set(seen).size).toBe(all.length);
  });

  it('exports CSV with the same filters and logs the export without personal values', async () => {
    const before = new Date();
    await new Promise((r) => setTimeout(r, 20));
    const res = await search(`buildingId=${buildingId}&format=csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('audit.csv');
    const lines = res.text.trimEnd().split('\r\n');
    expect(lines[0]).toBe('occurred_at,actor_user_id,action,object_type,object_id,building_id,changes');
    const json = (await search(`buildingId=${buildingId}&limit=200`)).body.data.items as Body[];
    expect(lines.length - 1).toBeGreaterThanOrEqual(json.length); // the export's own row may be added meanwhile

    // A cell that starts with = is shown as text (formula injection).
    expect(res.text).toContain("'=cmd|calc");
    expect(res.text).not.toMatch(/(^|,)=cmd/m);

    const [log] = (await db('audit_log').where({ action: 'export.run', actor_user_id: admin1.id }).where('created_at', '>=', before).orderBy('created_at', 'desc')) as Body[];
    expect(log).toMatchObject({ actor_type: 'staff', object_type: 'export' });
    expect(log.changes).toMatchObject({ export: 'audit', rowCount: lines.length - 1, truncated: false, filters: { buildingId, userId: null } });
    const text = JSON.stringify(log.changes);
    for (const personal of [owner.email, owner.name]) expect(text).not.toContain(personal);
  });

  it('gives a headers-only file for zero rows and still logs the export', async () => {
    const before = new Date();
    await new Promise((r) => setTimeout(r, 20));
    const res = await search('to=2000-01-01&format=csv');
    expect(res.status).toBe(200);
    expect(res.text).toBe('occurred_at,actor_user_id,action,object_type,object_id,building_id,changes\r\n');
    const [log] = (await db('audit_log').where({ action: 'export.run', actor_user_id: admin1.id }).where('created_at', '>=', before).orderBy('created_at', 'desc')) as Body[];
    expect(log.changes).toMatchObject({ export: 'audit', rowCount: 0 });
  });
});

// ==============================================================================================
describe('A user suspension racing a publish on the same building (design §9.3 lock order)', () => {
  it('never deadlocks and always ends consistent: the user suspended, the building suspended as owner_suspended', async () => {
    for (let round = 0; round < 6; round += 1) {
      const owner = await register('landlord', { phone: true });
      const id = await newBuilding({ name: `Race ${round}`, maintainers: [owner], contact: owner, status: 'draft' });
      const [publish, suspension] = await Promise.all([
        call('POST', `/buildings/${id}/publish`, owner.token, {}),
        suspend(admin1, owner.id, `race ${round}`),
      ]);
      expect(suspension.status).toBe(200);
      expect([200, 401, 403, 409], `publish answered ${publish.status}`).toContain(publish.status);

      const b = await building(id);
      expect(b).toMatchObject({ status: 'suspended', suspension_cause: 'owner_suspended', suspended_by: admin1.id });
      const published = publish.status === 200 && publish.body.data.outcome === 'published';
      expect(b.status_before_suspension).toBe(published ? 'published' : 'draft');
      expect((await profile(owner.id)).account_status).toBe('suspended');
    }
  });

  it('two Admins suspending the same user at once: one wins, the other gets ALREADY_SUSPENDED', async () => {
    const other = await makeAdmin();
    const owner = await register('landlord', { phone: true });
    const id = await newBuilding({ name: 'Double Suspend', maintainers: [owner], contact: owner, status: 'published' });
    const [r1, r2] = await Promise.all([suspend(admin1, owner.id, 'one'), suspend(other, owner.id, 'two')]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect((r1.status === 409 ? r1 : r2).body.code).toBe('ALREADY_SUSPENDED');
    expect(await audits({ action: 'user.suspend', object_id: owner.id })).toHaveLength(1);
    expect(await notifs(owner.id, 'N-10')).toHaveLength(1);
    expect((await building(id)).suspension_cause).toBe('owner_suspended');
  });
});
