import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Server } from 'node:http';
import { createApp } from '../../../app.js';
import db, { closeDb } from '../../db/knex.js';
import { closeAuthPool } from '../../lib/auth.js';
import { setCloudinaryClient } from '../../lib/cloudinary.js';
import { mailTestAddress } from '../../lib/mail-test-address.js';
import { generateUuidV7 } from '../../lib/uuid.js';
import { PDF_BYTES, createFakeCloudinary } from '../files/fake-cloudinary.js';

const fake = createFakeCloudinary();
let server: Server;
let baseUrl: string;

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

let emailSeq = 0;
// Every address a mail-capable test uses comes from lib/mail-test-address.ts (a real, deliverable inbox).
async function register(role: 'client' | 'landlord' | 'agent', phone?: string): Promise<Account> {
  emailSeq += 1;
  const email = mailTestAddress(`ver-${Date.now()}-${emailSeq}`);
  const res = await call('POST', '/auth/register', null, {
    email,
    password: 'password123',
    displayName: `User ${emailSeq}`,
    role,
    privacyNoticeAccepted: true,
  });
  expect(res.status).toBe(201);
  const account = { id: res.body.data.user.id as string, token: res.body.data.tokens.accessToken as string };
  if (phone) await db('profiles').where({ user_id: account.id }).update({ phone });
  return account;
}

async function loginAdmin(): Promise<Account> {
  const res = await call('POST', '/auth/login', null, { email: 'admin@khunt.local', password: 'password' });
  expect(res.status).toBe(200);
  return { id: res.body.data.user.id, token: res.body.data.tokens.accessToken };
}

let phoneSeq = 0;
const nextPhone = () => `+2547${String((phoneSeq += 1)).padStart(3, '0')}${String(Date.now()).slice(-6)}`;

