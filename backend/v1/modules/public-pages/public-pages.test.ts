import { describe, expect, it } from 'bun:test';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import type { Server } from 'node:http';
import {
  assertPubliclyAvailable,
  gatePhone,
  toManagement,
  type AvailabilityRow,
  type BuildingProfileRow,
} from '../../lib/public-catalogue.js';
import { createListersRouter } from '../listers/routes.js';
import { createPublicPagesRouter, type PublicPagesRouterDeps } from './routes.js';
import { parseContactEventBody } from './schemas.js';

const B = '019363c8-1234-7000-8000-0000000000b1';
const S = '019363c8-1234-7000-8000-0000000000c1';
const U = '019363c8-1234-7000-8000-0000000000d1';

const availability = (extra: Partial<AvailabilityRow> = {}): AvailabilityRow => ({
  status: 'published',
  status_before_suspension: null,
  published_at: new Date(),
  has_active_maintainer: true,
  ...extra,
});

const outcome = (row: AvailabilityRow | undefined) => {
  try {
    assertPubliclyAvailable(row);
    return 'ok';
  } catch (err) {
    const e = err as { status: number; code?: string };
    return `${e.status} ${e.code}`;
  }
};

describe('assertPubliclyAvailable (404 vs 410)', () => {
  it('lets a Published building with an active maintainer through', () => {
    expect(outcome(availability())).toBe('ok');
  });

  it('answers 410 BUILDING_UNAVAILABLE for a building that was public and no longer is', () => {
    expect(outcome(availability({ status: 'withdrawn' }))).toBe('410 BUILDING_UNAVAILABLE');
    expect(outcome(availability({ status: 'suspended', status_before_suspension: 'published' }))).toBe('410 BUILDING_UNAVAILABLE');
    expect(outcome(availability({ has_active_maintainer: false }))).toBe('410 BUILDING_UNAVAILABLE');
  });

  it('answers the same 404 as an unknown building for drafts, pending and never-public ones', () => {
    for (const row of [
      undefined,
      availability({ status: 'draft', published_at: null }),
      availability({ status: 'pending', published_at: null }),
      availability({ status: 'withdrawn', published_at: null }),
      availability({ status: 'suspended', status_before_suspension: 'draft', published_at: null }),
      availability({ status: 'suspended', status_before_suspension: 'pending', published_at: null }),
    ]) {
      expect(outcome(row)).toBe('404 BUILDING_NOT_FOUND');
    }
  });
});

describe('gatePhone (BR-009)', () => {
  it('hides the phone from a Guest and asks for a login', () => {
    expect(gatePhone(undefined, '+254700000001')).toEqual({ phone: null, phoneRequiresLogin: true });
  });

  it('shows it to a logged-in user', () => {
    expect(gatePhone({ user: { id: U } } as never, '+254700000001')).toEqual({ phone: '+254700000001', phoneRequiresLogin: false });
  });

  it('does not ask a Guest to log in for a number that does not exist', () => {
    expect(gatePhone(undefined, null)).toEqual({ phone: null, phoneRequiresLogin: false });
  });
});

describe('toManagement', () => {
  const row = (extra: Partial<BuildingProfileRow>): BuildingProfileRow => ({
    management_type: 'landlord',
    landlord_name: 'Mrs Wanjiru',
    agent_user_id: null,
    agent_name: null,
    landlord_user_id: null,
    landlord_profile_name: null,
    account_verification: 'verified',
    building_verification: 'unverified',
    ...extra,
  });

  it('names the agent, or the landlord account, or the named landlord', () => {
    expect(toManagement(row({ management_type: 'agent', agent_user_id: U, agent_name: 'Ann' }))).toEqual({ type: 'agent', name: 'Ann', profileUserId: U });
    expect(toManagement(row({ landlord_user_id: U, landlord_profile_name: 'Lee' }))).toEqual({ type: 'landlord', name: 'Lee', profileUserId: U });
    expect(toManagement(row({}))).toEqual({ type: 'landlord', name: 'Mrs Wanjiru', profileUserId: null });
  });

  it('shows no name or link for an agent whose account is not active', () => {
    expect(toManagement(row({ management_type: 'agent' }))).toEqual({ type: 'agent', name: null, profileUserId: null });
  });
});

