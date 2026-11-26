import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import db from '../../db/knex.js';
import { mailTestAddress } from '../../lib/mail-test-address.js';
import {
  call,
  makeArea,
  referenceData,
  register,
  seedBuilding,
  startApp,
  stopApp,
  type Account,
  type Body,
} from '../search/search-fixtures.js';

beforeAll(startApp);
afterAll(stopApp);

let tag = 0;
const email = (name: string) => mailTestAddress(`eng-${name}-${Date.now()}-${(tag += 1)}`);
let phoneSeq = 0;
const phone = () => `+2547${String((phoneSeq += 1)).padStart(3, '0')}${String(Date.now()).slice(-6)}`;

const hoursAhead = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

const notifs = (userId: string, code: string, containing?: Record<string, unknown>) => {
  const query = db('notifications').where({ user_id: userId, event_code: code });
  if (containing) query.whereRaw('payload @> ?::jsonb', [JSON.stringify(containing)]);
  return query.orderBy('created_at').orderBy('id') as Promise<Body[]>;
};

const countNotifs = async (userId: string, code: string): Promise<number> => (await notifs(userId, code)).length;

describe('Engagement (PostgreSQL integration)', () => {
  let landlord: Account;
  let agent: Account;
  let outsider: Account;
  let client: Account;
  let client2: Account;
  let admin: Account;
  let ref: Awaited<ReturnType<typeof referenceData>>;
  let areaId: string;

  beforeAll(async () => {
    landlord = await register(email('landlord'), 'landlord', phone());
    agent = await register(email('agent'), 'agent', phone());
    outsider = await register(email('outsider'), 'landlord', phone());
    client = await register(email('client'), 'client');
    client2 = await register(email('client2'), 'client');
    const login = await call('POST', '/auth/login', null, { email: 'admin@khunt.local', password: 'password' });
    expect(login.status).toBe(200);
    admin = { id: login.body.data.user.id, token: login.body.data.tokens.accessToken };
    ref = await referenceData();
    areaId = await makeArea('Engagement area');
  });

  const vacant = (extra: Record<string, unknown> = {}) => ({ categoryId: ref.categoryA, currencyId: ref.kes, vacant: 3, ...extra });

  /** A published building the landlord and the agent maintain, with `types` space types. */
  const publishedBuilding = (types = 1, status: 'published' | 'draft' | 'suspended' = 'published') =>
    seedBuilding({
      areaId,
      listerId: landlord.id,
      maintainers: [agent.id],
      status,
      types: Array.from({ length: types }, (_, i) => vacant({ name: `Type ${i + 1}` })),
    });

  const enquire = (token: string | null, spaceTypeId: string, body: unknown = { body: 'Is it still available?' }) =>
    call('POST', `/space-types/${spaceTypeId}/enquiries`, token, body);

  // ---- enquiries ---------------------------------------------------------------------------------

  describe('starting and continuing an enquiry (TX-06, FR-ENQ-001)', () => {
    it('refuses a Guest with 401 and bad bodies with 400', async () => {
      const b = await publishedBuilding();
      expect((await enquire(null, b.typeIds[0]!)).status).toBe(401);
      expect((await enquire(client.token, b.typeIds[0]!, {})).status).toBe(400);
      expect((await enquire(client.token, b.typeIds[0]!, { body: '   ' })).status).toBe(400);
      expect((await enquire(client.token, b.typeIds[0]!, { body: 'x'.repeat(4001) })).status).toBe(400);
      expect((await enquire(client.token, b.typeIds[0]!, { body: 'hi', extra: 1 })).status).toBe(400);
      expect((await enquire(client.token, 'not-a-uuid')).status).toBe(400);
      expect(await db('enquiries').where({ space_type_id: b.typeIds[0] }).first()).toBeUndefined();
    });

    it('keeps one open thread per client and space type, and tells every maintainer (N-05)', async () => {
      const b = await publishedBuilding();
      const first = await enquire(client.token, b.typeIds[0]!, { body: 'First message' });
      expect(first.status).toBe(201);
      expect(first.body.data).toMatchObject({ newThread: true, status: 'new' });
      const second = await enquire(client.token, b.typeIds[0]!, { body: 'Second message' });
      expect(second.status).toBe(201);
      expect(second.body.data).toMatchObject({ newThread: false, enquiryId: first.body.data.enquiryId, status: 'new' });

      expect(await db('enquiries').where({ space_type_id: b.typeIds[0], client_id: client.id })).toHaveLength(1);
      expect(await db('enquiry_messages').where({ enquiry_id: first.body.data.enquiryId })).toHaveLength(2);

      for (const maintainer of [landlord, agent]) {
        const rows = await notifs(maintainer.id, 'N-05', { spaceTypeId: b.typeIds[0] });
        expect(rows).toHaveLength(2);
        expect(rows[0].payload).toMatchObject({ enquiryId: first.body.data.enquiryId, buildingId: b.id, newThread: true });
        expect(rows[1].payload).toMatchObject({ newThread: false });
      }
      // the maintainer who is not on this building, and other clients, are told nothing
      expect(await countNotifs(outsider.id, 'N-05')).toBe(0);
      expect(await countNotifs(client2.id, 'N-05')).toBe(0);
    });

    it('opens exactly one thread when the same client sends twice at once', async () => {
      const b = await publishedBuilding();
      const results = await Promise.all([enquire(client.token, b.typeIds[0]!, { body: 'A' }), enquire(client.token, b.typeIds[0]!, { body: 'B' })]);
      expect(results.map((r) => r.status)).toEqual([201, 201]);
      expect(await db('enquiries').where({ space_type_id: b.typeIds[0], client_id: client.id })).toHaveLength(1);
      expect(await db('enquiry_messages').whereIn('enquiry_id', db('enquiries').where({ space_type_id: b.typeIds[0] }).select('id'))).toHaveLength(2);
    });

    it('gives each client their own thread', async () => {
      const b = await publishedBuilding();
      const a = await enquire(client.token, b.typeIds[0]!);
      const c = await enquire(client2.token, b.typeIds[0]!);
      expect(a.body.data.enquiryId).not.toBe(c.body.data.enquiryId);
    });

    it('starts a new thread after the old one was closed (Q-D12)', async () => {
      const b = await publishedBuilding();
      const first = await enquire(client.token, b.typeIds[0]!);
      expect((await call('POST', `/enquiries/${first.body.data.enquiryId}/close`, client.token)).status).toBe(200);
      const again = await enquire(client.token, b.typeIds[0]!);
      expect(again.body.data.newThread).toBe(true);
      expect(again.body.data.enquiryId).not.toBe(first.body.data.enquiryId);
      const closed = await db('enquiries').where({ id: first.body.data.enquiryId }).first();
      expect(closed).toMatchObject({ status: 'closed', closed_reason: 'manual' });
    });

    it('refuses a Fully-let, removed or unpublished space type with 409, and an unknown one with 404', async () => {
      const fully = await seedBuilding({ areaId, listerId: landlord.id, types: [vacant({ vacant: 0 })] });
      const removed = await seedBuilding({ areaId, listerId: landlord.id, types: [vacant({ removed: true })] });
      const draft = await publishedBuilding(1, 'draft');
      const suspended = await publishedBuilding(1, 'suspended');
      const cases: Array<[string, string]> = [
        [fully.typeIds[0]!, 'SPACE_TYPE_FULLY_LET'],
        [removed.typeIds[0]!, 'SPACE_TYPE_REMOVED'],
        [draft.typeIds[0]!, 'BUILDING_UNAVAILABLE'],
        [suspended.typeIds[0]!, 'BUILDING_UNAVAILABLE'],
      ];
      for (const [id, code] of cases) {
        const res = await enquire(client.token, id);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe(code);
      }
      expect((await enquire(client.token, '019363c8-1234-7000-8000-00000000ffff')).status).toBe(404);
      expect(await db('enquiries').whereIn('space_type_id', cases.map(([id]) => id)).first()).toBeUndefined();
    });

    it('stops a maintainer from enquiring about their own building', async () => {
      const b = await publishedBuilding();
      const res = await enquire(agent.token, b.typeIds[0]!);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OWN_BUILDING');
    });
  });

  describe('replies, status and time to first response (FR-ENQ-005)', () => {
    it('sets first_response_at and moves new to responded on the first maintainer message (N-06)', async () => {
      const b = await publishedBuilding();
      const started = await enquire(client.token, b.typeIds[0]!);
      const id = started.body.data.enquiryId as string;
      expect((await db('enquiries').where({ id }).first()).first_response_at).toBeNull();

      const reply = await call('POST', `/enquiries/${id}/messages`, agent.token, { body: 'Yes, come and see it' });
      expect(reply.status).toBe(201);
      expect(reply.body.data.status).toBe('responded');
      const after = await db('enquiries').where({ id }).first();
      expect(after.status).toBe('responded');
      expect(after.first_response_at).not.toBeNull();

      // a second reply keeps the first response time; a client follow-up keeps the status (Q-D7)
      await call('POST', `/enquiries/${id}/messages`, landlord.token, { body: 'Anything else?' });
      await call('POST', `/enquiries/${id}/messages`, client.token, { body: 'Thanks, one more thing' });
      const later = await db('enquiries').where({ id }).first();
      expect(later.status).toBe('responded');
      expect(new Date(later.first_response_at).getTime()).toBe(new Date(after.first_response_at).getTime());

      const toClient = await notifs(client.id, 'N-06', { enquiryId: id });
      expect(toClient).toHaveLength(2); // one per maintainer reply
      expect(toClient[0].payload).toMatchObject({ buildingId: b.id, spaceTypeId: b.typeIds[0] });
      // the client's follow-up told the maintainers again (N-05), the replies did not
      const toMaintainers = await notifs(landlord.id, 'N-05', { enquiryId: id });
      expect(toMaintainers).toHaveLength(2);
    });

    it('lets an Admin reply as staff and audits it', async () => {
      const b = await publishedBuilding();
      const id = (await enquire(client.token, b.typeIds[0]!)).body.data.enquiryId as string;
      const reply = await call('POST', `/enquiries/${id}/messages`, admin.token, { body: 'Admin here, on their behalf' });
      expect(reply.status).toBe(201);
      expect((await db('enquiries').where({ id }).first()).status).toBe('responded');
      expect(await db('audit_log').where({ object_id: id, action: 'enquiry.reply', actor_user_id: admin.id, actor_type: 'staff' }).first()).toBeTruthy();
    });

    it('takes no messages on a closed thread, and only a participant can close one', async () => {
      const b = await publishedBuilding();
      const id = (await enquire(client.token, b.typeIds[0]!)).body.data.enquiryId as string;
      expect((await call('POST', `/enquiries/${id}/close`, outsider.token)).status).toBe(404);
      expect((await call('POST', `/enquiries/${id}/close`, client2.token)).status).toBe(404);
      expect((await call('POST', `/enquiries/${id}/close`, agent.token)).status).toBe(200);
      const twice = await call('POST', `/enquiries/${id}/close`, client.token);
      expect(twice.status).toBe(409);
      expect(twice.body.code).toBe('ENQUIRY_CLOSED');
      for (const who of [client, landlord]) {
        const res = await call('POST', `/enquiries/${id}/messages`, who.token, { body: 'too late' });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('ENQUIRY_CLOSED');
      }
    });

    it('counts enquiries awaiting a reply on the lister dashboard', async () => {
      const b = await publishedBuilding();
      const mineCount = async () => {
        const res = await call('GET', '/buildings/mine', landlord.token);
        return res.body.data.find((x: Body) => x.id === b.id).awaitingReplyCount as number;
      };
      expect(await mineCount()).toBe(0);
      const one = (await enquire(client.token, b.typeIds[0]!)).body.data.enquiryId as string;
      await enquire(client2.token, b.typeIds[0]!);
      expect(await mineCount()).toBe(2);
      await call('POST', `/enquiries/${one}/messages`, landlord.token, { body: 'Replied' });
      expect(await mineCount()).toBe(1);
      await call('POST', `/enquiries/${one}/messages`, client.token, { body: 'And again' }); // does not make it "awaiting" again
      expect(await mineCount()).toBe(1);
    });
  });

  describe('who can read what (NFR-PRV-02)', () => {
    it('shows a client only their own threads and a maintainer only their buildings', async () => {
      const mine = await publishedBuilding();
      const other = await seedBuilding({ areaId, listerId: outsider.id, types: [vacant()] });
      const t1 = (await enquire(client.token, mine.typeIds[0]!, { body: 'Secret one' })).body.data.enquiryId as string;
      const t2 = (await enquire(client2.token, mine.typeIds[0]!, { body: 'Secret two' })).body.data.enquiryId as string;
      const t3 = (await enquire(client.token, other.typeIds[0]!, { body: 'Elsewhere' })).body.data.enquiryId as string;

      const idsFor = async (who: Account, query = '') =>
        ((await call('GET', `/enquiries?limit=100${query}`, who.token)).body.data.items as Body[]).map((i) => i.id);
      const clientIds = await idsFor(client);
      expect(clientIds).toContain(t1);
      expect(clientIds).toContain(t3);
      expect(clientIds).not.toContain(t2);
      const landlordIds = await idsFor(landlord);
      expect(landlordIds).toContain(t1);
      expect(landlordIds).toContain(t2);
      expect(landlordIds).not.toContain(t3);
      expect(await idsFor(outsider)).toEqual(expect.arrayContaining([t3]));
      expect(await idsFor(outsider)).not.toContain(t1);

      // reading, replying and closing someone else's thread all look like "not found"
      for (const stranger of [client2, outsider]) {
        expect((await call('GET', `/enquiries/${t1}`, stranger.token)).status).toBe(404);
        expect((await call('POST', `/enquiries/${t1}/messages`, stranger.token, { body: 'hello' })).status).toBe(404);
        expect((await call('POST', `/enquiries/${t1}/close`, stranger.token)).status).toBe(404);
      }
      expect((await call('GET', `/enquiries/${t1}`, null)).status).toBe(401);
      expect(await db('audit_log').where({ object_id: t1, action: 'pii.view' }).first()).toBeUndefined();

      // participants read the thread in order, with who wrote what
      const detail = await call('GET', `/enquiries/${t1}`, landlord.token);
      expect(detail.status).toBe(200);
      expect(detail.body.data).toMatchObject({ role: 'maintainer', status: 'new', building: { id: mine.id } });
      expect(detail.body.data.messages.map((m: Body) => m.body)).toEqual(['Secret one']);
      expect(detail.body.data.messages[0].fromClient).toBe(true);
      expect((await call('GET', `/enquiries/${t1}`, client.token)).body.data.role).toBe('client');
      // a maintainer or client reading their own thread is not a PII access by staff
      expect(await db('audit_log').where({ object_id: t1, action: 'pii.view' }).first()).toBeUndefined();
    });

    it('lets an Admin read any thread and writes a pii.view audit row for it', async () => {
      const b = await publishedBuilding();
      const id = (await enquire(client.token, b.typeIds[0]!, { body: 'Private words' })).body.data.enquiryId as string;
      const res = await call('GET', `/enquiries/${id}`, admin.token);
      expect(res.status).toBe(200);
      expect(res.body.data.role).toBe('staff');
      const audit = await db('audit_log').where({ object_id: id, action: 'pii.view' });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_user_id: admin.id, actor_type: 'staff', object_type: 'enquiry', building_id: b.id });
      expect(JSON.stringify(audit[0].changes)).not.toContain('Private words');
    });

    it('pages "my enquiries" by keyset, filters by status and by side', async () => {
      const b = await publishedBuilding(3);
      const ids: string[] = [];
      for (const typeId of b.typeIds) ids.push((await enquire(client2.token, typeId)).body.data.enquiryId as string);
      await call('POST', `/enquiries/${ids[0]}/messages`, landlord.token, { body: 'reply' }); // responded, and now the most recent

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res: { status: number; body: Body } = await call('GET', `/enquiries?limit=2&as=client${cursor ? `&cursor=${cursor}` : ''}`, client2.token);
        expect(res.status).toBe(200);
        seen.push(...res.body.data.items.map((i: Body) => i.id));
        cursor = res.body.data.nextCursor;
        pages += 1;
      } while (cursor && pages < 20);
      expect(new Set(seen).size).toBe(seen.length); // no duplicates across pages
      for (const id of ids) expect(seen).toContain(id);
      expect(seen[0]).toBe(ids[0]); // most recently active first

      const newOnly = await call('GET', '/enquiries?status=new&as=maintainer&limit=100', landlord.token);
      const newIds = newOnly.body.data.items.map((i: Body) => i.id);
      expect(newIds).toContain(ids[1]);
      expect(newIds).not.toContain(ids[0]);
      expect((await call('GET', '/enquiries?status=bogus', landlord.token)).status).toBe(400);
      expect((await call('GET', '/enquiries?as=admin', landlord.token)).status).toBe(400);
      expect((await call('GET', '/enquiries?cursor=nonsense', landlord.token)).status).toBe(400);
    });
  });

  // ---- viewing requests ----------------------------------------------------------------------------

  describe('viewing requests (TX-07, FR-ENQ-002)', () => {
    const request = (token: string | null, spaceTypeId: string, requestedFor: unknown = hoursAhead(48)) =>
      call('POST', `/space-types/${spaceTypeId}/viewings`, token, { requestedFor });
    const act = (token: string | null, id: string, action: string, body?: unknown) => call('POST', `/viewings/${id}/${action}`, token, body);
    const statusOf = async (id: string) => (await db('viewing_requests').where({ id }).first()).status as string;

    const newViewing = async () => {
      const b = await publishedBuilding();
      const res = await request(client.token, b.typeIds[0]!);
      expect(res.status).toBe(201);
      return { building: b, id: res.body.data.id as string };
    };

    it('refuses a Guest, a past or malformed time, a Fully-let type and the maintainers themselves', async () => {
      const b = await publishedBuilding();
      const fully = await seedBuilding({ areaId, listerId: landlord.id, types: [vacant({ vacant: 0 })] });
      expect((await request(null, b.typeIds[0]!)).status).toBe(401);
      expect((await request(client.token, b.typeIds[0]!, new Date(Date.now() - 3_600_000).toISOString())).status).toBe(400);
      expect((await request(client.token, b.typeIds[0]!, '2030-01-01 10:00')).status).toBe(400);
      expect((await request(client.token, b.typeIds[0]!, 12345)).status).toBe(400);
      expect((await request(client.token, b.typeIds[0]!, new Date(Date.now() + 400 * 86_400_000).toISOString())).status).toBe(400);
      const full = await request(client.token, fully.typeIds[0]!);
      expect(full.status).toBe(409);
      expect(full.body.code).toBe('SPACE_TYPE_FULLY_LET');
      expect((await request(landlord.token, b.typeIds[0]!)).status).toBe(403);
      expect(await db('viewing_requests').where({ space_type_id: b.typeIds[0] }).first()).toBeUndefined();
    });

    it('tells the maintainers of a request (N-07) and the client of each response', async () => {
      const { building, id } = await newViewing();
      for (const maintainer of [landlord, agent]) {
        const rows = await notifs(maintainer.id, 'N-07', { viewingId: id });
        expect(rows).toHaveLength(1);
        expect(rows[0].payload).toMatchObject({ kind: 'requested', buildingId: building.id });
      }
      const accepted = await act(agent.token, id, 'accept');
      expect(accepted.status).toBe(200);
      expect(accepted.body.data).toMatchObject({ status: 'accepted' });
      expect(accepted.body.data.agreedFor).toBe(accepted.body.data.requestedFor);
      const toClient = await notifs(client.id, 'N-07', { viewingId: id });
      expect(toClient.map((r) => r.payload.kind)).toEqual(['accepted']);
      const row = await db('viewing_requests').where({ id }).first();
      expect(row).toMatchObject({ status: 'accepted', responded_by: agent.id });
      expect(row.responded_at).not.toBeNull();
    });

    it('runs the counter-proposal paths to accepted and to cancelled', async () => {
      const { id } = await newViewing();
      expect((await act(landlord.token, id, 'counter', { proposedFor: new Date(Date.now() - 3_600_000).toISOString() })).status).toBe(400);
      const newTime = hoursAhead(72);
      const countered = await act(landlord.token, id, 'counter', { proposedFor: newTime });
      expect(countered.status).toBe(200);
      expect(countered.body.data.status).toBe('counter_proposed');
      expect(new Date(countered.body.data.counterFor).getTime()).toBe(new Date(newTime).getTime());
      const accepted = await act(client.token, id, 'accept-counter');
      expect(accepted.body.data.status).toBe('accepted');
      expect(new Date(accepted.body.data.agreedFor).getTime()).toBe(new Date(newTime).getTime());
      const told = await notifs(landlord.id, 'N-07', { viewingId: id, kind: 'counter_accepted' });
      expect(told).toHaveLength(1);

      const second = await newViewing();
      await act(landlord.token, second.id, 'counter', { proposedFor: hoursAhead(96) });
      const declined = await act(client.token, second.id, 'decline-counter');
      expect(declined.status).toBe(200);
      expect(await db('viewing_requests').where({ id: second.id }).first()).toMatchObject({
        status: 'cancelled',
        cancel_reason: 'client_declined_counter',
        cancelled_by: client.id,
      });
      expect(await notifs(landlord.id, 'N-07', { viewingId: second.id, kind: 'counter_declined' })).toHaveLength(1);
    });

    it('lets the client cancel from requested, counter_proposed and accepted, and the maintainer decline', async () => {
      const a = await newViewing();
      expect((await act(client.token, a.id, 'cancel')).status).toBe(200);
      expect(await db('viewing_requests').where({ id: a.id }).first()).toMatchObject({ status: 'cancelled', cancel_reason: 'client' });
      const b = await newViewing();
      await act(agent.token, b.id, 'accept');
      expect((await act(client.token, b.id, 'cancel')).status).toBe(200);
      const c = await newViewing();
      await act(agent.token, c.id, 'counter', { proposedFor: hoursAhead(80) });
      expect((await act(client.token, c.id, 'cancel')).status).toBe(200);
      const d = await newViewing();
      expect((await act(landlord.token, d.id, 'decline')).status).toBe(200);
      expect(await statusOf(d.id)).toBe('declined');
      expect((await notifs(client.id, 'N-07', { viewingId: d.id, kind: 'declined' })).length).toBe(1);
    });

    it('refuses every illegal transition with 409 and leaves the row alone', async () => {
      const attempts: Array<{ from: string[]; action: string; as: 'client' | 'maintainer'; body?: unknown }> = [
        { from: ['accepted', 'declined', 'cancelled', 'counter_proposed'], action: 'accept', as: 'maintainer' },
        { from: ['accepted', 'declined', 'cancelled', 'counter_proposed'], action: 'decline', as: 'maintainer' },
        { from: ['accepted', 'declined', 'cancelled', 'counter_proposed'], action: 'counter', as: 'maintainer', body: { proposedFor: hoursAhead(60) } },
        { from: ['requested', 'accepted', 'declined', 'cancelled'], action: 'accept-counter', as: 'client' },
        { from: ['requested', 'accepted', 'declined', 'cancelled'], action: 'decline-counter', as: 'client' },
        { from: ['declined', 'cancelled'], action: 'cancel', as: 'client' },
      ];
      const states: Record<string, (id: string) => Promise<void>> = {
        accepted: async (id) => void (await act(landlord.token, id, 'accept')),
        declined: async (id) => void (await act(landlord.token, id, 'decline')),
        cancelled: async (id) => void (await act(client.token, id, 'cancel')),
        counter_proposed: async (id) => void (await act(landlord.token, id, 'counter', { proposedFor: hoursAhead(70) })),
        requested: async () => {},
      };
      for (const attempt of attempts) {
        for (const from of attempt.from) {
          const { id } = await newViewing();
          await states[from]!(id);
          expect(await statusOf(id)).toBe(from);
          const who = attempt.as === 'client' ? client : landlord;
          const res = await act(who.token, id, attempt.action, attempt.body);
          expect(`${from} -> ${attempt.action}: ${res.status}`).toBe(`${from} -> ${attempt.action}: 409`);
          expect(res.body.code).toBe('VIEWING_ALREADY_HANDLED');
          expect(await statusOf(id)).toBe(from);
        }
      }
    });

    it('keeps each side to its own actions, and strangers out', async () => {
      const { id } = await newViewing();
      for (const action of ['accept', 'decline']) {
        const res = await act(client.token, id, action);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('WRONG_PARTY');
      }
      expect((await act(client.token, id, 'counter', { proposedFor: hoursAhead(60) })).status).toBe(403);
      for (const action of ['accept-counter', 'decline-counter', 'cancel']) {
        expect((await act(landlord.token, id, action)).status).toBe(403);
      }
      for (const stranger of [client2, outsider]) {
        expect((await act(stranger.token, id, 'cancel')).status).toBe(404);
        expect((await act(stranger.token, id, 'accept')).status).toBe(404);
      }
      expect((await act(null, id, 'accept')).status).toBe(401);
      expect((await act(client.token, '019363c8-1234-7000-8000-00000000ffff', 'cancel')).status).toBe(404);
      expect(await statusOf(id)).toBe('requested');
    });

    it('lets exactly one of two parties win when they act on the same request at once', async () => {
      for (let round = 0; round < 4; round += 1) {
        const { id } = await newViewing();
        const [maintainerSide, clientSide] = await Promise.all([
          act(round % 2 === 0 ? landlord.token : agent.token, id, 'accept'),
          act(client.token, id, 'cancel'),
        ]);
        // Either accept lands first and the cancel then also succeeds (an accepted viewing can be
        // cancelled): 200 + 200, ending cancelled. Or cancel lands first and the accept is refused:
        // 409 + 200, ending cancelled. Nothing ends "accepted" because the client's cancel always works.
        expect(clientSide.status).toBe(200);
        expect([200, 409]).toContain(maintainerSide.status);
        expect(await statusOf(id)).toBe('cancelled');
      }
      // two maintainers racing to accept and decline the same request: one wins, the other is told it was handled
      const { id } = await newViewing();
      const [x, y] = await Promise.all([act(landlord.token, id, 'accept'), act(agent.token, id, 'decline')]);
      expect([x.status, y.status].sort()).toEqual([200, 409]);
      expect(await statusOf(id)).toBe(x.status === 200 ? 'accepted' : 'declined');
    });

    it('refuses to accept a time that has already passed', async () => {
      const { id } = await newViewing();
      await db('viewing_requests').where({ id }).update({ requested_for: new Date(Date.now() - 3_600_000) });
      const res = await act(landlord.token, id, 'accept');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('VIEWING_TIME_PASSED');
      expect(await statusOf(id)).toBe('requested');
    });

    it('lets an Admin act for the maintainers and audits it', async () => {
      const { id } = await newViewing();
      expect((await act(admin.token, id, 'accept')).status).toBe(200);
      expect(await db('audit_log').where({ object_id: id, action: 'viewing.accept', actor_type: 'staff', actor_user_id: admin.id }).first()).toBeTruthy();
      expect((await act(admin.token, id, 'cancel')).status).toBe(403); // cancelling is the client's action
    });

    it('lists my viewings as client or maintainer, filtered and paged', async () => {
      const b = await publishedBuilding();
      const made: string[] = [];
      for (let i = 0; i < 3; i += 1) made.push((await request(client2.token, b.typeIds[0]!, hoursAhead(30 + i))).body.data.id as string);
      await act(landlord.token, made[0]!, 'decline');

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const res: { status: number; body: Body } = await call('GET', `/viewings?as=client&limit=2${cursor ? `&cursor=${cursor}` : ''}`, client2.token);
        expect(res.status).toBe(200);
        seen.push(...res.body.data.items.map((i: Body) => i.id));
        cursor = res.body.data.nextCursor;
      } while (cursor);
      expect(seen).toEqual([...made].reverse()); // newest first
      const requestedOnly = await call('GET', '/viewings?status=requested&as=maintainer&limit=100', agent.token);
      const ids = requestedOnly.body.data.items.map((i: Body) => i.id);
      expect(ids).toContain(made[1]);
      expect(ids).not.toContain(made[0]);
      expect(requestedOnly.body.data.items.find((i: Body) => i.id === made[1])).toMatchObject({ role: 'maintainer', building: { id: b.id } });
      // someone else's viewings never show up
      expect((await call('GET', '/viewings?limit=100', client.token)).body.data.items.map((i: Body) => i.id)).not.toContain(made[1]);
      expect((await call('GET', '/viewings?limit=100', outsider.token)).body.data.items.map((i: Body) => i.id)).not.toContain(made[1]);
      expect((await call('GET', '/viewings', null)).status).toBe(401);
      expect((await call('GET', '/viewings?status=nope', client.token)).status).toBe(400);
    });
  });

  // ---- N-08: the space type stops being available ----------------------------------------------------

  describe('Fully let and removal tell the clients (N-08, FR-AVL-009)', () => {
    const setup = async () => {
      const b = await publishedBuilding(2);
      const target = b.typeIds[0]!;
      const e1 = (await enquire(client.token, target)).body.data.enquiryId as string;
      const v2 = (await call('POST', `/space-types/${target}/viewings`, client2.token, { requestedFor: hoursAhead(40) })).body.data.id as string;
      // client3 has an enquiry and a viewing: one notification, not two
      const client3 = await register(email('client3'), 'client');
      await enquire(client3.token, target);
      await call('POST', `/space-types/${target}/viewings`, client3.token, { requestedFor: hoursAhead(41) });
      // an enquiry on the other space type must be left alone
      const untouched = (await enquire(client.token, b.typeIds[1]!)).body.data.enquiryId as string;
      return { b, target, e1, v2, client3, untouched };
    };

    const n08 = (userId: string, spaceTypeId: string) =>
      notifs(userId, 'N-08', { spaceTypeId });

    it('closes, cancels and notifies once per client when the count reaches 0', async () => {
      const { b, target, e1, v2, client3, untouched } = await setup();
      const res = await call('POST', `/space-types/${target}/fully-let`, landlord.token);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ closedEnquiries: 2, cancelledViewings: 2 });

      expect(await db('enquiries').where({ id: e1 }).first()).toMatchObject({ status: 'closed', closed_reason: 'fully_let' });
      expect(await db('viewing_requests').where({ id: v2 }).first()).toMatchObject({ status: 'cancelled', cancel_reason: 'fully_let' });
      expect((await db('enquiries').where({ id: untouched }).first()).status).toBe('new');

      for (const who of [client, client2, client3]) {
        const rows = await n08(who.id, target);
        expect(rows).toHaveLength(1);
        expect(rows[0].payload).toMatchObject({ reason: 'fully_let', buildingId: b.id, buildingName: expect.any(String) });
      }
      expect(await n08(outsider.id, target)).toHaveLength(0);
      expect(await n08(landlord.id, target)).toHaveLength(0);
    });

    it('does the same when the space type is removed', async () => {
      const { target, client3 } = await setup();
      const res = await call('DELETE', `/space-types/${target}`, landlord.token);
      expect(res.status).toBe(200);
      for (const who of [client, client2, client3]) {
        const rows = await n08(who.id, target);
        expect(rows).toHaveLength(1);
        expect(rows[0].payload).toMatchObject({ reason: 'space_type_removed' });
      }
    });

    it('does not notify anyone when the count falls but does not reach 0, or nobody was waiting', async () => {
      const b = await publishedBuilding(1);
      await enquire(client.token, b.typeIds[0]!);
      await call('PUT', `/space-types/${b.typeIds[0]}/vacant-count`, landlord.token, { vacantCount: 1 });
      expect(await notifs(client.id, 'N-08', { spaceTypeId: b.typeIds[0] })).toHaveLength(0);
      const empty = await publishedBuilding(1);
      await call('POST', `/space-types/${empty.typeIds[0]}/fully-let`, landlord.token);
      expect(await db('notifications').where({ event_code: 'N-08' }).whereRaw("payload->>'spaceTypeId' = ?", [empty.typeIds[0]!])).toHaveLength(0);
    });
  });

  // ---- reports ----------------------------------------------------------------------------------------

  describe('reports (FR-AVL-010, FR-ADM-005)', () => {
    const reportBuilding = (token: string | null, id: string, body: unknown = { reason: 'unavailable', comment: 'Rented out already' }) =>
      call('POST', `/buildings/${id}/reports`, token, body);
    const reportType = (token: string | null, id: string, body: unknown = { reason: 'inaccurate' }) =>
      call('POST', `/space-types/${id}/reports`, token, body);

    it('refuses a Guest, a bad reason, an over-long comment and a hidden building', async () => {
      const b = await publishedBuilding();
      const draft = await publishedBuilding(1, 'draft');
      expect((await reportBuilding(null, b.id)).status).toBe(401);
      expect((await reportBuilding(client.token, b.id, { reason: 'rude' })).status).toBe(400);
      expect((await reportBuilding(client.token, b.id, {})).status).toBe(400);
      expect((await reportBuilding(client.token, b.id, { reason: 'unavailable', comment: 'x'.repeat(2001) })).status).toBe(400);
      expect((await reportBuilding(client.token, draft.id)).status).toBe(404);
      expect((await reportType(client.token, draft.typeIds[0]!)).status).toBe(404);
      expect((await reportBuilding(landlord.token, b.id)).status).toBe(403);
      expect(await db('reports').where({ building_id: b.id }).first()).toBeUndefined();
    });

    it('queues the report, tells the maintainers the reason but not the comment (N-09), and counts a repeat once', async () => {
      const b = await publishedBuilding();
      const comment = 'It was rented to my cousin last week';
      const first = await reportBuilding(client.token, b.id, { reason: 'unavailable', comment });
      expect(first.status).toBe(201);
      expect(first.body.data).toMatchObject({ status: 'open', reason: 'unavailable', duplicate: false });

      for (const maintainer of [landlord, agent]) {
        const rows = await notifs(maintainer.id, 'N-09', { buildingId: b.id });
        expect(rows).toHaveLength(1);
        expect(rows[0].payload).toMatchObject({ reportId: first.body.data.id, reason: 'unavailable', targetType: 'building' });
        expect(JSON.stringify(rows[0].payload)).not.toContain(comment);
      }
      expect(await countNotifs(outsider.id, 'N-09')).toBe(0);

      const again = await reportBuilding(client.token, b.id, { reason: 'suspicious', comment: 'second thoughts' });
      expect(again.status).toBe(200);
      expect(again.body.data).toMatchObject({ id: first.body.data.id, reason: 'unavailable', duplicate: true });
      expect(await db('reports').where({ building_id: b.id, client_id: client.id })).toHaveLength(1);
      expect(await notifs(landlord.id, 'N-09', { buildingId: b.id })).toHaveLength(1);

      // another client's report is a separate one; a space-type report dedupes on its own target
      expect((await reportBuilding(client2.token, b.id)).status).toBe(201);
      expect(await db('reports').where({ building_id: b.id })).toHaveLength(2);
      const t1 = await reportType(client.token, b.typeIds[0]!);
      expect(t1.status).toBe(201);
      expect((await reportType(client.token, b.typeIds[0]!)).body.data).toMatchObject({ id: t1.body.data.id, duplicate: true });
      const typeNotice = await notifs(agent.id, 'N-09', { spaceTypeId: b.typeIds[0] });
      expect(typeNotice[0].payload).toMatchObject({ targetType: 'space_type', buildingId: b.id });
    });

    it('serves the Admin queue open-first, oldest first, even for a suspended building', async () => {
      const b = await publishedBuilding();
      const r1 = (await reportBuilding(client.token, b.id, { reason: 'inaccurate', comment: 'Wrong rent' })).body.data.id as string;
      const r2 = (await reportBuilding(client2.token, b.id, { reason: 'suspicious', comment: 'Looks fake' })).body.data.id as string;
      const r3 = (await reportType(client.token, b.typeIds[0]!)).body.data.id as string;
      // the building is suspended after the reports came in: they stay listed (FR-ADM-005 AC)
      await db('buildings').where({ id: b.id }).update({
        status: 'suspended',
        status_before_suspension: 'published',
        suspension_cause: 'admin',
        suspended_reason: 'test',
        suspended_at: db.fn.now(),
      });

      for (const nonAdmin of [client, landlord]) expect((await call('GET', '/admin/reports', nonAdmin.token)).status).toBe(403);
      expect((await call('GET', '/admin/reports', null)).status).toBe(401);

      const mine = new Set([r1, r2, r3]);
      const collected: Body[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res: { status: number; body: Body } = await call('GET', `/admin/reports?limit=2${cursor ? `&cursor=${cursor}` : ''}`, admin.token);
        expect(res.status).toBe(200);
        collected.push(...res.body.data.items);
        cursor = res.body.data.nextCursor;
        pages += 1;
      } while (cursor && pages < 100);
      const ours = collected.filter((i) => mine.has(i.id));
      expect(ours.map((i) => i.id)).toEqual([r1, r2, r3]); // oldest first
      expect(collected.every((i) => i.status === 'open')).toBe(true);
      expect(ours[0]).toMatchObject({ reason: 'inaccurate', comment: 'Wrong rent', target: { type: 'building', building: { id: b.id, status: 'suspended' } } });
      expect(ours[2].target).toMatchObject({ type: 'space_type', spaceType: { id: b.typeIds[0] } });
      expect(ours[1].reporter.id).toBe(client2.id);
      expect(await db('audit_log').where({ actor_user_id: admin.id, action: 'pii.view', object_type: 'report' }).first()).toBeTruthy();
      expect((await call('GET', '/admin/reports?status=bogus', admin.token)).status).toBe(400);
    });

    it('resolves a report once, records who and how, and lets the client report again afterwards', async () => {
      const b = await publishedBuilding();
      const id = (await reportBuilding(client.token, b.id)).body.data.id as string;
      for (const nonAdmin of [client, landlord]) {
        expect((await call('POST', `/admin/reports/${id}/resolve`, nonAdmin.token, { resolution: 'actioned' })).status).toBe(403);
      }
      expect((await call('POST', `/admin/reports/${id}/resolve`, admin.token, { resolution: 'maybe' })).status).toBe(400);
      expect((await call('POST', `/admin/reports/${id}/resolve`, admin.token, {})).status).toBe(400);

      const res = await call('POST', `/admin/reports/${id}/resolve`, admin.token, { resolution: 'actioned', note: 'Count corrected' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id, status: 'actioned', resolutionNote: 'Count corrected' });
      expect(await db('reports').where({ id }).first()).toMatchObject({ status: 'actioned', resolved_by: admin.id, resolution_note: 'Count corrected' });
      expect(await db('audit_log').where({ object_id: id, action: 'report.resolve', actor_user_id: admin.id }).first()).toBeTruthy();

      const twice = await call('POST', `/admin/reports/${id}/resolve`, admin.token, { resolution: 'dismissed' });
      expect(twice.status).toBe(409);
      expect(twice.body.code).toBe('REPORT_ALREADY_RESOLVED');
      expect((await call('POST', '/admin/reports/019363c8-1234-7000-8000-00000000ffff/resolve', admin.token, { resolution: 'dismissed' })).status).toBe(404);

      const open = await call('GET', '/admin/reports?limit=100', admin.token);
      expect(open.body.data.items.map((i: Body) => i.id)).not.toContain(id);
      const done = await call('GET', '/admin/reports?status=actioned&limit=100', admin.token);
      expect(done.body.data.items.find((i: Body) => i.id === id)).toMatchObject({ resolvedBy: admin.id });

      const fresh = await reportBuilding(client.token, b.id);
      expect(fresh.status).toBe(201);
      expect(fresh.body.data.id).not.toBe(id);
    });
  });
});