async function newEvidence(token: string, name = 'id.pdf'): Promise<string> {
  const res = await fetch(`${baseUrl}/files/evidence`, {
    method: 'POST',
    headers: { 'api-v': 'v1', authorization: `Bearer ${token}`, 'content-type': 'application/pdf', 'x-file-name': name },
    body: new Blob([new Uint8Array(PDF_BYTES)]),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as Body).data.id as string;
}

const evidenceBody = (type: string, fileId: string) => ({ evidence: [{ evidenceType: type, fileId }] });

const submitAccount = async (account: Account, fileId?: string) =>
  call('POST', '/verification/account', account.token, fileId ? evidenceBody('national_id', fileId) : {});

const submitBuilding = async (account: Account, buildingId: string, fileId?: string) =>
  call('POST', `/verification/buildings/${buildingId}`, account.token, fileId ? evidenceBody('proof_of_authority', fileId) : {});

const decide = (admin: Account, caseId: string, decision: 'approve' | 'reject', reason?: string) =>
  call('POST', `/admin/verification/cases/${caseId}/decision`, admin.token, { decision, ...(reason ? { reason } : {}) });

const revoke = (admin: Account, subject: 'account' | 'building', id: string, reason?: string) =>
  call('POST', '/admin/verification/revoke', admin.token, { subject, id, ...(reason ? { reason } : {}) });

const profileStatus = async (userId: string) =>
  ((await db('profiles').where({ user_id: userId }).first('verification_status')) as Body).verification_status as string;
const buildingStatus = async (id: string) =>
  ((await db('buildings').where({ id }).first('verification_status')) as Body).verification_status as string;

const notifs = (userId: string, code: string) =>
  db('notifications').where({ user_id: userId, event_code: code }).orderBy('created_at').orderBy('id') as Promise<Body[]>;

/** Users who got `code` for this case id, sorted. */
const recipientsOfCase = async (code: string, caseId: string): Promise<string[]> =>
  (
    (await db('notifications')
      .where({ event_code: code })
      .whereRaw("payload->>'caseId' = ?", [caseId])
      .pluck('user_id')) as string[]
  ).sort();

const adminIds = async (): Promise<string[]> => ((await db('user_roles').where({ role: 'admin' }).pluck('user_id')) as string[]).sort();

const casesOf = (filter: Record<string, string>) =>
  db('verification_cases').where(filter).orderBy('submitted_at').orderBy('id') as Promise<Body[]>;

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

describe('Verification of accounts and buildings (PostgreSQL integration)', () => {
  let admin1: Account; // the seeded Admin
  let admin2: Account;
  let admin3: Account;
  let client: Account;
  let outsider: Account; // a landlord who maintains nothing here
  let areaId = '';
  let otherAreaId = '';
  let categoryId = '';
  let currencyId = '';

  const buildingBody = (extra: Record<string, unknown> = {}) => ({
    name: 'Verification Court',
    areaId,
    latitude: -1.286389,
    longitude: 36.817223,
    description: 'Test building',
    managementType: 'landlord',
    ...extra,
  });

  async function createBuilding(token: string, extra: Record<string, unknown> = {}): Promise<{ id: string; version: number }> {
    const res = await call('POST', '/buildings', token, buildingBody(extra));
    expect(res.status).toBe(201);
    return { id: res.body.data.id, version: res.body.data.version };
  }

  async function createSpaceType(token: string, buildingId: string, name: string) {
    const res = await call('POST', `/buildings/${buildingId}/space-types`, token, {
      name,
      categoryId,
      rentMode: 'fixed',
      rentAmount: 15000,
      currencyId,
      depositAmount: 15000,
      vacantCount: 2,
    });
    expect(res.status).toBe(201);
    return { id: res.body.data.id as string, version: res.body.data.version as number };
  }

  /** Account verified through the real flow: evidence upload, submit, approval by admin1. */
  async function verifyAccount(account: Account): Promise<void> {
    const submitted = await submitAccount(account, await newEvidence(account.token));
    expect(submitted.status).toBe(201);
    expect((await decide(admin1, submitted.body.data.id, 'approve')).status).toBe(200);
    expect(await profileStatus(account.id)).toBe('verified');
  }

  /** A building verified through the real flow (approved by admin1, who never touches buildings here). */
  async function verifyBuilding(maintainer: Account, buildingId: string): Promise<string> {
    const submitted = await submitBuilding(maintainer, buildingId, await newEvidence(maintainer.token, 'authority.pdf'));
    expect(submitted.status).toBe(201);
    expect((await decide(admin1, submitted.body.data.id, 'approve')).status).toBe(200);
    expect(await buildingStatus(buildingId)).toBe('verified');
    return submitted.body.data.id;
  }

  async function makeAdmin(): Promise<Account> {
    const account = await register('client');
    await db('user_roles').insert({ user_id: account.id, role: 'admin', granted_by: admin1.id });
    return account;
  }

  beforeAll(async () => {
    admin1 = await loginAdmin();
    admin2 = await makeAdmin();
    admin3 = await makeAdmin();
    client = await register('client');
    outsider = await register('landlord', nextPhone());

    // The suites share one database and files.integration.ts leaves this setting at 0 (BR-005 needs 1).
    await db('settings').where({ key: 'require_verified_lister_to_publish' }).update({ value: 1 });

    const [area] = await db('areas')
      .insert({ name: 'Verification Area', slug: `verification-area-${Date.now()}`, centre_lat: -1.28, centre_lng: 36.82 })
      .returning('id');
    areaId = area.id;
    const [other] = await db('areas')
      .insert({ name: 'Verification Area Two', slug: `verification-area-two-${Date.now()}`, centre_lat: -1.3, centre_lng: 36.9 })
      .returning('id');
    otherAreaId = other.id;
    categoryId = (await db('space_categories').where({ is_active: true }).first('id')).id;
    currencyId = (await db('currencies').where({ is_active: true }).first('id')).id;
  });

  // ---- accounts ----------------------------------------------------------------------------

  describe('account verification (FR-VER-001, -002, -006)', () => {
    let lister: Account;
    let agent: Account;
    let file1 = '';
    let file2 = '';
    let firstCase = '';
    let secondCase = '';
    let gateBuilding = '';

    beforeAll(async () => {
      lister = await register('landlord', nextPhone());
      agent = await register('agent', nextPhone());
      gateBuilding = (await createBuilding(lister.token)).id;
    });

    const lonelyBlockers = async () => (await call('GET', `/buildings/${gateBuilding}/publish-blockers`, lister.token)).body.data.blockers as string[];

    it('refuses a submission that breaks the evidence rules, naming the item', async () => {
      const none = await submitAccount(lister);
      expect(none.status).toBe(400);
      expect(none.body.message).toContain('national_id');
      expect(none.body.code).toBe('EVIDENCE_MISSING');

      const phone = await call('POST', '/verification/account', lister.token, evidenceBody('phone_confirmation', generateUuidV7()));
      expect(phone.status).toBe(400);

      const theirs = await newEvidence(outsider.token);
      expect((await submitAccount(lister, theirs)).status).toBe(400); // someone else's file

      const [pub] = await db('files')
        .insert({
          public_id: `test/${generateUuidV7()}`, resource_type: 'image', delivery_type: 'upload', format: 'jpg',
          original_name: 'pub.jpg', mime_type: 'image/jpeg', size_bytes: 10, visibility: 'public', uploaded_by: lister.id,
        })
        .returning('id');
      const publicFile = await submitAccount(lister, pub.id);
      expect(publicFile.status).toBe(400); // a public file is not evidence
      expect(publicFile.body.message).toContain('not one of the evidence files you uploaded');

      expect((await submitAccount(lister, generateUuidV7())).status).toBe(400); // unknown file
      expect(await profileStatus(lister.id)).toBe('unverified');
      expect(await casesOf({ subject_user_id: lister.id })).toHaveLength(0);

      expect((await submitAccount(client)).status).toBe(403); // a Client cannot submit
      expect((await call('POST', '/verification/account', null, {})).status).toBe(401);
    });

    it('submits: a pending case, its evidence, the cache moved by T3, an audit row', async () => {
      file1 = await newEvidence(lister.token, 'national-id.pdf');
      const res = await submitAccount(lister, file1);
      expect(res.status).toBe(201);
      firstCase = res.body.data.id;
      expect(res.body.data).toMatchObject({ subjectType: 'account', status: 'pending', origin: 'applicant', evidenceTypes: ['national_id'] });

      const row = (await casesOf({ id: firstCase }))[0];
      expect(row).toMatchObject({ subject_user_id: lister.id, submitted_by: lister.id, status: 'pending' });
      expect((await db('verification_evidence').where({ case_id: firstCase }))[0]).toMatchObject({ file_id: file1, evidence_type: 'national_id' });
      expect(await profileStatus(lister.id)).toBe('pending');
      expect(await db('audit_log').where({ object_id: firstCase, action: 'verification.submit', actor_user_id: lister.id }).first()).toBeTruthy();

      // The publish gate sees the lister as not verified.
      expect(await lonelyBlockers()).toContain('the lister is not verified');
    });

    it('answers 409 to a second submission while one is pending', async () => {
      const again = await submitAccount(lister, await newEvidence(lister.token));
      expect(again.status).toBe(409);
      expect(again.body.message).toContain('already pending');
    });

    it('lists the pending queue oldest first, with filters and keyset paging', async () => {
      const agentFile = await newEvidence(agent.token);
      const agentSubmit = await submitAccount(agent, agentFile);
      expect(agentSubmit.status).toBe(201);
      secondCase = agentSubmit.body.data.id;

      const all = await call('GET', '/admin/verification/cases?subject=account&limit=100', admin1.token);
      expect(all.status).toBe(200);
      const ids = all.body.data.items.map((i: Body) => i.id);
      expect(ids.indexOf(firstCase)).toBeGreaterThanOrEqual(0);
      expect(ids.indexOf(firstCase)).toBeLessThan(ids.indexOf(secondCase));
      const times = all.body.data.items.map((i: Body) => new Date(i.submittedAt).getTime());
      expect(times).toEqual([...times].sort((a, b) => a - b));
      expect(all.body.data.items.every((i: Body) => i.status === 'pending' && i.subjectType === 'account')).toBe(true);

      // Walk the queue one case at a time: same order, ends with a null cursor.
      const walked: string[] = [];
      let cursor: string | null = null;
      do {
        const pageRes: { status: number; body: Body } = await call(
          'GET',
          `/admin/verification/cases?subject=account&limit=1${cursor ? `&cursor=${cursor}` : ''}`,
          admin1.token,
        );
        expect(pageRes.status).toBe(200);
        walked.push(...pageRes.body.data.items.map((i: Body) => i.id));
        cursor = pageRes.body.data.nextCursor;
      } while (cursor);
      expect(walked).toEqual(ids);

      const defaulted = await call('GET', '/admin/verification/cases', admin1.token);
      expect(defaulted.body.data.items.every((i: Body) => i.status === 'pending')).toBe(true);
      expect((await call('GET', '/admin/verification/cases?status=bogus', admin1.token)).status).toBe(400);
      expect((await call('GET', '/admin/verification/cases?subject=bogus', admin1.token)).status).toBe(400);
    });

    it('shows the Admin the case, the subject and the evidence with file ids', async () => {
      const res = await call('GET', `/admin/verification/cases/${firstCase}`, admin1.token);
      expect(res.status).toBe(200);
      expect(res.body.data.case).toMatchObject({ id: firstCase, status: 'pending', subjectType: 'account' });
      expect(res.body.data.subject).toMatchObject({ type: 'account', userId: lister.id, verificationStatus: 'pending' });
      expect(res.body.data.subject.roles).toContain('landlord');
      expect(res.body.data.evidence).toHaveLength(1);
      expect(res.body.data.evidence[0]).toMatchObject({ evidenceType: 'national_id', fileId: file1, file: { originalName: 'national-id.pdf', mimeType: 'application/pdf' } });
      expect(res.body.data.review).toEqual({ canDecide: true, reason: null });
      expect((await call('GET', `/admin/verification/cases/${generateUuidV7()}`, admin1.token)).status).toBe(404);

      // The file itself comes through the existing admin-only download, which audits pii.view.
      const download = await call('GET', `/files/${file1}/download`, admin1.token);
      expect(download.status).toBe(200);
      expect(await db('audit_log').where({ object_id: file1, action: 'pii.view', actor_user_id: admin1.id }).first()).toBeTruthy();
    });

    it('lets the Admin add a phone confirmation while reviewing, once, and only on a pending account case', async () => {
      const url = `/admin/verification/cases/${firstCase}/evidence`;
      expect((await call('POST', url, lister.token, { evidenceType: 'phone_confirmation' })).status).toBe(403);
      expect((await call('POST', url, admin1.token, { evidenceType: 'national_id' })).status).toBe(400);
      expect((await call('POST', url, admin1.token, {})).status).toBe(400);

      const added = await call('POST', url, admin1.token, { evidenceType: 'phone_confirmation' });
      expect(added.status).toBe(201);
      expect(added.body.data.phoneConfirmedAt).toBeTruthy();
      const row = await db('verification_evidence').where({ case_id: firstCase, evidence_type: 'phone_confirmation' }).first();
      expect(row).toMatchObject({ file_id: null });
      expect(row.phone_confirmed_at).toBeTruthy();
      expect((await call('POST', url, admin1.token, { evidenceType: 'phone_confirmation' })).status).toBe(409);
      expect(await db('audit_log').where({ object_id: firstCase, action: 'verification.evidence.add' }).first()).toBeTruthy();
    });

    it('rejects with a reason (mandatory), shows it to the applicant, and tells them (N-01)', async () => {
      expect((await decide(admin1, firstCase, 'reject')).status).toBe(400); // no reason
      expect((await decide(lister, firstCase, 'approve')).status).toBe(403); // not an Admin
      expect(await profileStatus(lister.id)).toBe('pending');

      const res = await decide(admin1, firstCase, 'reject', 'The ID photo is unreadable');
      expect(res.status).toBe(200);
      expect(res.body.data.case).toMatchObject({ status: 'rejected', decisionReason: 'The ID photo is unreadable', decidedBy: { id: admin1.id } });
      expect(await profileStatus(lister.id)).toBe('rejected');

      const mine = await call('GET', '/verification/mine', lister.token);
      expect(mine.status).toBe(200);
      const item = mine.body.data.items.find((i: Body) => i.id === firstCase);
      expect(item).toMatchObject({ status: 'rejected', reason: 'The ID photo is unreadable', subjectType: 'account' });
      // Someone else's list does not show it.
      const others = await call('GET', '/verification/mine', agent.token);
      expect(others.body.data.items.find((i: Body) => i.id === firstCase)).toBeUndefined();

      const [n] = await notifs(lister.id, 'N-01');
      expect(n.payload).toMatchObject({ caseId: firstCase, decision: 'rejected', reason: 'The ID photo is unreadable' });
      expect(await db('notification_deliveries').where({ notification_id: n.id }).select('channel', 'status')).toEqual([
        { channel: 'email', status: 'pending' },
      ]);
      expect(await db('audit_log').where({ object_id: firstCase, action: 'verification.reject', actor_user_id: admin1.id, actor_type: 'staff' }).first()).toBeTruthy();

      // Evidence is frozen and the case cannot be decided twice.
      expect((await call('POST', `/admin/verification/cases/${firstCase}/evidence`, admin1.token, { evidenceType: 'phone_confirmation' })).status).toBe(409);
      const again = await decide(admin2, firstCase, 'approve');
      expect(again.status).toBe(409);
      expect(again.body.message).toContain('already rejected');
    });

    it('lets a Rejected applicant resubmit with a new file (not the one already attached)', async () => {
      expect((await submitAccount(lister, file1)).status).toBe(409); // already attached to the rejected case
      file2 = await newEvidence(lister.token, 'national-id-2.pdf');
      const res = await submitAccount(lister, file2);
      expect(res.status).toBe(201);
      secondCase = res.body.data.id;
      expect(await profileStatus(lister.id)).toBe('pending');
      expect(await casesOf({ subject_user_id: lister.id })).toHaveLength(2);
    });

    it('approves: Verified, applicant told, the publish gate sees it, and Verified cannot resubmit', async () => {
      const res = await decide(admin2, secondCase, 'approve');
      expect(res.status).toBe(200);
      expect(res.body.data.case).toMatchObject({ status: 'approved', decidedBy: { id: admin2.id } });
      expect(await profileStatus(lister.id)).toBe('verified');
      expect((await casesOf({ id: secondCase }))[0]).toMatchObject({ decided_by: admin2.id });
      expect((await casesOf({ id: secondCase }))[0].decided_at).toBeTruthy();
      expect((await notifs(lister.id, 'N-01')).at(-1)?.payload).toMatchObject({ decision: 'approved' });
      expect(await lonelyBlockers()).not.toContain('the lister is not verified');

      const again = await submitAccount(lister, await newEvidence(lister.token));
      expect(again.status).toBe(409);
      expect(again.body.message).toContain('already verified');
    });

    it('revokes with a mandatory reason: indicator gone, applicant told (N-03), gate closes again, can resubmit', async () => {
      expect((await revoke(admin1, 'account', lister.id)).status).toBe(400); // no reason
      expect((await revoke(lister, 'account', lister.id, 'x')).status).toBe(403);
      expect((await revoke(admin1, 'account', generateUuidV7(), 'x')).status).toBe(404);
      expect((await revoke(admin1, 'account', agent.id, 'x')).status).toBe(409); // not verified

      const res = await revoke(admin1, 'account', lister.id, 'Document found to be forged');
      expect(res.status).toBe(200);
      expect(res.body.data.case).toMatchObject({ status: 'revoked', revokeReason: 'Document found to be forged', revokedBy: { id: admin1.id } });
      expect(await profileStatus(lister.id)).toBe('revoked');
      expect(await lonelyBlockers()).toContain('the lister is not verified');

      const [n] = await notifs(lister.id, 'N-03');
      expect(n.payload).toMatchObject({ kind: 'revoked', subjectType: 'account', reason: 'Document found to be forged' });
      const mine = await call('GET', '/verification/mine', lister.token);
      expect(mine.body.data.items.find((i: Body) => i.id === secondCase)).toMatchObject({ status: 'revoked', reason: 'Document found to be forged' });
      expect((await revoke(admin1, 'account', lister.id, 'again')).status).toBe(409);

      const resubmit = await submitAccount(lister, await newEvidence(lister.token));
      expect(resubmit.status).toBe(201);
      expect(await profileStatus(lister.id)).toBe('pending');
    });

    it('refuses an Admin deciding their own account, in the service and in the database (BR-014)', async () => {
      await db('user_roles').insert({ user_id: admin1.id, role: 'landlord', granted_by: admin2.id });
      try {
        const submitted = await submitAccount(admin1, await newEvidence(admin1.token));
        expect(submitted.status).toBe(201);
        const caseId = submitted.body.data.id as string;

        const refused = await decide(admin1, caseId, 'approve');
        expect(refused.status).toBe(403);
        expect(refused.body.message).toContain('separation of duties');
        expect((await decide(admin1, caseId, 'reject', 'no')).status).toBe(403);
        expect((await call('POST', `/admin/verification/cases/${caseId}/evidence`, admin1.token, { evidenceType: 'phone_confirmation' })).status).toBe(403);
        expect((await call('GET', `/admin/verification/cases/${caseId}`, admin1.token)).body.data.review.canDecide).toBe(false);
        expect((await call('GET', `/admin/verification/cases/${caseId}`, admin2.token)).body.data.review.canDecide).toBe(true);

        // The service check never gets that far when the database is asked directly: ck_vc_separation refuses.
        await expect(
          (async () => {
            await db('verification_cases').where({ id: caseId }).update({ status: 'approved', decided_by: admin1.id, decided_at: db.fn.now() });
          })(),
        ).rejects.toMatchObject({ code: '23514', constraint: 'ck_vc_separation' });
        expect((await casesOf({ id: caseId }))[0].status).toBe('pending');

        expect((await decide(admin2, caseId, 'approve')).status).toBe(200);
      } finally {
        await db('user_roles').where({ user_id: admin1.id, role: 'landlord' }).delete();
      }
    });

    it('lets exactly one of two Admins win a race on the same case; the loser gets a clear 409', async () => {
      const racer = await register('agent', nextPhone());
      const submitted = await submitAccount(racer, await newEvidence(racer.token));
      const caseId = submitted.body.data.id as string;

      const [a, b] = await Promise.all([decide(admin1, caseId, 'approve'), decide(admin2, caseId, 'reject', 'Not convincing')]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 409]);
      const loser = a.status === 409 ? a : b;
      expect(loser.body.message).toMatch(/already (approved|rejected)/);

      const final = (await casesOf({ id: caseId }))[0];
      expect(final.status).toBe(a.status === 200 ? 'approved' : 'rejected');
      expect(await profileStatus(racer.id)).toBe(final.status === 'approved' ? 'verified' : 'rejected');
      expect(await notifs(racer.id, 'N-01')).toHaveLength(1);
    });
  });

  // ---- buildings ---------------------------------------------------------------------------

  describe('building verification (FR-VER-003, -004, -006)', () => {
    let owner: Account;
    let coMaintainer: Account;
    let buildingId = '';
    let caseId = '';

    beforeAll(async () => {
      owner = await register('landlord', nextPhone());
      coMaintainer = await register('agent', nextPhone());
      buildingId = (await createBuilding(owner.token)).id;
      expect((await call('POST', `/buildings/${buildingId}/maintainers`, owner.token, { userId: coMaintainer.id })).status).toBe(201);
    });

    it('refuses non-maintainers, missing or wrong evidence, withdrawn and unknown buildings', async () => {
      expect((await submitBuilding(outsider, buildingId, await newEvidence(outsider.token))).status).toBe(403);
      expect((await submitBuilding(client, buildingId, await newEvidence(owner.token))).status).toBe(403);
      const asAdmin = await submitBuilding(admin1, buildingId, await newEvidence(admin1.token));
      expect(asAdmin.status).toBe(403); // an Admin acting on behalf cannot apply for the building
      expect((await call('POST', `/verification/buildings/${buildingId}`, null, {})).status).toBe(401);

      const none = await submitBuilding(owner, buildingId);
      expect(none.status).toBe(400);
      expect(none.body.message).toContain('proof_of_authority');
      const wrongType = await call('POST', `/verification/buildings/${buildingId}`, owner.token, evidenceBody('national_id', await newEvidence(owner.token)));
      expect(wrongType.status).toBe(400);
      expect((await submitBuilding(owner, buildingId, await newEvidence(outsider.token))).status).toBe(400); // not their file
      expect((await submitBuilding(owner, generateUuidV7(), await newEvidence(owner.token))).status).toBe(404);

      const withdrawn = (await createBuilding(owner.token)).id;
      expect((await call('POST', `/buildings/${withdrawn}/withdraw`, owner.token)).status).toBe(200);
      expect((await submitBuilding(owner, withdrawn, await newEvidence(owner.token))).status).toBe(409);
      expect(await buildingStatus(buildingId)).toBe('unverified');
    });

    it('submits: pending case, cache moved by T3, visible to every maintainer, in the Admin queue', async () => {
      const res = await submitBuilding(owner, buildingId, await newEvidence(owner.token, 'title-deed.pdf'));
      expect(res.status).toBe(201);
      caseId = res.body.data.id;
      expect(res.body.data).toMatchObject({ subjectType: 'building', status: 'pending', building: { id: buildingId }, evidenceTypes: ['proof_of_authority'] });
      expect(await buildingStatus(buildingId)).toBe('pending');
      expect((await casesOf({ id: caseId }))[0]).toMatchObject({ subject_building_id: buildingId, submitted_by: owner.id });

      const dup = await submitBuilding(coMaintainer, buildingId, await newEvidence(coMaintainer.token));
      expect(dup.status).toBe(409);
      expect(dup.body.message).toContain('already pending');

      const mine = await call('GET', '/verification/mine', coMaintainer.token);
      expect(mine.body.data.items.find((i: Body) => i.id === caseId)).toMatchObject({ status: 'pending', building: { id: buildingId } });
      expect((await call('GET', '/verification/mine', outsider.token)).body.data.items.find((i: Body) => i.id === caseId)).toBeUndefined();

      const queue = await call('GET', '/admin/verification/cases?subject=building&limit=100', admin1.token);
      const row = queue.body.data.items.find((i: Body) => i.id === caseId);
      expect(row).toMatchObject({ subjectType: 'building', subject: { type: 'building', buildingId, name: 'Verification Court' }, evidenceCount: 1 });
      const detail = await call('GET', `/admin/verification/cases/${caseId}`, admin1.token);
      expect(detail.body.data.subject.maintainers.map((m: Body) => m.userId).sort()).toEqual([owner.id, coMaintainer.id].sort());
      expect(detail.body.data.evidence[0]).toMatchObject({ evidenceType: 'proof_of_authority', file: { originalName: 'title-deed.pdf' } });
    });

    it('rejects with a reason: the maintainers see it and are told (N-02)', async () => {
      expect((await decide(admin2, caseId, 'reject')).status).toBe(400);
      expect((await decide(owner, caseId, 'reject', 'x')).status).toBe(403);
      expect((await decide(admin2, caseId, 'reject', 'Authority letter is not signed')).status).toBe(200);
      expect(await buildingStatus(buildingId)).toBe('rejected');

      expect(await recipientsOfCase('N-02', caseId)).toEqual([owner.id, coMaintainer.id].sort());
      const [n] = await notifs(coMaintainer.id, 'N-02');
      expect(n.payload).toMatchObject({ decision: 'rejected', reason: 'Authority letter is not signed', buildingId, buildingName: 'Verification Court' });
      const mine = await call('GET', '/verification/mine', coMaintainer.token);
      expect(mine.body.data.items.find((i: Body) => i.id === caseId)).toMatchObject({ status: 'rejected', reason: 'Authority letter is not signed' });
    });

    it('approves after a resubmission, without publishing the building; Verified cannot resubmit', async () => {
      const resubmitted = await submitBuilding(coMaintainer, buildingId, await newEvidence(coMaintainer.token));
      expect(resubmitted.status).toBe(201);
      expect(await buildingStatus(buildingId)).toBe('pending');
      caseId = resubmitted.body.data.id;

      expect((await decide(admin2, caseId, 'approve', 'Checked against the title deed')).status).toBe(200);
      expect(await buildingStatus(buildingId)).toBe('verified');
      expect((await casesOf({ id: caseId }))[0]).toMatchObject({ decided_by: admin2.id, decision_reason: 'Checked against the title deed' });
      expect(await recipientsOfCase('N-02', caseId)).toEqual([owner.id, coMaintainer.id].sort());
      expect(((await db('buildings').where({ id: buildingId }).first('status')) as Body).status).toBe('draft');

      const again = await submitBuilding(owner, buildingId, await newEvidence(owner.token));
      expect(again.status).toBe(409);
      expect(again.body.message).toContain('already verified');
    });

    it('revokes: indicator gone, maintainers told (N-03), reason shown, resubmission allowed', async () => {
      expect((await revoke(admin1, 'building', buildingId)).status).toBe(400);
      expect((await revoke(owner, 'building', buildingId, 'x')).status).toBe(403);
      expect((await revoke(admin1, 'building', generateUuidV7(), 'x')).status).toBe(404);

      const res = await revoke(admin1, 'building', buildingId, 'Ownership dispute');
      expect(res.status).toBe(200);
      expect(await buildingStatus(buildingId)).toBe('revoked');
      const revokedCase = res.body.data.case.id as string;
      expect(await recipientsOfCase('N-03', revokedCase)).toEqual([owner.id, coMaintainer.id].sort());
      expect((await notifs(owner.id, 'N-03')).at(-1)?.payload).toMatchObject({ kind: 'revoked', subjectType: 'building', reason: 'Ownership dispute', buildingId });
      const mine = await call('GET', '/verification/mine', owner.token);
      expect(mine.body.data.items.find((i: Body) => i.id === revokedCase)).toMatchObject({ status: 'revoked', reason: 'Ownership dispute' });
      expect((await revoke(admin1, 'building', buildingId, 'again')).status).toBe(409);

      expect((await submitBuilding(owner, buildingId, await newEvidence(owner.token))).status).toBe(201);
      expect(await buildingStatus(buildingId)).toBe('pending');
    });
  });

  // ---- separation of duties ----------------------------------------------------------------

  describe('separation of duties: the "edited" half (BR-014, design §8.1)', () => {
    let lister: Account;

    beforeAll(async () => {
      lister = await register('landlord', nextPhone());
    });

    it('refuses an Admin who edited the building on behalf, on that building only', async () => {
      const edited = await createBuilding(lister.token);
      const other = await createBuilding(lister.token);
      const patch = await call('PATCH', `/buildings/${edited.id}`, admin2.token, { version: edited.version, name: 'Renamed by staff' });
      expect(patch.status).toBe(200);
      expect(await db('audit_log').where({ object_id: edited.id, action: 'building.update', actor_user_id: admin2.id, actor_type: 'staff' }).first()).toBeTruthy();

      const caseId = (await submitBuilding(lister, edited.id, await newEvidence(lister.token))).body.data.id as string;
      const otherCase = (await submitBuilding(lister, other.id, await newEvidence(lister.token))).body.data.id as string;

      const approve = await decide(admin2, caseId, 'approve');
      expect(approve.status).toBe(403);
      expect(approve.body.message).toContain('You edited this building');
      expect((await decide(admin2, caseId, 'reject', 'no')).status).toBe(403);
      expect((await call('GET', `/admin/verification/cases/${caseId}`, admin2.token)).body.data.review).toMatchObject({ canDecide: false });
      expect(await buildingStatus(edited.id)).toBe('pending');

      expect((await decide(admin2, otherCase, 'approve')).status).toBe(200); // never touched that one
      expect((await decide(admin1, caseId, 'approve')).status).toBe(200); // another Admin may
    });

    it('refuses the Admin who created the building on behalf of the lister', async () => {
      const res = await call('POST', '/buildings', admin1.token, buildingBody({ listerId: lister.id }));
      expect(res.status).toBe(201);
      const buildingId = res.body.data.id as string;
      const caseId = (await submitBuilding(lister, buildingId, await newEvidence(lister.token))).body.data.id as string;

      const refused = await decide(admin1, caseId, 'approve');
      expect(refused.status).toBe(403);
      expect(refused.body.message).toContain('created, list or maintain');
      expect((await decide(admin2, caseId, 'approve')).status).toBe(200);
    });

    it('counts a staff availability change as an edit', async () => {
      const building = await createBuilding(lister.token);
      const spaceType = await createSpaceType(lister.token, building.id, 'Studio');
      await db('availability_events').insert({
        space_type_id: spaceType.id, event_type: 'confirmed', old_count: 2, new_count: 2,
        actor_user_id: admin3.id, acted_as_staff: true, source: 'admin',
      });
      const caseId = (await submitBuilding(lister, building.id, await newEvidence(lister.token))).body.data.id as string;

      expect((await decide(admin3, caseId, 'approve')).status).toBe(403);
      expect((await decide(admin2, caseId, 'approve')).status).toBe(200);
    });
  });

  // ---- re-verification on material change --------------------------------------------------

  describe('re-verification on material change (FR-VER-007)', () => {
    let owner: Account;
    let agent: Account;

    beforeAll(async () => {
      owner = await register('landlord', nextPhone());
      agent = await register('agent', nextPhone());
    });

    async function verifiedBuildingWithAgent() {
      const building = await createBuilding(owner.token);
      expect((await call('POST', `/buildings/${building.id}/maintainers`, owner.token, { userId: agent.id })).status).toBe(201);
      const approvedCase = await verifyBuilding(owner, building.id);
      return { ...building, approvedCase };
    }

    async function expectReopened(buildingId: string, approvedCase: string, changed: string[], actor: Account, actorType: 'user' | 'staff') {
      expect(await buildingStatus(buildingId)).toBe('pending');
      const cases = await casesOf({ subject_building_id: buildingId });
      expect(cases.find((c) => c.id === approvedCase)?.status).toBe('superseded');
      const reopened = cases.at(-1)!;
      expect(reopened).toMatchObject({ origin: 'material_change', status: 'pending', submitted_by: null });

      expect(await recipientsOfCase('N-03', reopened.id)).toEqual([...new Set([owner.id, agent.id, ...(await adminIds())])].sort());
      const n = (await notifs(agent.id, 'N-03')).find((x) => x.payload.caseId === reopened.id);
      expect(n?.payload).toMatchObject({ kind: 'reopened', cause: 'material_change', subjectType: 'building', buildingId, changed });
      const audit = await db('audit_log').where({ object_id: reopened.id, action: 'verification.reopen' }).first();
      expect(audit).toMatchObject({ actor_user_id: actor.id, actor_type: actorType, building_id: buildingId });
      return reopened.id as string;
    }

    it('reopens when a maintainer moves the pin, and tells the maintainers and every Admin (N-03)', async () => {
      const b = await verifiedBuildingWithAgent();
      const res = await call('PATCH', `/buildings/${b.id}`, owner.token, { version: b.version, latitude: -1.3, longitude: 36.9 });
      expect(res.status).toBe(200);
      expect(res.body.data.verificationStatus).toBe('pending'); // the response already shows it
      const reopenedId = await expectReopened(b.id, b.approvedCase, ['pin'], owner, 'user');

      const queue = await call('GET', '/admin/verification/cases?subject=building&limit=100', admin1.token);
      expect(queue.body.data.items.find((i: Body) => i.id === reopenedId)).toMatchObject({ origin: 'material_change', submittedBy: null });
    });

    it('reopens when an Admin changes the area on behalf, recorded as staff, and that Admin cannot approve it', async () => {
      const b = await verifiedBuildingWithAgent();
      const res = await call('PATCH', `/buildings/${b.id}`, admin2.token, { version: b.version, areaId: otherAreaId });
      expect(res.status).toBe(200);
      const reopenedId = await expectReopened(b.id, b.approvedCase, ['area'], admin2, 'staff');

      expect((await decide(admin2, reopenedId, 'approve')).status).toBe(403);
      expect((await decide(admin1, reopenedId, 'approve')).status).toBe(200);
      expect(await buildingStatus(b.id)).toBe('verified');
      expect(await recipientsOfCase('N-02', reopenedId)).toEqual([owner.id, agent.id].sort());
    });

    it('does not reopen for a name edit or a space-type edit, by a maintainer or an Admin', async () => {
      const b = await verifiedBuildingWithAgent();
      const spaceType = await createSpaceType(owner.token, b.id, 'Two bedroom');
      const before = await casesOf({ subject_building_id: b.id });
      const notificationsBefore = await db('notifications').where({ event_code: 'N-03' }).whereRaw("payload->>'buildingId' = ?", [b.id]);

      expect((await call('PATCH', `/buildings/${b.id}`, owner.token, { version: b.version, name: 'New name only' })).status).toBe(200);
      const edit = await call('PATCH', `/space-types/${spaceType.id}`, owner.token, { version: spaceType.version, rentAmount: 16000 });
      expect(edit.status).toBe(200);
      expect((await call('PATCH', `/space-types/${spaceType.id}`, admin2.token, { version: edit.body.data.version, rentAmount: 17000 })).status).toBe(200);

      expect(await buildingStatus(b.id)).toBe('verified');
      expect(await casesOf({ subject_building_id: b.id })).toHaveLength(before.length);
      expect(await db('notifications').where({ event_code: 'N-03' }).whereRaw("payload->>'buildingId' = ?", [b.id])).toHaveLength(notificationsBefore.length);
    });

    it('reopens a Verified account when display name or phone changes, tells every Admin, and ignores other fields', async () => {
      const nameChanger = await register('landlord', nextPhone());
      await verifyAccount(nameChanger);
      const approved = (await casesOf({ subject_user_id: nameChanger.id })).at(-1)!;

      expect((await call('PATCH', '/me', nameChanger.token, { language: 'sw' })).status).toBe(200);
      expect(await profileStatus(nameChanger.id)).toBe('verified'); // not an identity field
      expect(await casesOf({ subject_user_id: nameChanger.id })).toHaveLength(1);

      const res = await call('PATCH', '/me', nameChanger.token, { displayName: 'A New Name' });
      expect(res.status).toBe(200);
      expect(res.body.data.verificationStatus).toBe('pending');
      const cases = await casesOf({ subject_user_id: nameChanger.id });
      expect(cases.find((c) => c.id === approved.id)?.status).toBe('superseded');
      const reopened = cases.at(-1)!;
      expect(reopened).toMatchObject({ origin: 'material_change', status: 'pending', submitted_by: null });
      expect(await recipientsOfCase('N-03', reopened.id)).toEqual(await adminIds());
      expect((await notifs(admin1.id, 'N-03')).at(-1)?.payload).toMatchObject({ kind: 'reopened', subjectType: 'account', userId: nameChanger.id, changed: ['display_name'] });
      expect(await db('audit_log').where({ object_id: reopened.id, action: 'verification.reopen', actor_user_id: nameChanger.id }).first()).toBeTruthy();

      // Another edit while it is pending opens nothing more.
      expect((await call('PATCH', '/me', nameChanger.token, { displayName: 'Another Name' })).status).toBe(200);
      expect(await casesOf({ subject_user_id: nameChanger.id })).toHaveLength(2);

      // Phone on a different Verified account.
      const phoneChanger = await register('agent', nextPhone());
      await verifyAccount(phoneChanger);
      const changed = await call('PATCH', '/me', phoneChanger.token, { phone: nextPhone() });
      expect(changed.status).toBe(200);
      expect(await profileStatus(phoneChanger.id)).toBe('pending');
      const phoneCase = (await casesOf({ subject_user_id: phoneChanger.id })).at(-1)!;
      expect((await notifs(admin2.id, 'N-03')).find((n) => n.payload.caseId === phoneCase.id)?.payload).toMatchObject({ changed: ['phone'] });

      // The Admin queue shows it and an approval tells the account holder (N-01).
      const queue = await call('GET', '/admin/verification/cases?subject=account&limit=100', admin1.token);
      expect(queue.body.data.items.find((i: Body) => i.id === reopened.id)).toMatchObject({ origin: 'material_change', submittedBy: null });
      expect((await decide(admin1, reopened.id, 'approve')).status).toBe(200);
      expect(await profileStatus(nameChanger.id)).toBe('verified');
      expect((await notifs(nameChanger.id, 'N-01')).at(-1)?.payload).toMatchObject({ decision: 'approved', origin: 'material_change' });
    });
  });

  // ---- lister verified -> pending buildings (FR-VER-008, N-13) ------------------------------

  describe('lister verified, building awaiting confirmation (FR-VER-008, N-13)', () => {
    let lister: Account;
    let agent: Account;
    let buildingId = '';

    /** A building that satisfies BR-018 for a phoned lister: ready to publish. */
    async function readyBuilding(owner: Account) {
      const building = await createBuilding(owner.token);
      await addPhotos({ buildingId: building.id, category: 'cover' }, 1, owner.id);
      await addPhotos({ buildingId: building.id, category: 'grounds' }, 2, owner.id);
      await addPhotos({ buildingId: building.id, category: 'surroundings' }, 1, owner.id);
      const spaceType = await createSpaceType(owner.token, building.id, 'Unit A');
      await addPhotos({ spaceTypeId: spaceType.id }, 3, owner.id);
      expect((await call('PUT', `/buildings/${building.id}/contact`, owner.token, { userId: owner.id })).status).toBe(200);
      return building.id;
    }

    beforeAll(async () => {
      lister = await register('landlord', nextPhone());
      agent = await register('agent', nextPhone());
    });

    it('parks the building as pending while the lister is unverified', async () => {
      buildingId = await readyBuilding(lister);
      expect((await call('POST', `/buildings/${buildingId}/maintainers`, lister.token, { userId: agent.id })).status).toBe(201);
      const res = await call('POST', `/buildings/${buildingId}/publish`, lister.token);
      expect(res.status).toBe(200);
      expect(res.body.data.outcome).toBe('pending');
      expect(res.body.data.blockers).toEqual(['the lister is not verified']);
      expect(res.body.data.building.status).toBe('pending');
    });

    it('does not tell anyone when the lister is rejected', async () => {
      const submitted = await submitAccount(lister, await newEvidence(lister.token));
      expect((await decide(admin1, submitted.body.data.id, 'reject', 'Blurry')).status).toBe(200);
      expect(await notifs(lister.id, 'N-13')).toHaveLength(0);
      expect(await notifs(agent.id, 'N-13')).toHaveLength(0);
    });

    it('tells the maintainers when the lister becomes Verified, does not publish, and the next publish succeeds', async () => {
      const submitted = await submitAccount(lister, await newEvidence(lister.token));
      expect(submitted.status).toBe(201);
      expect((await decide(admin2, submitted.body.data.id, 'approve')).status).toBe(200);

      for (const who of [lister, agent]) {
        const [n] = await notifs(who.id, 'N-13');
        expect(n.payload).toMatchObject({ listerId: lister.id, buildingId });
        expect(await notifs(who.id, 'N-13')).toHaveLength(1);
      }
      expect(((await db('buildings').where({ id: buildingId }).first('status')) as Body).status).toBe('pending'); // never auto-published

      // pending -> published once the lister is verified (T5 sees the cache T3 set).
      const res = await call('POST', `/buildings/${buildingId}/publish`, agent.token);
      expect(res.status).toBe(200);
      expect(res.body.data.outcome).toBe('published');
      expect(res.body.data.building.status).toBe('published');
      expect(((await db('buildings').where({ id: buildingId }).first('status', 'published_at')) as Body).published_at).toBeTruthy();
    });

    it('does not notify for buildings that are not pending', async () => {
      const other = await register('landlord', nextPhone());
      const draft = await readyBuilding(other); // stays a draft: never published
      const submitted = await submitAccount(other, await newEvidence(other.token));
      expect((await decide(admin1, submitted.body.data.id, 'approve')).status).toBe(200);
      expect(await notifs(other.id, 'N-13')).toHaveLength(0);
      expect(((await db('buildings').where({ id: draft }).first('status')) as Body).status).toBe('draft');
    });
  });

  // ---- access control ----------------------------------------------------------------------

  describe('access control on every route', () => {
    it('answers 401 without credentials, 403 to non-admins on Admin routes, and 403 to non-maintainers', async () => {
      const id = generateUuidV7();
      const adminRoutes: Array<[string, string, unknown?]> = [
        ['GET', '/admin/verification/cases'],
        ['GET', `/admin/verification/cases/${id}`],
        ['POST', `/admin/verification/cases/${id}/evidence`, { evidenceType: 'phone_confirmation' }],
        ['POST', `/admin/verification/cases/${id}/decision`, { decision: 'approve' }],
        ['POST', '/admin/verification/revoke', { subject: 'account', id, reason: 'x' }],
      ];
      for (const [method, path, body] of adminRoutes) {
        expect((await call(method, path, null, body)).status, `${method} ${path} anonymous`).toBe(401);
        for (const who of [client, outsider]) {
          expect((await call(method, path, who.token, body)).status, `${method} ${path}`).toBe(403);
        }
      }

      const mine = await call('GET', '/verification/mine', null);
      expect(mine.status).toBe(401);
      const clientMine = await call('GET', '/verification/mine', client.token);
      expect(clientMine.status).toBe(200);
      expect(clientMine.body.data).toEqual({ items: [], nextCursor: null });

      const building = await createBuilding(outsider.token);
      expect((await submitBuilding(client, building.id, generateUuidV7())).status).toBe(403);
      expect((await call('POST', '/verification/account', client.token, {})).status).toBe(403);
    });
  });
});
