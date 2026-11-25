import { afterEach, describe, expect, it } from 'bun:test';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import type { Server } from 'node:http';
import { HttpError, forbidden } from '../../lib/http-error.js';
import type { AuthContext } from '../../middlewares/auth.js';
import { createBuildingsRouter, type BuildingsRouterDeps } from './routes.js';
import { mapGateViolation } from './service.js';
import {
  assertManagement,
  canTransition,
  parseCreateBuildingBody,
  parsePatchBuildingBody,
  parseUserBody,
} from './schemas.js';

const BUILDING_ID = '019363c8-1234-7000-8000-0000000000b1';
const AREA_ID = '019363c8-1234-7000-8000-0000000000a1';
const USER_ID = '019363c8-1234-7000-8000-000000000009';

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const status = typeof err?.status === 'number' ? err.status : 500;
  const expose = Boolean(err?.expose);
  res.status(status).json({
    status: 'error',
    data: expose && err?.data !== undefined ? err.data : null,
    message: expose ? err.message : 'Internal server error',
    ...(expose && err?.code ? { code: err.code } : {}),
  });
};

let activeServer: Server | null = null;

afterEach(async () => {
  if (activeServer) {
    await new Promise<void>((resolve, reject) => {
      activeServer!.close((err) => (err ? reject(err) : resolve()));
    });
    activeServer = null;
  }
});

function fakeAuth(): AuthContext {
  const now = new Date('2026-11-25T12:00:00Z');
  return {
    user: { id: USER_ID, email: 'a@example.com', name: 'A', emailVerified: false, image: null },
    session: { id: 's', token: 't', expiresAt: new Date(Date.now() + 60_000) },
    profile: {
      userId: USER_ID, displayName: 'A', phone: null, language: 'en', agentType: null, photoFileId: null,
      accountStatus: 'active', suspendedReason: null, suspendedAt: null, verificationStatus: 'unverified',
      tokenVersion: 1, lastLoginAt: now, erasedAt: null, createdAt: now, updatedAt: now,
    },
    roles: ['landlord'],
    consent: { currentNotice: null, acceptedAt: now, requiresReconsent: false },
  };
}

async function startApp(deps: BuildingsRouterDeps): Promise<string> {
  const requireAuth: RequestHandler = (req, _res, next) => {
    req.auth = fakeAuth();
    next();
  };
  const app = express();
  app.use(express.json());
  app.use(createBuildingsRouter({ requireAuth, requireLister: (_req, _res, next) => next(), ...deps }));
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    activeServer = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = activeServer!.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return `http://127.0.0.1:${addr.port}`;
}

const json = (body: unknown) => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const validCreate = {
  name: ' Acacia Court ',
  areaId: AREA_ID,
  latitude: -1.286389,
  longitude: 36.817223,
  managementType: 'landlord',
  landlordName: 'Mr Kamau',
};

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as HttpError).code ?? 'NO_CODE';
  }
  return undefined;
}

describe('building status transitions (SRS §5.3)', () => {
  it('allows only the maintainer moves', () => {
    expect(canTransition('draft', 'published')).toBe(true);
    expect(canTransition('draft', 'pending')).toBe(true);
    expect(canTransition('pending', 'published')).toBe(true);
    expect(canTransition('draft', 'withdrawn')).toBe(true);
    expect(canTransition('pending', 'withdrawn')).toBe(true);
    expect(canTransition('published', 'withdrawn')).toBe(true);
    expect(canTransition('withdrawn', 'draft')).toBe(true);

    expect(canTransition('withdrawn', 'published')).toBe(false);
    expect(canTransition('published', 'draft')).toBe(false);
    expect(canTransition('published', 'published')).toBe(false);
    expect(canTransition('suspended', 'withdrawn')).toBe(false);
    expect(canTransition('suspended', 'published')).toBe(false);
    expect(canTransition('pending', 'draft')).toBe(false);
  });
});

describe('publish gate violation (T5)', () => {
  it('turns the trigger error into a 409 that lists the blockers', () => {
    const trigger = Object.assign(
      new Error('update "buildings" set "status" = $1 - Building cannot be published: needs a cover photo; needs a designated contact'),
      { code: '23514' },
    );
    const mapped = mapGateViolation(trigger) as HttpError;
    expect(mapped).toBeInstanceOf(HttpError);
    expect(mapped.status).toBe(409);
    expect(mapped.code).toBe('PUBLISH_BLOCKED');
    expect(mapped.data).toEqual({ blockers: ['needs a cover photo', 'needs a designated contact'] });
  });

  it('leaves every other error alone', () => {
    const other = Object.assign(new Error('violates check constraint "ck_buildings_name_len"'), { code: '23514' });
    expect(mapGateViolation(other)).toBe(other);
    const plain = new Error('boom');
    expect(mapGateViolation(plain)).toBe(plain);
  });
});

