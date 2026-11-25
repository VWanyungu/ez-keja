import { afterEach, describe, expect, it } from 'bun:test';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import type { Server } from 'node:http';
import { HttpError } from '../../lib/http-error.js';
import type { AuthContext } from '../../middlewares/auth.js';
import { createSpaceTypesRouter, type SpaceTypesRouterDeps } from './routes.js';
import {
  parseCreateSpaceTypeBody,
  parsePatchSpaceTypeBody,
  parseRestoreSpaceTypeBody,
  resolveRent,
} from './schemas.js';

const BUILDING_ID = '019363c8-1234-7000-8000-0000000000b1';
const SPACE_TYPE_ID = '019363c8-1234-7000-8000-0000000000c1';
const CATEGORY_ID = '019363c8-1234-7000-8000-0000000000d1';
const CURRENCY_ID = '019363c8-1234-7000-8000-0000000000e1';

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const status = typeof err?.status === 'number' ? err.status : 500;
  res.status(status).json({
    status: 'error',
    data: null,
    message: err?.expose ? err.message : 'Internal server error',
    ...(err?.expose && err?.code ? { code: err.code } : {}),
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

async function startApp(deps: SpaceTypesRouterDeps): Promise<string> {
  const requireAuth: RequestHandler = (req, _res, next) => {
    req.auth = { user: { id: 'u' } } as AuthContext;
    next();
  };
  const app = express();
  app.use(express.json());
  app.use(createSpaceTypesRouter({ requireAuth, ...deps }));
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

const fixed = {
  name: 'Bedsitter · Type A',
  categoryId: CATEGORY_ID,
  rentMode: 'fixed',
  rentAmount: 12000,
  currencyId: CURRENCY_ID,
  depositAmount: 12000,
  vacantCount: 3,
};

const rejects = (fn: () => unknown) => expect(fn).toThrow(HttpError);

describe('rent mode (BR-013, FR-UNT-004)', () => {
  it('resolves fixed and on-interest rent', () => {
    const fixedRent = { rentMode: 'fixed', rentAmount: 500 } as const;
    expect(resolveRent(fixedRent, {})).toEqual(fixedRent);
    expect(resolveRent(fixedRent, { rentAmount: 700 })).toEqual({ rentMode: 'fixed', rentAmount: 700 });
    expect(resolveRent(fixedRent, { rentMode: 'on_interest' })).toEqual({ rentMode: 'on_interest', rentAmount: null });
    expect(resolveRent({ rentMode: 'on_interest', rentAmount: null }, { rentMode: 'fixed', rentAmount: 9 })).toEqual({
      rentMode: 'fixed',
      rentAmount: 9,
    });
  });

  it('refuses a fixed rent without an amount and on-interest with one', () => {
    rejects(() => resolveRent({ rentMode: 'on_interest', rentAmount: null }, { rentMode: 'fixed' }));
    rejects(() => resolveRent({ rentMode: 'fixed', rentAmount: 5 }, { rentAmount: null }));
    rejects(() => resolveRent({ rentMode: 'fixed', rentAmount: 5 }, { rentMode: 'on_interest', rentAmount: 5 }));
  });
});

describe('space type bodies', () => {
  it('parses a fixed-rent space type and an on-interest one, deposit required in both', () => {
    expect(parseCreateSpaceTypeBody({ ...fixed, sizeSqm: 18.5 })).toMatchObject({
      name: 'Bedsitter · Type A',
      rentMode: 'fixed',
      rentAmount: 12000,
      depositAmount: 12000,
      sizeSqm: 18.5,
      vacantCount: 3,
    });
    expect(
      parseCreateSpaceTypeBody({ ...fixed, rentMode: 'on_interest', rentAmount: undefined, depositAmount: 0, vacantCount: 0 }),
    ).toMatchObject({ rentMode: 'on_interest', rentAmount: null, depositAmount: 0, sizeSqm: null, vacantCount: 0 });

    const { depositAmount: _d, ...noDeposit } = fixed;
    rejects(() => parseCreateSpaceTypeBody(noDeposit));
    rejects(() => parseCreateSpaceTypeBody({ ...noDeposit, rentMode: 'on_interest', rentAmount: undefined }));
  });

  it('refuses bad rent, deposit, size, count, name and category', () => {
    rejects(() => parseCreateSpaceTypeBody({ ...fixed, rentAmount: undefined }));
    rejects(() => parseCreateSpaceTypeBody({ ...fixed, rentAmount: 0 }));
    rejects(() => parseCreateSpaceTypeBody({ ...fixed, rentAmount: -5 }));
    rejects(() => parseCreateSpaceTypeBody({ ...fixed, rentAmount: '5000' }));
    rejects(() => parseCreateSpaceTypeBody({ ...fixed, rentAmount: 10.123 }));
    rejects(() => parseCreateSpaceTypeBody({ ...fixed, rentMode: 'on_interest' }));
    rejects(() => parseCreateSpaceTypeBody({ ...fixed, depositAmount: -1 }));
    rejects(() => parseCreateSpaceTypeBody({ ...fixed, sizeSqm: 0 }));
    rejects(() => parseCreateSpaceTypeBody({ ...fixed, vacantCount: -1 }));
    rejects(() => parseCreateSpaceTypeBody({ ...fixed, vacantCount: 1.5 }));
    rejects(() => parseCreateSpaceTypeBody({ ...fixed, vacantCount: undefined }));
    rejects(() => parseCreateSpaceTypeBody({ ...fixed, name: '' }));
    rejects(() => parseCreateSpaceTypeBody({ ...fixed, name: 'x'.repeat(101) }));
    rejects(() => parseCreateSpaceTypeBody({ ...fixed, categoryId: 'office' }));
    rejects(() => parseCreateSpaceTypeBody({ ...fixed, removedAt: null }));
  });

  it('needs a version and a change to patch, and leaves the count to availability', () => {
    expect(parsePatchSpaceTypeBody({ version: 1, rentAmount: 13000, sizeSqm: null })).toEqual({
      version: 1,
      rentAmount: 13000,
      sizeSqm: null,
    });
    rejects(() => parsePatchSpaceTypeBody({ rentAmount: 1 }));
    rejects(() => parsePatchSpaceTypeBody({ version: 1 }));
    expect(() => parsePatchSpaceTypeBody({ version: 1, vacantCount: 2 })).toThrow('vacant count');
  });

  it('needs an explicit count to restore, and takes an optional new name', () => {
    expect(parseRestoreSpaceTypeBody({ vacantCount: 2 })).toEqual({ vacantCount: 2, name: null });
    expect(parseRestoreSpaceTypeBody({ vacantCount: 0, name: ' Type B ' })).toEqual({ vacantCount: 0, name: 'Type B' });
    rejects(() => parseRestoreSpaceTypeBody({}));
    rejects(() => parseRestoreSpaceTypeBody({ vacantCount: -1 }));
  });
});

describe('space types router', () => {
  it('creates, edits, removes and restores through the service', async () => {
    const calls: unknown[] = [];
    const baseUrl = await startApp({
      createSpaceType: async (_a, buildingId, input) => (calls.push(['create', buildingId, input.name]), { id: SPACE_TYPE_ID } as never),
      updateSpaceType: async (_a, id, patch) => (calls.push(['update', id, patch.version]), {} as never),
      removeSpaceType: async (_a, id) => (calls.push(['remove', id]), {} as never),
      restoreSpaceType: async (_a, id, input) => (calls.push(['restore', id, input.vacantCount]), {} as never),
    });

    const create = await fetch(`${baseUrl}/buildings/${BUILDING_ID}/space-types`, { method: 'POST', ...json(fixed) });
    expect(create.status).toBe(201);
    expect((await fetch(`${baseUrl}/space-types/${SPACE_TYPE_ID}`, { method: 'PATCH', ...json({ version: 2, name: 'B' }) })).status).toBe(200);
    expect((await fetch(`${baseUrl}/space-types/${SPACE_TYPE_ID}`, { method: 'DELETE' })).status).toBe(200);
    expect((await fetch(`${baseUrl}/space-types/${SPACE_TYPE_ID}/restore`, { method: 'POST', ...json({ vacantCount: 4 }) })).status).toBe(200);
    expect(calls).toEqual([
      ['create', BUILDING_ID, 'Bedsitter · Type A'],
      ['update', SPACE_TYPE_ID, 2],
      ['remove', SPACE_TYPE_ID],
      ['restore', SPACE_TYPE_ID, 4],
    ]);
  });

  it('answers 400 for a bad body and 400 for a bad id without calling the service', async () => {
    let called = false;
    const baseUrl = await startApp({
      createSpaceType: async () => ((called = true), {} as never),
      removeSpaceType: async () => ((called = true), {} as never),
    });
    const bad = await fetch(`${baseUrl}/buildings/${BUILDING_ID}/space-types`, { method: 'POST', ...json({ ...fixed, vacantCount: -1 }) });
    expect(bad.status).toBe(400);
    expect((await fetch(`${baseUrl}/space-types/nope`, { method: 'DELETE' })).status).toBe(400);
    expect(called).toBe(false);
  });

  it('lists with an includeRemoved flag', async () => {
    const flags: boolean[] = [];
    const baseUrl = await startApp({ listSpaceTypes: async (_a, _id, includeRemoved) => (flags.push(includeRemoved), []) });
    await fetch(`${baseUrl}/buildings/${BUILDING_ID}/space-types`);
    await fetch(`${baseUrl}/buildings/${BUILDING_ID}/space-types?includeRemoved=true`);
    expect((await fetch(`${baseUrl}/buildings/${BUILDING_ID}/space-types?includeRemoved=maybe`)).status).toBe(400);
    expect(flags).toEqual([false, true]);
  });
});