describe('parseContactEventBody', () => {
  it('accepts no body, an empty body, or a space type', () => {
    expect(parseContactEventBody(undefined)).toEqual({ spaceTypeId: null });
    expect(parseContactEventBody({})).toEqual({ spaceTypeId: null });
    expect(parseContactEventBody({ spaceTypeId: S })).toEqual({ spaceTypeId: S });
  });

  it('refuses a malformed id and any other field (nothing personal is accepted)', () => {
    expect(() => parseContactEventBody({ spaceTypeId: 'nope' })).toThrow();
    expect(() => parseContactEventBody({ phone: '+254700000001' })).toThrow();
    expect(() => parseContactEventBody([])).toThrow();
  });
});

describe('public routers', () => {
  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    res.status(typeof err?.status === 'number' ? err.status : 500).json({ code: err?.code });
  };
  const asGuest: RequestHandler = (_req, _res, next) => next();
  const asMember: RequestHandler = (req, _res, next) => {
    req.auth = { user: { id: U } } as never;
    next();
  };

  async function start(build: (app: express.Express) => void) {
    const app = express();
    app.use(express.json());
    build(app);
    app.use(errorHandler);
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
  }

  it('hands the viewer (or none) to the page services and rejects malformed ids', async () => {
    const seen: Array<{ viewer: unknown; id: string }> = [];
    const deps = (optionalAuth: RequestHandler): PublicPagesRouterDeps => ({
      optionalAuth,
      getPublicBuilding: (async (viewer: unknown, id: string) => {
        seen.push({ viewer, id });
        return { id };
      }) as never,
    });
    const guest = await start((app) => app.use(createPublicPagesRouter(deps(asGuest))));
    expect((await fetch(`${guest.url}/buildings/${B}/public`)).status).toBe(200);
    expect((await fetch(`${guest.url}/buildings/nope/public`)).status).toBe(400);
    guest.server.close();
    const member = await start((app) => app.use(createPublicPagesRouter(deps(asMember))));
    await fetch(`${member.url}/buildings/${B}/public`);
    member.server.close();
    expect(seen[0]).toEqual({ viewer: undefined, id: B });
    expect(seen[1]!.viewer).toMatchObject({ user: { id: U } });
  });

  it('answers 201 to a contact event and passes only the validated input on', async () => {
    const calls: unknown[] = [];
    const { server, url } = await start((app) =>
      app.use(
        createPublicPagesRouter({
          optionalAuth: asGuest,
          recordContactEvent: (async (viewer: unknown, id: string, input: unknown) => {
            calls.push({ viewer, id, input });
          }) as never,
        }),
      ),
    );
    const res = await fetch(`${url}/buildings/${B}/contact-events`, { method: 'POST' });
    expect(res.status).toBe(201);
    const withType = await fetch(`${url}/buildings/${B}/contact-events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spaceTypeId: S }),
    });
    expect(withType.status).toBe(201);
    const extra = await fetch(`${url}/buildings/${B}/contact-events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: U }),
    });
    expect(extra.status).toBe(400);
    server.close();
    expect(calls).toEqual([
      { viewer: undefined, id: B, input: { spaceTypeId: null } },
      { viewer: undefined, id: B, input: { spaceTypeId: S } },
    ]);
  });

  it('serves the lister profile through the lister service', async () => {
    const { server, url } = await start((app) =>
      app.use(createListersRouter({ optionalAuth: asMember, getLister: (async (_v: unknown, id: string) => ({ userId: id })) as never })),
    );
    const res = await fetch(`${url}/listers/${U}`);
    expect(await res.json()).toEqual({ status: 'success', data: { userId: U }, message: 'Lister' });
    expect((await fetch(`${url}/listers/x`)).status).toBe(400);
    server.close();
  });
});