describe('management designation (BR-012)', () => {
  const base = { managingAgentId: null, landlordUserId: null, landlordName: null } as const;

  it('needs an agent for agent management and a landlord for landlord management', () => {
    expect(codeOf(() => assertManagement({ ...base, managementType: 'agent' }))).toBe('MANAGEMENT_INVALID');
    expect(() => assertManagement({ ...base, managementType: 'agent', managingAgentId: USER_ID })).not.toThrow();

    expect(codeOf(() => assertManagement({ ...base, managementType: 'landlord' }))).toBe('MANAGEMENT_INVALID');
    expect(() => assertManagement({ ...base, managementType: 'landlord', landlordName: 'X' })).not.toThrow();
    expect(() => assertManagement({ ...base, managementType: 'landlord', landlordUserId: USER_ID })).not.toThrow();
    expect(
      codeOf(() => assertManagement({ ...base, managementType: 'landlord', landlordName: 'X', managingAgentId: USER_ID })),
    ).toBe('MANAGEMENT_INVALID');
  });
});

describe('building bodies', () => {
  it('parses a valid create body and trims text', () => {
    expect(parseCreateBuildingBody(validCreate)).toMatchObject({
      name: 'Acacia Court',
      areaId: AREA_ID,
      latitude: -1.286389,
      description: null,
      managementType: 'landlord',
      landlordName: 'Mr Kamau',
      listerId: null,
    });
  });

  it('refuses a missing map pin, a bad pin and an unknown management type', () => {
    const { latitude: _l, ...noLat } = validCreate;
    expect(codeOf(() => parseCreateBuildingBody(noLat))).toBe('MAP_PIN_REQUIRED');
    expect(() => parseCreateBuildingBody({ ...validCreate, latitude: 91 })).toThrow(HttpError);
    expect(() => parseCreateBuildingBody({ ...validCreate, longitude: '36.8' })).toThrow(HttpError);
    expect(() => parseCreateBuildingBody({ ...validCreate, managementType: 'owner' })).toThrow(HttpError);
    expect(() => parseCreateBuildingBody({ ...validCreate, areaId: 'nairobi' })).toThrow(HttpError);
    expect(() => parseCreateBuildingBody({ ...validCreate, name: '   ' })).toThrow(HttpError);
    expect(() => parseCreateBuildingBody({ ...validCreate, name: 'x'.repeat(151) })).toThrow(HttpError);
    expect(() => parseCreateBuildingBody({ ...validCreate, status: 'published' })).toThrow(HttpError);
    expect(() => parseCreateBuildingBody([])).toThrow(HttpError);
  });

  it('needs the version and at least one field to patch', () => {
    expect(parsePatchBuildingBody({ version: 2, name: 'New', description: null })).toEqual({
      version: 2,
      name: 'New',
      description: null,
    });
    expect(() => parsePatchBuildingBody({ name: 'New' })).toThrow(HttpError);
    expect(() => parsePatchBuildingBody({ version: 0, name: 'New' })).toThrow(HttpError);
    expect(() => parsePatchBuildingBody({ version: 1 })).toThrow(HttpError);
    expect(() => parsePatchBuildingBody({ version: 1, listerId: USER_ID })).toThrow(HttpError);
    expect(() => parsePatchBuildingBody({ version: 1, status: 'published' })).toThrow(HttpError);
  });

  it('reads the user of the maintainer and contact bodies', () => {
    expect(parseUserBody({ userId: USER_ID })).toEqual({ userId: USER_ID });
    expect(() => parseUserBody({})).toThrow(HttpError);
    expect(() => parseUserBody({ userId: 'x' })).toThrow(HttpError);
  });
});

