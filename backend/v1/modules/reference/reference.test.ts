import { afterEach, describe, expect, it } from 'bun:test';
import express, { type ErrorRequestHandler } from 'express';
import type { Server } from 'node:http';
import { HttpError, conflict, forbidden, notFound, unauthorized } from '../../lib/http-error.js';
import type { AuthContext } from '../../middlewares/auth.js';
import { createAdminRouter } from '../admin/routes.js';
import {
  createAreasPublicRouter,
  createCategoriesPublicRouter,
  createCurrenciesPublicRouter,
  createServiceCategoriesPublicRouter,
} from './routes.js';
import {
  parseAdminActiveFilterQuery,
  parseCreateAreaBody,
  parseCreateCurrencyBody,
  parseCreateSettingBody,
  parsePublicCategoriesQuery,
  parseReferenceIdParam,
  parseSettingLookupParam,
  parseUpdateAreaBody,
  parseUpdateCurrencyBody,
  parseUpdateSettingBody,
  slugifyAreaName,
  validateSettingValueInRange,
} from './schemas.js';
import {
  REQUIRED_SETTING_KEYS,
  createAdminArea,
  createAdminCurrency,
  createAdminSetting,
  deactivateAdminArea,
  deactivateAdminCurrency,
  deleteAdminSetting,
  updateAdminSetting,
  type AreaItem,
  type CurrencyItem,
  type ServiceCategoryItem,
  type SettingItem,
  type SpaceCategoryItem,
} from './service.js';

const testErrorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const status = typeof err?.status === 'number' ? err.status : 500;
  const expose = Boolean(err?.expose);
  const message = expose ? err.message : 'Internal server error';
  const data = expose && err instanceof HttpError && err.data !== undefined ? err.data : null;
  const code = expose && typeof err?.code === 'string' ? err.code : undefined;
  res.status(status).json({
    status: 'error',
    data,
    message,
    ...(code !== undefined ? { code } : {}),
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

async function startTestApp(app: express.Express): Promise<string> {
  await new Promise<void>((resolve) => {
    activeServer = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = activeServer!.address() as { port: number };
  return `http://127.0.0.1:${addr.port}`;
}

function makeAdminAuth(): AuthContext {
  const now = new Date('2026-11-25T12:00:00Z');
  return {
    user: {
      id: '019363c8-1234-7000-8000-000000000001',
      email: 'admin@khunt.local',
      name: 'Admin',
      emailVerified: true,
      image: null,
    },
    session: {
      id: '019363c8-1234-7000-8000-000000000002',
      token: 'tok',
      expiresAt: new Date(Date.now() + 60_000),
    },
    profile: {
      userId: '019363c8-1234-7000-8000-000000000001',
      displayName: 'Admin',
      phone: null,
      language: 'en',
      agentType: null,
      photoFileId: null,
      accountStatus: 'active',
      suspendedReason: null,
      suspendedAt: null,
      verificationStatus: 'unverified',
      tokenVersion: 1,
      lastLoginAt: now,
      erasedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    roles: ['admin'],
    consent: {
      currentNotice: {
        id: '019363c8-1234-7000-8000-000000000099',
        version: '2026-12-01',
        effectiveAt: now,
      },
      acceptedAt: now,
      requiresReconsent: false,
    },
  };
}

// ---- Minimal in-memory Knex mock for service unit tests -----------------------------------------

interface MockQueryState {
  op: 'select' | 'insert' | 'update' | 'delete';
  wheres: Array<{ type: 'eq' | 'neq' | 'raw'; arg: unknown }>;
  data?: unknown;
  returning?: boolean;
}

function createMockKnex(handlers: {
  onQuery: (table: string, state: MockQueryState) => unknown;
}) {

  const makeBuilder = (table: string) => {
    const state: MockQueryState = { op: 'select', wheres: [] };
    const builder: any = {
      where(arg: unknown) {
        state.wheres.push({ type: 'eq', arg });
        return builder;
      },
      whereNot(arg: unknown) {
        state.wheres.push({ type: 'neq', arg });
        return builder;
      },
      whereRaw(sql: string, bindings: unknown[]) {
        state.wheres.push({ type: 'raw', arg: { sql, bindings } });
        return builder;
      },
      forUpdate() {
        return builder;
      },
      select() {
        return Promise.resolve(handlers.onQuery(table, state));
      },
      orderBy() {
        return Promise.resolve(handlers.onQuery(table, state));
      },
      first() {
        return Promise.resolve(handlers.onQuery(table, state));
      },
      insert(data: unknown) {
        state.op = 'insert';
        state.data = data;
        return {
          returning() {
            state.returning = true;
            return Promise.resolve(handlers.onQuery(table, state));
          },
          then(resolve: (val: unknown) => void, reject?: (err: unknown) => void) {
            return Promise.resolve(handlers.onQuery(table, state)).then(resolve, reject);
          },
        };
      },
      update(data: unknown) {
        state.op = 'update';
        state.data = data;
        return {
          returning() {
            state.returning = true;
            return Promise.resolve(handlers.onQuery(table, state));
          },
          then(resolve: (val: unknown) => void, reject?: (err: unknown) => void) {
            return Promise.resolve(handlers.onQuery(table, state)).then(resolve, reject);
          },
        };
      },
      del() {
        state.op = 'delete';
        return Promise.resolve(handlers.onQuery(table, state));
      },
    };
    return builder;
  };

  const trx: any = (table: string) => makeBuilder(table);
  trx.transaction = async (cb: (t: any) => Promise<unknown>) => cb(trx);
  return trx;
}

describe('reference & settings schemas', () => {
  it('validates public categories query and admin active filter', () => {
    expect(parsePublicCategoriesQuery({})).toEqual({});
    expect(parsePublicCategoriesQuery({ kind: '' })).toEqual({});
    expect(parsePublicCategoriesQuery({ kind: 'residential' })).toEqual({ kind: 'residential' });
    expect(parsePublicCategoriesQuery({ kind: 'commercial' })).toEqual({ kind: 'commercial' });
    expect(() => parsePublicCategoriesQuery({ kind: 'industrial' })).toThrow(HttpError);

    expect(parseAdminActiveFilterQuery({})).toEqual({});
    expect(parseAdminActiveFilterQuery({ isActive: 'true' })).toEqual({ isActive: true });
    expect(parseAdminActiveFilterQuery({ isActive: 'false' })).toEqual({ isActive: false });
    expect(() => parseAdminActiveFilterQuery({ isActive: 'yes' })).toThrow(HttpError);
  });

  it('validates UUID params and setting id-or-key params', () => {
    const validId = '019363c8-1234-7000-8000-000000000010';
    expect(parseReferenceIdParam(validId, 'area')).toBe(validId);
    expect(() => parseReferenceIdParam('not-a-uuid', 'area')).toThrow(HttpError);

    expect(parseSettingLookupParam(validId)).toEqual({ kind: 'id', value: validId });
    expect(parseSettingLookupParam('freshness_days')).toEqual({
      kind: 'key',
      value: 'freshness_days',
    });
    expect(() => parseSettingLookupParam('not-a-uuid')).toThrow(HttpError);
    expect(() => parseSettingLookupParam('InvalidKey')).toThrow(HttpError);
  });

  it('parses and validates area create and update bodies', () => {
    expect(slugifyAreaName('  Ngong Hills (Kajiado)  ')).toBe('ngong-hills-kajiado');

    const createdArea = parseCreateAreaBody({
      name: '  Ngong Town ',
      centreLat: -1.3617,
      centreLng: 36.6569,
    });
    expect(createdArea).toEqual({
      name: 'Ngong Town',
      slug: 'ngong-town',
      centreLat: -1.3617,
      centreLng: 36.6569,
      isActive: true,
    });

    expect(() =>
      parseCreateAreaBody({ name: 'Bad Lat', centreLat: 91, centreLng: 36 }),
    ).toThrow(HttpError);
    expect(() =>
      parseCreateAreaBody({ name: 'Bad Lng', centreLat: -1, centreLng: -181 }),
    ).toThrow(HttpError);
    expect(() =>
      parseCreateAreaBody({
        name: 'Bad Slug',
        slug: 'Upper-Case',
        centreLat: -1,
        centreLng: 36,
      }),
    ).toThrow(HttpError);
    expect(() => parseUpdateAreaBody({})).toThrow(HttpError);
    expect(() => parseUpdateAreaBody({ unknown: 1 })).toThrow(HttpError);
  });

  it('parses and validates currency create and update bodies', () => {
    expect(parseCreateCurrencyBody({ code: ' ugx ', name: ' Ugandan shilling ' })).toEqual({
      code: 'UGX',
      name: 'Ugandan shilling',
      isActive: true,
      sortOrder: 0,
    });

    expect(() => parseCreateCurrencyBody({ code: 'KE', name: 'Bad' })).toThrow(HttpError);
    expect(() => parseCreateCurrencyBody({ code: '123', name: 'Bad' })).toThrow(HttpError);
    expect(() =>
      parseCreateCurrencyBody({ code: 'EUR', name: 'Euro', sortOrder: 40_000 }),
    ).toThrow(HttpError);
    expect(() => parseUpdateCurrencyBody({})).toThrow(HttpError);
  });

  it('parses and range-checks settings bodies', () => {
    expect(
      parseCreateSettingBody({
        key: 'max_photos_per_building',
        value: 20,
        description: 'Maximum photos allowed per building',
      }),
    ).toEqual({
      key: 'max_photos_per_building',
      value: 20,
      minValue: 1,
      maxValue: null,
      description: 'Maximum photos allowed per building',
    });

    // Rejects value below default minValue (1)
    try {
      parseCreateSettingBody({
        key: 'bad_threshold',
        value: 0,
        description: 'Zero should be refused',
      });
      throw new Error('Expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).code).toBe('SETTING_OUT_OF_RANGE');
    }

    // Rejects value above maxValue
    expect(() =>
      parseCreateSettingBody({
        key: 'flag_setting',
        value: 2,
        minValue: 0,
        maxValue: 1,
        description: 'Boolean-like integer flag',
      }),
    ).toThrow(HttpError);

    // Rejects maxValue < minValue
    expect(() =>
      parseCreateSettingBody({
        key: 'inverted_range',
        value: 5,
        minValue: 10,
        maxValue: 5,
        description: 'Inverted bounds',
      }),
    ).toThrow(HttpError);

    // Rejects modifying minValue/maxValue/key on PATCH
    expect(() => parseUpdateSettingBody({ minValue: 0 })).toThrow(HttpError);
    expect(() => parseUpdateSettingBody({ value: 1.5 })).toThrow(HttpError);
    expect(() => parseUpdateSettingBody({})).toThrow(HttpError);

    expect(() => validateSettingValueInRange('freshness_days', 0, 1, null)).toThrow(HttpError);
    expect(() => validateSettingValueInRange('freshness_days', 7, 1, null)).not.toThrow();
    expect(() => validateSettingValueInRange('require_verified_lister_to_publish', 0, 0, 1)).not.toThrow();
    expect(() => validateSettingValueInRange('require_verified_lister_to_publish', 2, 0, 1)).toThrow(
      HttpError,
    );
  });
});

describe('reference service auditing and guards', () => {
  const adminId = '019363c8-1234-7000-8000-000000000001';

  it('audits area create and deactivate in transaction', async () => {
    const audits: Array<{ action: string; object_type: string; changes: string }> = [];
    const areaId = '019363c8-1234-7000-8000-0000000000aa';
    const now = new Date('2026-11-25T12:00:00Z');

    const mockDb = createMockKnex({
      onQuery(table, state) {
        if (table === 'areas') {
          if (state.op === 'select') return undefined;
          if (state.op === 'insert') {
            const d = state.data as Record<string, unknown>;
            return [
              {
                id: d.id,
                name: d.name,
                slug: d.slug,
                centre_lat: String(d.centre_lat),
                centre_lng: String(d.centre_lng),
                is_active: d.is_active,
                created_at: now,
                updated_at: now,
              },
            ];
          }
        }
        if (table === 'audit_log' && state.op === 'insert') {
          audits.push(state.data as any);
          return [state.data];
        }
        return undefined;
      },
    });

    const createdArea = await createAdminArea(
      adminId,
      { name: 'Ngong', slug: 'ngong', centreLat: -1.3617, centreLng: 36.6569, isActive: true },
      mockDb,
    );
    expect(createdArea.name).toBe('Ngong');
    expect(createdArea.centreLat).toBe(-1.3617);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe('area.create');
    expect(audits[0]!.object_type).toBe('area');

    const deactivateDb = createMockKnex({
      onQuery(table, state) {
        if (table === 'areas') {
          if (state.op === 'select') {
            return {
              id: areaId,
              name: 'Ngong',
              slug: 'ngong',
              centre_lat: '-1.361700',
              centre_lng: '36.656900',
              is_active: true,
              created_at: now,
              updated_at: now,
            };
          }
          if (state.op === 'update') {
            return [
              {
                id: areaId,
                name: 'Ngong',
                slug: 'ngong',
                centre_lat: '-1.361700',
                centre_lng: '36.656900',
                is_active: false,
                created_at: now,
                updated_at: now,
              },
            ];
          }
        }
        if (table === 'audit_log' && state.op === 'insert') {
          audits.push(state.data as any);
          return [state.data];
        }
        return undefined;
      },
    });

    const deactivated = await deactivateAdminArea(adminId, areaId, deactivateDb);
    expect(deactivated.isActive).toBe(false);
    expect(audits).toHaveLength(2);
    expect(audits[1]!.action).toBe('area.deactivate');
    expect(JSON.parse(audits[1]!.changes)).toEqual({
      is_active: { from: true, to: false },
    });
  });

  it('audits currency create and deactivate in transaction', async () => {
    const audits: Array<{ action: string; object_type: string }> = [];
    const currencyId = '019363c8-1234-7000-8000-0000000000bb';

    const mockDb = createMockKnex({
      onQuery(table, state) {
        if (table === 'currencies') {
          if (state.op === 'select') return undefined;
          if (state.op === 'insert') {
            const d = state.data as Record<string, unknown>;
            return [
              {
                id: d.id,
                code: d.code,
                name: d.name,
                is_active: d.is_active,
                sort_order: d.sort_order,
              },
            ];
          }
        }
        if (table === 'audit_log' && state.op === 'insert') {
          audits.push(state.data as any);
          return [state.data];
        }
        return undefined;
      },
    });

    const createdCurrency = await createAdminCurrency(
      adminId,
      { code: 'UGX', name: 'Ugandan shilling', isActive: true, sortOrder: 3 },
      mockDb,
    );
    expect(createdCurrency.code).toBe('UGX');
    expect(audits[0]!.action).toBe('currency.create');

    const deactivateDb = createMockKnex({
      onQuery(table, state) {
        if (table === 'currencies') {
          if (state.op === 'select') {
            return { id: currencyId, code: 'UGX', name: 'Ugandan shilling', is_active: true, sort_order: 3 };
          }
          if (state.op === 'update') {
            return [{ id: currencyId, code: 'UGX', name: 'Ugandan shilling', is_active: false, sort_order: 3 }];
          }
        }
        if (table === 'audit_log' && state.op === 'insert') {
          audits.push(state.data as any);
          return [state.data];
        }
        return undefined;
      },
    });

    const deactivated = await deactivateAdminCurrency(adminId, currencyId, deactivateDb);
    expect(deactivated.isActive).toBe(false);
    expect(audits[1]!.action).toBe('currency.deactivate');
  });

  it('enforces setting range checks on update, audits updates, and protects required keys on delete', async () => {
    const audits: Array<{ action: string; changes: string }> = [];
    const now = new Date('2026-11-25T12:00:00Z');
    const settingId = '019363c8-1234-7000-8000-0000000000cc';

    const mockSettingDb = createMockKnex({
      onQuery(table, state) {
        if (table === 'settings') {
          if (state.op === 'select') {
            return {
              id: settingId,
              key: 'require_verified_lister_to_publish',
              value: 1,
              min_value: 0,
              max_value: 1,
              description: 'Publish verification flag',
              updated_by: null,
              updated_at: now,
            };
          }
          if (state.op === 'update') {
            const d = state.data as Record<string, unknown>;
            return [
              {
                id: settingId,
                key: 'require_verified_lister_to_publish',
                value: d.value ?? 1,
                min_value: 0,
                max_value: 1,
                description: 'Publish verification flag',
                updated_by: d.updated_by,
                updated_at: now,
              },
            ];
          }
        }
        if (table === 'audit_log' && state.op === 'insert') {
          audits.push(state.data as any);
          return [state.data];
        }
        return undefined;
      },
    });

    await expect(
      updateAdminSetting(
        adminId,
        { kind: 'key', value: 'require_verified_lister_to_publish' },
        { value: 2 },
        mockSettingDb,
      ),
    ).rejects.toMatchObject({ status: 400, code: 'SETTING_OUT_OF_RANGE' });
    expect(audits).toHaveLength(0);

    const updated = await updateAdminSetting(
      adminId,
      { kind: 'key', value: 'require_verified_lister_to_publish' },
      { value: 0 },
      mockSettingDb,
    );
    expect(updated.value).toBe(0);
    expect(updated.updatedBy).toBe(adminId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe('setting.update');
    expect(JSON.parse(audits[0]!.changes)).toEqual({
      key: 'require_verified_lister_to_publish',
      value: { from: 1, to: 0 },
    });

    // Required keys cannot be deleted
    expect(REQUIRED_SETTING_KEYS.has('freshness_days')).toBe(true);
    await expect(
      deleteAdminSetting(
        adminId,
        { kind: 'key', value: 'require_verified_lister_to_publish' },
        mockSettingDb,
      ),
    ).rejects.toMatchObject({ status: 409, code: 'SETTING_REQUIRED' });

    // Custom setting can be created and deleted with audit
    const customId = '019363c8-1234-7000-8000-0000000000dd';
    let exists = false;
    const customDb = createMockKnex({
      onQuery(table, state) {
        if (table === 'settings') {
          if (state.op === 'select') {
            return exists
              ? {
                  id: customId,
                  key: 'custom_limit',
                  value: 10,
                  min_value: 1,
                  max_value: 50,
                  description: 'Custom',
                  updated_by: adminId,
                  updated_at: now,
                }
              : undefined;
          }
          if (state.op === 'insert') {
            exists = true;
            const d = state.data as Record<string, unknown>;
            return [{ ...d, id: customId, updated_at: now }];
          }
          if (state.op === 'delete') {
            exists = false;
            return 1;
          }
        }
        if (table === 'audit_log' && state.op === 'insert') {
          audits.push(state.data as any);
          return [state.data];
        }
        return undefined;
      },
    });

    const createdCustom = await createAdminSetting(
      adminId,
      { key: 'custom_limit', value: 10, minValue: 1, maxValue: 50, description: 'Custom' },
      customDb,
    );
    expect(createdCustom.key).toBe('custom_limit');

    const deletedCustom = await deleteAdminSetting(
      adminId,
      { kind: 'key', value: 'custom_limit' },
      customDb,
    );
    expect(deletedCustom.key).toBe('custom_limit');
    expect(audits[audits.length - 1]!.action).toBe('setting.delete');
  });
});

describe('public reference routes', () => {
  it('serves active areas, currencies, categories, and service categories without auth', async () => {
    const now = new Date('2026-11-25T12:00:00Z');
    const area: AreaItem = {
      id: '019363c8-1234-7000-8000-000000000011',
      name: 'Ngong',
      slug: 'ngong',
      centreLat: -1.3617,
      centreLng: 36.6569,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };
    const currency: CurrencyItem = {
      id: '019363c8-1234-7000-8000-000000000012',
      code: 'KES',
      name: 'Kenyan shilling',
      isActive: true,
      sortOrder: 1,
    };
    const categories: SpaceCategoryItem[] = [
      {
        id: '019363c8-1234-7000-8000-000000000013',
        code: 'bedsitter',
        nameEn: 'Bedsitter',
        nameSw: 'Bedsitter',
        kind: 'residential',
        sortOrder: 1,
        isActive: true,
      },
      {
        id: '019363c8-1234-7000-8000-000000000014',
        code: 'office',
        nameEn: 'Office',
        nameSw: 'Ofisi',
        kind: 'commercial',
        sortOrder: 7,
        isActive: true,
      },
    ];
    const serviceCategory: ServiceCategoryItem = {
      id: '019363c8-1234-7000-8000-000000000015',
      code: 'wifi',
      nameEn: 'Wi-Fi',
      nameSw: 'Wi-Fi',
      sortOrder: 1,
      isActive: true,
    };

    const app = express();
    app.use('/areas', createAreasPublicRouter({
      listPublicAreas: async () => [area],
      getPublicAreaById: async (id) => {
        if (id === area.id) return area;
        throw notFound('Area not found.');
      },
    }));
    app.use('/currencies', createCurrenciesPublicRouter({
      listPublicCurrencies: async () => [currency],
      getPublicCurrencyById: async () => currency,
    }));
    app.use('/categories', createCategoriesPublicRouter({
      listPublicCategories: async (q) =>
        q.kind ? categories.filter((c) => c.kind === q.kind) : categories,
      getPublicCategoryById: async () => categories[0]!,
    }));
    app.use('/service-categories', createServiceCategoriesPublicRouter({
      listPublicServiceCategories: async () => [serviceCategory],
      getPublicServiceCategoryById: async () => serviceCategory,
    }));
    app.use(testErrorHandler);

    const baseUrl = await startTestApp(app);

    const areasRes = await fetch(`${baseUrl}/areas`);
    expect(areasRes.status).toBe(200);
    const areasBody = (await areasRes.json()) as { data: AreaItem[] };
    expect(areasBody.data).toHaveLength(1);
    expect(areasBody.data[0]!.slug).toBe('ngong');

    const missingAreaRes = await fetch(
      `${baseUrl}/areas/019363c8-1234-7000-8000-000000000099`,
    );
    expect(missingAreaRes.status).toBe(404);

    const badAreaIdRes = await fetch(`${baseUrl}/areas/bad-id`);
    expect(badAreaIdRes.status).toBe(400);

    const currenciesRes = await fetch(`${baseUrl}/currencies`);
    expect(currenciesRes.status).toBe(200);
    expect(((await currenciesRes.json()) as { data: CurrencyItem[] }).data[0]!.code).toBe('KES');

    const catRes = await fetch(`${baseUrl}/categories?kind=commercial`);
    expect(catRes.status).toBe(200);
    const catBody = (await catRes.json()) as { data: SpaceCategoryItem[] };
    expect(catBody.data).toHaveLength(1);
    expect(catBody.data[0]!.code).toBe('office');

    const badKindRes = await fetch(`${baseUrl}/categories?kind=invalid`);
    expect(badKindRes.status).toBe(400);

    const svcRes = await fetch(`${baseUrl}/service-categories`);
    expect(svcRes.status).toBe(200);
    expect(((await svcRes.json()) as { data: ServiceCategoryItem[] }).data[0]!.code).toBe('wifi');
  });
});

describe('admin reference & settings routes', () => {
  it('enforces auth (401) and admin role (403) on admin reference routes', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/admin',
      createAdminRouter({
        requireAuth: (_req, _res, next) => next(unauthorized('Authentication required')),
      }),
    );
    app.use(testErrorHandler);

    const baseUrl = await startTestApp(app);
    const unauthRes = await fetch(`${baseUrl}/admin/settings`);
    expect(unauthRes.status).toBe(401);

    await new Promise<void>((resolve, reject) =>
      activeServer!.close((err) => (err ? reject(err) : resolve())),
    );
    activeServer = null;

    const app2 = express();
    app2.use(express.json());
    app2.use(
      '/admin',
      createAdminRouter({
        requireAuth: (req, _res, next) => {
          req.auth = makeAdminAuth();
          req.auth.roles = ['client'];
          next();
        },
        requireAdmin: (_req, _res, next) => next(forbidden('Insufficient permissions')),
      }),
    );
    app2.use(testErrorHandler);

    const baseUrl2 = await startTestApp(app2);
    const forbiddenRes = await fetch(`${baseUrl2}/admin/areas`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ngong', centreLat: -1.36, centreLng: 36.65 }),
    });
    expect(forbiddenRes.status).toBe(403);
  });

  it('wires admin CRUD for areas, currencies, and settings', async () => {
    const adminAuth = makeAdminAuth();
    const now = new Date('2026-11-25T12:00:00Z');
    const areaId = '019363c8-1234-7000-8000-000000000101';
    const currencyId = '019363c8-1234-7000-8000-000000000102';
    const settingId = '019363c8-1234-7000-8000-000000000103';

    const sampleArea: AreaItem = {
      id: areaId,
      name: 'Ngong',
      slug: 'ngong',
      centreLat: -1.3617,
      centreLng: 36.6569,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };
    const sampleCurrency: CurrencyItem = {
      id: currencyId,
      code: 'KES',
      name: 'Kenyan shilling',
      isActive: true,
      sortOrder: 1,
    };
    const sampleSetting: SettingItem = {
      id: settingId,
      key: 'freshness_days',
      value: 7,
      minValue: 1,
      maxValue: null,
      description: 'Freshness days',
      updatedBy: adminAuth.user.id,
      updatedAt: now,
    };

    const app = express();
    app.use(express.json());
    app.use(
      '/admin',
      createAdminRouter({
        requireAuth: (req, _res, next) => {
          req.auth = adminAuth;
          next();
        },
        reference: {
          listAdminAreas: async () => [sampleArea],
          getAdminAreaById: async () => sampleArea,
          createAdminArea: async (_actor, input) => ({ ...sampleArea, ...input }),
          updateAdminArea: async (_actor, _id, patch) => ({ ...sampleArea, ...patch }),
          deactivateAdminArea: async () => ({ ...sampleArea, isActive: false }),
          listAdminCurrencies: async () => [sampleCurrency],
          getAdminCurrencyById: async () => sampleCurrency,
          createAdminCurrency: async (_actor, input) => {
            if (input.code === 'KES') {
              throw conflict('A currency with this code already exists.', {
                code: 'CURRENCY_CODE_EXISTS',
              });
            }
            return { ...sampleCurrency, ...input };
          },
          updateAdminCurrency: async (_actor, _id, patch) => ({ ...sampleCurrency, ...patch }),
          deactivateAdminCurrency: async () => ({ ...sampleCurrency, isActive: false }),
          listAdminSettings: async () => [sampleSetting],
          getAdminSetting: async () => sampleSetting,
          createAdminSetting: async (_actor, input) => ({ ...sampleSetting, ...input }),
          updateAdminSetting: async (_actor, _lookup, patch) => {
            if (patch.value !== undefined) {
              validateSettingValueInRange('freshness_days', patch.value, 1, null);
            }
            return { ...sampleSetting, ...patch };
          },
          deleteAdminSetting: async () => {
            throw conflict('Required system setting cannot be deleted.', {
              code: 'SETTING_REQUIRED',
            });
          },
        },
      }),
    );
    app.use(testErrorHandler);

    const baseUrl = await startTestApp(app);

    const createAreaRes = await fetch(`${baseUrl}/admin/areas`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ngong', centreLat: -1.3617, centreLng: 36.6569 }),
    });
    expect(createAreaRes.status).toBe(201);

    const patchAreaRes = await fetch(`${baseUrl}/admin/areas/${areaId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ngong Hills' }),
    });
    expect(patchAreaRes.status).toBe(200);

    const deleteAreaRes = await fetch(`${baseUrl}/admin/areas/${areaId}`, { method: 'DELETE' });
    expect(deleteAreaRes.status).toBe(200);
    expect(((await deleteAreaRes.json()) as { data: AreaItem }).data.isActive).toBe(false);

    const dupCurrRes = await fetch(`${baseUrl}/admin/currencies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'kes', name: 'Kenyan shilling' }),
    });
    expect(dupCurrRes.status).toBe(409);

    const badSettingRes = await fetch(`${baseUrl}/admin/settings/freshness_days`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 0 }),
    });
    expect(badSettingRes.status).toBe(400);
    const badSettingBody = (await badSettingRes.json()) as { code?: string };
    expect(badSettingBody.code).toBe('SETTING_OUT_OF_RANGE');

    const okSettingRes = await fetch(`${baseUrl}/admin/settings/${settingId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 10 }),
    });
    expect(okSettingRes.status).toBe(200);
    expect(((await okSettingRes.json()) as { data: SettingItem }).data.value).toBe(10);

    const delReqSettingRes = await fetch(`${baseUrl}/admin/settings/freshness_days`, {
      method: 'DELETE',
    });
    expect(delReqSettingRes.status).toBe(409);
  });
});
