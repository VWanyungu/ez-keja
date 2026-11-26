import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import db from '../../db/knex.js';
import { withTx } from '../../db/tx.js';
import { mailTestAddress } from '../../lib/mail-test-address.js';
import { createNotifications } from '../../lib/notify.js';
import { createCommuteService, notifyMapsUsage } from '../commute/service.js';
import { call, register, startApp, stopApp, type Account, type Body } from '../search/search-fixtures.js';
import { BACKOFF_SECONDS, MAX_ATTEMPTS, deliverNotifications, type EmailSender } from './deliver.js';

beforeAll(startApp);
afterAll(stopApp);

let tag = 0;
// Every address a mail-capable test uses comes from lib/mail-test-address.ts. None is ever sent to:
// the worker only ever gets a fake sender here, and the suite runs with the Gmail keys blanked.
const email = (name: string) => mailTestAddress(`ntf-${name}-${Date.now()}-${(tag += 1)}`);

const emailOf = async (userId: string): Promise<string> => ((await db('auth_users').where({ id: userId }).first('email')) as Body).email;

const make = (userId: string, eventCode = 'N-05', payload: Record<string, unknown> = { buildingName: 'Acacia Court', spaceTypeName: 'Shop A' }) =>
  withTx(async (trx) => {
    await createNotifications(trx, [{ userId, eventCode, payload }]);
  });

const latest = async (userId: string): Promise<Body> =>
  (await db('notifications').where({ user_id: userId }).orderBy('created_at', 'desc').orderBy('id', 'desc').first()) as Body;

const deliveryOf = async (notificationId: string): Promise<Body> =>
  (await db('notification_deliveries').where({ notification_id: notificationId }).first()) as Body;

interface Sent {
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey?: string;
}

/** A sender that records what it was asked to send; `behaviour` can slow it down or make it fail. */
function fakeSender(behaviour: (message: Sent) => Promise<{ sent: boolean; skipped?: boolean }> | { sent: boolean; skipped?: boolean } = () => ({ sent: true })) {
  const sent: Sent[] = [];
  const sender: EmailSender = async (message) => {
    sent.push(message);
    return { provider: 'gmail', ...(await behaviour(message)) };
  };
  return { sender, sent };
}

/** Delivers whatever other suites left pending, so a test only sees its own rows. */
async function drain() {
  const sink = fakeSender();
  for (let i = 0; i < 50; i += 1) {
    const result = await deliverNotifications({ sender: sink.sender });
    if (result.claimed === 0) break;
  }
}