describe('buildings router', () => {
  it('creates a building from the parsed body and answers 201', async () => {
    let received: unknown;
    const baseUrl = await startApp({
      createBuilding: async (_auth, input) => {
        received = input;
        return { id: BUILDING_ID } as never;
      },
    });
    const res = await fetch(`${baseUrl}/buildings`, { method: 'POST', ...json(validCreate) });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ status: 'success', data: { id: BUILDING_ID } });
    expect(received).toMatchObject({ name: 'Acacia Court', managementType: 'landlord' });
  });

  it('answers 400 for an invalid body without calling the service', async () => {
    let called = false;
    const baseUrl = await startApp({
      createBuilding: async () => {
        called = true;
        return {} as never;
      },
    });
    const res = await fetch(`${baseUrl}/buildings`, { method: 'POST', ...json({ ...validCreate, latitude: undefined }) });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('MAP_PIN_REQUIRED');
    expect(called).toBe(false);
  });

  it('keeps creating and listing for listers only', async () => {
    const baseUrl = await startApp({
      requireLister: (_req, _res, next) => next(forbidden('Insufficient permissions', { code: 'FORBIDDEN_ROLE' })),
    });
    expect((await fetch(`${baseUrl}/buildings`, { method: 'POST', ...json(validCreate) })).status).toBe(403);
    expect((await fetch(`${baseUrl}/buildings/mine`)).status).toBe(403);
  });

  it('serves /buildings/mine before /buildings/:id', async () => {
    let mine = 0;
    let byId = 0;
    const baseUrl = await startApp({
      listMyBuildings: async () => {
        mine += 1;
        return [];
      },
      getBuilding: async () => {
        byId += 1;
        return {} as never;
      },
    });
    expect((await fetch(`${baseUrl}/buildings/mine`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/buildings/${BUILDING_ID}`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/buildings/not-a-uuid`)).status).toBe(400);
    expect({ mine, byId }).toEqual({ mine: 1, byId: 1 });
  });

  it('passes the version of a patch to the service and surfaces a stale-save 409 with the current version', async () => {
    let patch: unknown;
    const baseUrl = await startApp({
      updateBuilding: async (_auth, _id, p) => {
        patch = p;
        throw new HttpError(409, 'stale', { code: 'STALE_VERSION', data: { currentVersion: 4 } });
      },
    });
    const res = await fetch(`${baseUrl}/buildings/${BUILDING_ID}`, { method: 'PATCH', ...json({ version: 3, name: 'N' }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'STALE_VERSION', data: { currentVersion: 4 } });
    expect(patch).toEqual({ version: 3, name: 'N' });
  });

  it('runs withdraw, reopen, publish and the blocker list', async () => {
    const calls: string[] = [];
    const baseUrl = await startApp({
      withdrawBuilding: async () => (calls.push('withdraw'), {} as never),
      reopenBuilding: async () => (calls.push('reopen'), {} as never),
      getPublishBlockers: async () => (calls.push('blockers'), { blockers: [], canPublish: true, wouldBePending: false }),
      publishBuilding: async () => (calls.push('publish'), { outcome: 'pending', blockers: [], building: {} } as never),
    });
    expect((await fetch(`${baseUrl}/buildings/${BUILDING_ID}/withdraw`, { method: 'POST' })).status).toBe(200);
    expect((await fetch(`${baseUrl}/buildings/${BUILDING_ID}/reopen`, { method: 'POST' })).status).toBe(200);
    expect((await fetch(`${baseUrl}/buildings/${BUILDING_ID}/publish-blockers`)).status).toBe(200);
    const publish = await fetch(`${baseUrl}/buildings/${BUILDING_ID}/publish`, { method: 'POST' });
    expect((await publish.json()).message).toContain('pending');
    expect(calls).toEqual(['withdraw', 'reopen', 'blockers', 'publish']);
  });

  it('adds and removes maintainers and sets the contact', async () => {
    const calls: unknown[] = [];
    const baseUrl = await startApp({
      addMaintainer: async (_a, id, userId) => (calls.push(['add', id, userId]), []),
      removeMaintainer: async (_a, id, userId) => (calls.push(['remove', id, userId]), []),
      setContact: async (_a, id, userId) => (calls.push(['contact', id, userId]), {} as never),
    });
    const add = await fetch(`${baseUrl}/buildings/${BUILDING_ID}/maintainers`, { method: 'POST', ...json({ userId: USER_ID }) });
    expect(add.status).toBe(201);
    expect((await fetch(`${baseUrl}/buildings/${BUILDING_ID}/maintainers/${USER_ID}`, { method: 'DELETE' })).status).toBe(200);
    expect((await fetch(`${baseUrl}/buildings/${BUILDING_ID}/contact`, { method: 'PUT', ...json({ userId: USER_ID }) })).status).toBe(200);
    expect((await fetch(`${baseUrl}/buildings/${BUILDING_ID}/contact`, { method: 'PUT', ...json({}) })).status).toBe(400);
    expect(calls).toEqual([
      ['add', BUILDING_ID, USER_ID],
      ['remove', BUILDING_ID, USER_ID],
      ['contact', BUILDING_ID, USER_ID],
    ]);
  });
});