describe('Notifications (PostgreSQL integration)', () => {
  let alice: Account;
  let bob: Account;
  let kiswahili: Account;

  beforeAll(async () => {
    alice = await register(email('alice'), 'client');
    bob = await register(email('bob'), 'client');
    kiswahili = await register(email('sw'), 'client');
    await db('profiles').where({ user_id: kiswahili.id }).update({ language: 'sw' });
  });

  // ---- the in-app list --------------------------------------------------------------------------------

  describe('in-app endpoints (FR-NTF-001)', () => {
    it('requires a signed-in user on every route', async () => {
      expect((await call('GET', '/notifications', null)).status).toBe(401);
      expect((await call('GET', '/notifications/unread-count', null)).status).toBe(401);
      expect((await call('POST', '/notifications/read-all', null)).status).toBe(401);
      expect((await call('POST', '/notifications/019363c8-1234-7000-8000-00000000ffff/read', null)).status).toBe(401);
    });

    it('lists only my notifications, newest first, with rendered text in my language', async () => {
      const user = await register(email('lister'), 'client');
      await make(user.id, 'N-05', { buildingName: 'Acacia Court', spaceTypeName: 'Shop A', enquiryId: 'e1' });
      await make(user.id, 'N-08', { buildingName: 'Acacia Court', spaceTypeName: 'Shop A', reason: 'fully_let' });
      await make(bob.id, 'N-05');

      const res = await call('GET', '/notifications', user.token);
      expect(res.status).toBe(200);
      const items = res.body.data.items as Body[];
      expect(items.map((i) => i.eventCode)).toEqual(['N-08', 'N-05']);
      expect(items[0]).toMatchObject({ read: false, readAt: null, payload: { reason: 'fully_let' } });
      expect(items[0].title).toBe('Shop A at Acacia Court is now fully let');
      expect(items[1].payload.enquiryId).toBe('e1');
      expect(res.body.data.nextCursor).toBeNull();

      await db('profiles').where({ user_id: user.id }).update({ language: 'sw' });
      const sw = (await call('GET', '/notifications', user.token)).body.data.items as Body[];
      expect(sw[0].title).toBe('Shop A katika Acacia Court imejaa');
      expect(sw[1].title).toContain('Ujumbe mpya');
      // never a raw key, and an event this phase has no wording for still reads as a sentence
      await make(user.id, 'N-14', {});
      const generic = (await call('GET', '/notifications?limit=1', user.token)).body.data.items[0] as Body;
      expect(generic.title).toBe('Una arifa mpya');
      expect(generic.title).not.toContain('N-14');
    });

    it('pages by keyset and filters unread', async () => {
      const user = await register(email('pager'), 'client');
      for (let i = 0; i < 5; i += 1) await make(user.id, 'N-05', { enquiryId: `p${i}` });
      const all = (await db('notifications').where({ user_id: user.id }).orderBy('created_at', 'desc').orderBy('id', 'desc').select('id')) as Body[];

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res: { status: number; body: Body } = await call('GET', `/notifications?limit=2${cursor ? `&cursor=${cursor}` : ''}`, user.token);
        expect(res.status).toBe(200);
        seen.push(...res.body.data.items.map((i: Body) => i.id));
        cursor = res.body.data.nextCursor;
        pages += 1;
      } while (cursor);
      expect(pages).toBe(3);
      expect(seen).toEqual(all.map((r) => r.id));

      await call('POST', `/notifications/${all[0]!.id}/read`, user.token);
      const unread = await call('GET', '/notifications?unread=true&limit=100', user.token);
      expect(unread.body.data.items.map((i: Body) => i.id)).toEqual(all.slice(1).map((r) => r.id));
      expect((await call('GET', '/notifications?unread=maybe', user.token)).status).toBe(400);
      expect((await call('GET', '/notifications?cursor=garbage', user.token)).status).toBe(400);
      expect((await call('GET', '/notifications?limit=0', user.token)).status).toBe(400);
    });

    it('counts, marks one read and marks all read, touching only the caller', async () => {
      const mine = await register(email('mine'), 'client');
      const theirs = await register(email('theirs'), 'client');
      for (let i = 0; i < 3; i += 1) await make(mine.id);
      for (let i = 0; i < 2; i += 1) await make(theirs.id);
      const theirIds = (await db('notifications').where({ user_id: theirs.id }).pluck('id')) as string[];
      const myIds = (await db('notifications').where({ user_id: mine.id }).orderBy('id').pluck('id')) as string[];

      expect((await call('GET', '/notifications/unread-count', mine.token)).body.data.count).toBe(3);
      expect((await call('GET', '/notifications/unread-count', theirs.token)).body.data.count).toBe(2);

      // somebody else's id looks like "not found" and leaves their row alone
      const stranger = await call('POST', `/notifications/${theirIds[0]}/read`, mine.token);
      expect(stranger.status).toBe(404);
      expect((await db('notifications').where({ id: theirIds[0] }).first()).read_at).toBeNull();
      expect((await call('POST', '/notifications/019363c8-1234-7000-8000-00000000ffff/read', mine.token)).status).toBe(404);
      expect((await call('POST', '/notifications/not-a-uuid/read', mine.token)).status).toBe(400);

      const first = await call('POST', `/notifications/${myIds[0]}/read`, mine.token);
      expect(first.status).toBe(200);
      const readAt = (await db('notifications').where({ id: myIds[0] }).first()).read_at as Date;
      expect(readAt).not.toBeNull();
      await call('POST', `/notifications/${myIds[0]}/read`, mine.token); // idempotent: the time is kept
      expect(((await db('notifications').where({ id: myIds[0] }).first()).read_at as Date).getTime()).toBe(readAt.getTime());
      expect((await call('GET', '/notifications/unread-count', mine.token)).body.data.count).toBe(2);

      const all = await call('POST', '/notifications/read-all', mine.token);
      expect(all.body.data.updated).toBe(2);
      expect((await call('GET', '/notifications/unread-count', mine.token)).body.data.count).toBe(0);
      expect((await call('GET', '/notifications/unread-count', theirs.token)).body.data.count).toBe(2);
      expect(await db('notifications').whereIn('id', theirIds).whereNotNull('read_at').first()).toBeUndefined();
    });
  });

  // ---- the email delivery worker ------------------------------------------------------------------------

  describe('delivery worker (FR-NTF-001, FR-LOC-001)', () => {
    beforeAll(drain);

    const sentTo = (sent: Sent[], address: string) => sent.filter((m) => m.to === address);

    it('sends a pending delivery once and marks it sent, in English', async () => {
      await make(alice.id, 'N-05', { buildingName: 'Acacia <b>Court</b>', spaceTypeName: 'Shop A' });
      const n = await latest(alice.id);
      const { sender, sent } = fakeSender();
      const result = await deliverNotifications({ sender });
      expect(result.sent).toBeGreaterThanOrEqual(1);

      const mail = sentTo(sent, await emailOf(alice.id));
      expect(mail).toHaveLength(1);
      expect(mail[0]!.subject).toBe('New message about Shop A at Acacia <b>Court</b>');
      expect(mail[0]!.html).toContain('&lt;b&gt;Court&lt;/b&gt;'); // user-supplied text is escaped in the HTML part
      expect(mail[0]!.html).not.toContain('<b>Court');
      expect(mail[0]!.idempotencyKey).toBe(`notification-delivery-${(await deliveryOf(n.id)).id}`);

      const delivery = await deliveryOf(n.id);
      expect(delivery).toMatchObject({ status: 'sent', attempts: 1, last_error: null });
      expect(delivery.sent_at).not.toBeNull();
      // nothing left to do
      expect((await deliverNotifications({ sender: fakeSender().sender })).claimed).toBe(0);
    });

    it('renders Kiswahili for a Kiswahili recipient and falls back to English otherwise', async () => {
      await make(kiswahili.id, 'N-06', { buildingName: 'Acacia Court', spaceTypeName: 'Shop A' });
      await make(bob.id, 'N-06', { buildingName: 'Acacia Court', spaceTypeName: 'Shop A' });
      const { sender, sent } = fakeSender();
      await deliverNotifications({ sender });
      expect(sentTo(sent, await emailOf(kiswahili.id))[0]!.subject).toBe('Umejibiwa kuhusu Shop A katika Acacia Court');
      expect(sentTo(sent, await emailOf(bob.id))[0]!.subject).toBe('New reply about Shop A at Acacia Court');
    });

    it('delivers the earlier phases\' events unchanged (N-04 reminder, N-01 verification) with no raw keys', async () => {
      await make(alice.id, 'N-04', {
        count: 2,
        spaceTypes: [
          { spaceTypeId: 's1', name: 'Shop A', buildingId: 'b1', buildingName: 'Acacia Court', outdated: false },
          { spaceTypeId: 's2', name: 'Shop B', buildingId: 'b1', buildingName: 'Acacia Court', outdated: true },
        ],
      });
      await make(alice.id, 'N-01', { caseId: 'c1', subjectType: 'account', decision: 'rejected', reason: 'Blurry ID', origin: 'initial' });
      const { sender, sent } = fakeSender();
      await deliverNotifications({ sender });
      const mine = sentTo(sent, await emailOf(alice.id));
      expect(mine.map((m) => m.subject).sort()).toEqual(['Please confirm your vacant spaces', 'Your account verification was not approved']);
      expect(mine.find((m) => m.subject.startsWith('Please'))!.text).toContain('- Shop B at Acacia Court');
      expect(mine.find((m) => m.subject.startsWith('Your account'))!.text).toContain('Reason: Blurry ID');
      for (const m of mine) expect(`${m.subject} ${m.text}`).not.toMatch(/N-\d\d/);
    });

    it('keeps the in-app notification and logs a safe error when sending fails', async () => {
      await make(alice.id, 'N-05');
      const n = await latest(alice.id);
      const address = await emailOf(alice.id);
      const failing = fakeSender((m) => {
        throw Object.assign(new Error(`550 5.1.1 <${m.to}>: Recipient address rejected (user ${m.to})`), { code: 'EENVELOPE' });
      });
      const before = Date.now();
      const result = await deliverNotifications({ sender: failing.sender });
      expect(result.failed).toBeGreaterThanOrEqual(1);

      const delivery = await deliveryOf(n.id);
      expect(delivery).toMatchObject({ status: 'failed', attempts: 1, last_error: 'send_failed:EENVELOPE', sent_at: null });
      expect(delivery.last_error).not.toContain('@');
      expect(delivery.last_error).not.toContain(address);
      expect((delivery.next_attempt_at as Date).getTime()).toBeGreaterThan(before + (BACKOFF_SECONDS[0]! - 5) * 1000);

      // the in-app notification is exactly as it was, and still listed and countable
      const row = await db('notifications').where({ id: n.id }).first();
      expect(row).toMatchObject({ read_at: null, event_code: 'N-05' });
      expect((await call('GET', '/notifications?limit=100', alice.token)).body.data.items.map((i: Body) => i.id)).toContain(n.id);
    });

    it('retries with backoff, and gives up after the attempt cap', async () => {
      await make(bob.id, 'N-05');
      const n = await latest(bob.id);
      const failing = fakeSender(() => {
        throw new Error('smtp down');
      });
      const run = (now: Date) => deliverNotifications({ sender: failing.sender, now: () => now });
      const base = Date.now();

      await run(new Date(base));
      expect(await deliveryOf(n.id)).toMatchObject({ status: 'failed', attempts: 1, last_error: 'send_failed' });
      // too early: the backoff has not passed, so the row is not claimed
      const callsBefore = failing.sent.length;
      await run(new Date(base + 10_000));
      expect(failing.sent.length).toBe(callsBefore);
      expect((await deliveryOf(n.id)).attempts).toBe(1);

      for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt += 1) {
        await run(new Date(base + attempt * 4 * 3_600_000)); // far enough ahead for any backoff
        const row = await deliveryOf(n.id);
        expect(row.attempts).toBe(attempt);
        expect(row.status).toBe(attempt === MAX_ATTEMPTS ? 'abandoned' : 'failed');
      }
      const final = await deliveryOf(n.id);
      expect(final).toMatchObject({ status: 'abandoned', next_attempt_at: null, last_error: 'send_failed' });
      // abandoned rows are never picked up again
      const callsAfter = failing.sent.length;
      await run(new Date(base + 365 * 86_400_000));
      expect(failing.sent.length).toBe(callsAfter);
      expect((await deliveryOf(n.id)).attempts).toBe(MAX_ATTEMPTS);
    });

    it('recovers when a later attempt succeeds', async () => {
      await make(alice.id, 'N-07', { kind: 'requested', buildingName: 'Acacia Court', spaceTypeName: 'Shop A', proposedFor: '2026-12-01T07:00:00.000Z' });
      const n = await latest(alice.id);
      const base = Date.now();
      await deliverNotifications({ sender: fakeSender(() => { throw new Error('boom'); }).sender, now: () => new Date(base) });
      expect((await deliveryOf(n.id)).status).toBe('failed');
      const ok = fakeSender();
      await deliverNotifications({ sender: ok.sender, now: () => new Date(base + 3_600_000) });
      expect(await deliveryOf(n.id)).toMatchObject({ status: 'sent', attempts: 2, last_error: null });
      expect(sentTo(ok.sent, await emailOf(alice.id)).some((m) => m.subject === 'New viewing request for Shop A at Acacia Court, 2026-12-01 10:00 (EAT)')).toBe(true);
    });

    it('sends once when two runs overlap', async () => {
      const user = await register(email('overlap'), 'client');
      await make(user.id, 'N-05');
      const n = await latest(user.id);
      const address = await emailOf(user.id);
      const slow = fakeSender(async () => {
        await Bun.sleep(150);
        return { sent: true };
      });
      const results = await Promise.all([
        deliverNotifications({ sender: slow.sender }),
        deliverNotifications({ sender: slow.sender }),
        deliverNotifications({ sender: slow.sender }),
      ]);
      expect(sentTo(slow.sent, address)).toHaveLength(1);
      expect(results.reduce((sum, r) => sum + r.claimed, 0)).toBeGreaterThanOrEqual(1);
      expect(await deliveryOf(n.id)).toMatchObject({ status: 'sent', attempts: 1 });
    });

    it('abandons a recipient with no deliverable email without sending, and keeps last_error free of personal data', async () => {
      const erased = await register(email('erased'), 'client');
      await make(erased.id, 'N-05');
      const n = await latest(erased.id);
      await db('auth_users').where({ id: erased.id }).update({ email: `erased+${erased.id}@invalid` });
      await db('profiles').where({ user_id: erased.id }).update({ display_name: 'Deleted user', phone: null, erased_at: db.fn.now() });
      const { sender, sent } = fakeSender();
      await deliverNotifications({ sender });
      expect(sent.some((m) => m.to.includes('@invalid'))).toBe(false);
      const delivery = await deliveryOf(n.id);
      expect(delivery).toMatchObject({ status: 'abandoned', last_error: 'no_deliverable_email', next_attempt_at: null });
      expect(delivery.last_error).not.toContain('@');
      // the in-app row is untouched and the account can still read it
      expect((await db('notifications').where({ id: n.id }).first()).read_at).toBeNull();
    });

    it('treats a mailer that skipped sending (no provider configured) as a failed attempt, not a success', async () => {
      await make(bob.id, 'N-05');
      const n = await latest(bob.id);
      await deliverNotifications({ sender: fakeSender(() => ({ sent: false, skipped: true })).sender });
      expect(await deliveryOf(n.id)).toMatchObject({ status: 'failed', attempts: 1, last_error: 'mail_not_configured' });
    });

    it('never touches deliveries for other channels', async () => {
      const user = await register(email('sms'), 'client');
      await make(user.id, 'N-05');
      const n = await latest(user.id);
      await db('notification_deliveries').where({ notification_id: n.id }).delete();
      await db('notification_deliveries').insert({ notification_id: n.id, channel: 'sms', status: 'pending' });
      const { sender, sent } = fakeSender();
      await deliverNotifications({ sender });
      expect(sentTo(sent, await emailOf(user.id))).toHaveLength(0);
      expect(await deliveryOf(n.id)).toMatchObject({ channel: 'sms', status: 'pending', attempts: 0 });
    });
  });

  // ---- N-11: Maps usage -----------------------------------------------------------------------------------

  describe('Maps usage notifications (N-11, NFR-MON-01)', () => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const fakeGoogle = async (input: string): Promise<Response> =>
      input.includes('/geocode/')
        ? json({ status: 'OK', results: [{ formatted_address: 'Place', geometry: { location: { lat: -1.2, lng: 36.8 } } }] })
        : json({ status: 'OK', routes: [{ overview_polyline: { points: 'abc~' }, legs: [{ duration: { value: 600 }, distance: { value: 6000 } }] }] });

    const clock = { now: Date.UTC(2031, 5, 10, 12) };
    const quietLog = { warn: () => {}, error: () => {} };
    const build = () =>
      createCommuteService({
        loadPin: async () => ({ lat: -1.3, lng: 36.8 }),
        fetch: fakeGoogle,
        apiKey: () => 'test-key',
        dailyLimit: () => 10,
        now: () => clock.now,
        log: quietLog,
        onUsage: notifyMapsUsage,
      });
    // walking only: one geocode plus one route = 2 Google calls, and a new destination each time defeats the cache
    let place = 0;
    const walk = (service: ReturnType<typeof build>) =>
      service({ buildingId: '019363c8-1234-7000-8000-0000000000b1', destination: `Place ${(place += 1)}`, modes: ['walking'], time: { basis: 'now' } });

    const adminIds = async (): Promise<string[]> => ((await db('user_roles').where({ role: 'admin' }).orderBy('user_id').pluck('user_id')) as string[]);
    const n11 = async (day: string, threshold: number) =>
      (await db('notifications').where({ event_code: 'N-11' }).whereRaw("payload->>'dedupeKey' = ?", [`maps:${day}:${threshold}`])) as Body[];
    const waitFor = async (check: () => Promise<boolean>) => {
      for (let i = 0; i < 60; i += 1) {
        if (await check()) return;
        await Bun.sleep(50);
      }
      throw new Error('timed out waiting for the notification');
    };

    it('tells every Admin once at 80% and once at 100%, and not again that day, even from a second instance', async () => {
      const admins = await adminIds();
      expect(admins.length).toBeGreaterThan(0);
      const service = build();
      for (let i = 0; i < 3; i += 1) await walk(service); // 6 of 10 calls
      await Bun.sleep(100);
      expect(await n11('2031-06-10', 80)).toHaveLength(0);

      await walk(service); // 8 of 10: 80%
      await waitFor(async () => (await n11('2031-06-10', 80)).length === admins.length);
      expect((await n11('2031-06-10', 80)).map((r) => r.user_id).sort()).toEqual(admins);
      expect((await n11('2031-06-10', 80))[0].payload).toMatchObject({ threshold: 80, used: 8, limit: 10, day: '2031-06-10' });
      expect(await n11('2031-06-10', 100)).toHaveLength(0);

      await walk(service); // 10 of 10: 100%
      await waitFor(async () => (await n11('2031-06-10', 100)).length === admins.length);
      expect((await n11('2031-06-10', 100)).map((r) => r.user_id).sort()).toEqual(admins);

      // refused calls past the limit, a second process crossing the same thresholds: nothing new
      expect(await walk(service)).toMatchObject({ available: false });
      const other = build();
      for (let i = 0; i < 5; i += 1) await walk(other);
      await Bun.sleep(300);
      expect(await n11('2031-06-10', 80)).toHaveLength(admins.length);
      expect(await n11('2031-06-10', 100)).toHaveLength(admins.length);

      // the next day it can happen again
      clock.now += 86_400_000;
      const tomorrow = build();
      for (let i = 0; i < 4; i += 1) await walk(tomorrow);
      await waitFor(async () => (await n11('2031-06-11', 80)).length === admins.length);
      expect(await n11('2031-06-11', 100)).toHaveLength(0);
    });

    it('does not break the commute answer when recording the notification fails', async () => {
      const errors: string[] = [];
      const service = createCommuteService({
        loadPin: async () => ({ lat: -1.3, lng: 36.8 }),
        fetch: fakeGoogle,
        apiKey: () => 'test-key',
        dailyLimit: () => 2,
        now: () => clock.now,
        log: { warn: () => {}, error: (m) => errors.push(m) },
        onUsage: async () => {
          throw new Error('database is down for alice@example.com');
        },
      });
      expect(await walk(service)).toMatchObject({ available: true });
      await Bun.sleep(100);
      expect(errors.some((m) => m.includes('could not record'))).toBe(true);
      expect(errors.join('\n')).not.toContain('@'); // the error message is never logged, only its name
    });
  });
});
