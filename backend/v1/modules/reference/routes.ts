import express, { type Router } from 'express';
import { created, ok } from '../../lib/respond.js';
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
  type AdminActiveFilter,
  type CreateAreaInput,
  type CreateCurrencyInput,
  type CreateSettingInput,
  type PublicCategoriesQuery,
  type SettingLookup,
  type UpdateAreaInput,
  type UpdateCurrencyInput,
  type UpdateSettingInput,
} from './schemas.js';
import {
  createAdminArea,
  createAdminCurrency,
  createAdminSetting,
  deactivateAdminArea,
  deactivateAdminCurrency,
  deleteAdminSetting,
  getAdminAreaById,
  getAdminCurrencyById,
  getAdminSetting,
  getPublicAreaById,
  getPublicCategoryById,
  getPublicCurrencyById,
  getPublicServiceCategoryById,
  listAdminAreas,
  listAdminCurrencies,
  listAdminSettings,
  listPublicAreas,
  listPublicCategories,
  listPublicCurrencies,
  listPublicServiceCategories,
  updateAdminArea,
  updateAdminCurrency,
  updateAdminSetting,
  type AreaItem,
  type CurrencyItem,
  type ServiceCategoryItem,
  type SettingItem,
  type SpaceCategoryItem,
} from './service.js';

export interface AreasPublicRouterDeps {
  listPublicAreas?: () => Promise<AreaItem[]>;
  getPublicAreaById?: (id: string) => Promise<AreaItem>;
}

export interface CurrenciesPublicRouterDeps {
  listPublicCurrencies?: () => Promise<CurrencyItem[]>;
  getPublicCurrencyById?: (id: string) => Promise<CurrencyItem>;
}

export interface CategoriesPublicRouterDeps {
  listPublicCategories?: (query: PublicCategoriesQuery) => Promise<SpaceCategoryItem[]>;
  getPublicCategoryById?: (id: string) => Promise<SpaceCategoryItem>;
}

export interface ServiceCategoriesPublicRouterDeps {
  listPublicServiceCategories?: () => Promise<ServiceCategoryItem[]>;
  getPublicServiceCategoryById?: (id: string) => Promise<ServiceCategoryItem>;
}

export interface AdminReferenceRouterDeps {
  listAdminAreas?: (filter: AdminActiveFilter) => Promise<AreaItem[]>;
  getAdminAreaById?: (id: string) => Promise<AreaItem>;
  createAdminArea?: (adminUserId: string, input: CreateAreaInput) => Promise<AreaItem>;
  updateAdminArea?: (
    adminUserId: string,
    areaId: string,
    patch: UpdateAreaInput,
  ) => Promise<AreaItem>;
  deactivateAdminArea?: (adminUserId: string, areaId: string) => Promise<AreaItem>;
  listAdminCurrencies?: (filter: AdminActiveFilter) => Promise<CurrencyItem[]>;
  getAdminCurrencyById?: (id: string) => Promise<CurrencyItem>;
  createAdminCurrency?: (
    adminUserId: string,
    input: CreateCurrencyInput,
  ) => Promise<CurrencyItem>;
  updateAdminCurrency?: (
    adminUserId: string,
    currencyId: string,
    patch: UpdateCurrencyInput,
  ) => Promise<CurrencyItem>;
  deactivateAdminCurrency?: (adminUserId: string, currencyId: string) => Promise<CurrencyItem>;
  listAdminSettings?: () => Promise<SettingItem[]>;
  getAdminSetting?: (lookup: SettingLookup) => Promise<SettingItem>;
  createAdminSetting?: (adminUserId: string, input: CreateSettingInput) => Promise<SettingItem>;
  updateAdminSetting?: (
    adminUserId: string,
    lookup: SettingLookup,
    patch: UpdateSettingInput,
  ) => Promise<SettingItem>;
  deleteAdminSetting?: (adminUserId: string, lookup: SettingLookup) => Promise<SettingItem>;
}

export function createAreasPublicRouter(deps: AreasPublicRouterDeps = {}): Router {
  const router = express.Router();
  const listFn = deps.listPublicAreas ?? listPublicAreas;
  const getByIdFn = deps.getPublicAreaById ?? getPublicAreaById;

  router.get('/', async (_req, res) => {
    const items = await listFn();
    ok(res, items, 'Areas');
  });

  router.get('/:id', async (req, res) => {
    const id = parseReferenceIdParam(req.params.id, 'area');
    const item = await getByIdFn(id);
    ok(res, item, 'Area');
  });

  return router;
}

export function createCurrenciesPublicRouter(deps: CurrenciesPublicRouterDeps = {}): Router {
  const router = express.Router();
  const listFn = deps.listPublicCurrencies ?? listPublicCurrencies;
  const getByIdFn = deps.getPublicCurrencyById ?? getPublicCurrencyById;

  router.get('/', async (_req, res) => {
    const items = await listFn();
    ok(res, items, 'Currencies');
  });

  router.get('/:id', async (req, res) => {
    const id = parseReferenceIdParam(req.params.id, 'currency');
    const item = await getByIdFn(id);
    ok(res, item, 'Currency');
  });

  return router;
}

export function createCategoriesPublicRouter(deps: CategoriesPublicRouterDeps = {}): Router {
  const router = express.Router();
  const listFn = deps.listPublicCategories ?? listPublicCategories;
  const getByIdFn = deps.getPublicCategoryById ?? getPublicCategoryById;

  router.get('/', async (req, res) => {
    const query = parsePublicCategoriesQuery(req.query as Record<string, unknown>);
    const items = await listFn(query);
    ok(res, items, 'Space categories');
  });

  router.get('/:id', async (req, res) => {
    const id = parseReferenceIdParam(req.params.id, 'category');
    const item = await getByIdFn(id);
    ok(res, item, 'Space category');
  });

  return router;
}

export function createServiceCategoriesPublicRouter(
  deps: ServiceCategoriesPublicRouterDeps = {},
): Router {
  const router = express.Router();
  const listFn = deps.listPublicServiceCategories ?? listPublicServiceCategories;
  const getByIdFn = deps.getPublicServiceCategoryById ?? getPublicServiceCategoryById;

  router.get('/', async (_req, res) => {
    const items = await listFn();
    ok(res, items, 'Service categories');
  });

  router.get('/:id', async (req, res) => {
    const id = parseReferenceIdParam(req.params.id, 'service category');
    const item = await getByIdFn(id);
    ok(res, item, 'Service category');
  });

  return router;
}

export function createAdminReferenceRouter(deps: AdminReferenceRouterDeps = {}): Router {
  const router = express.Router();

  const listAreasFn = deps.listAdminAreas ?? listAdminAreas;
  const getAreaFn = deps.getAdminAreaById ?? getAdminAreaById;
  const createAreaFn = deps.createAdminArea ?? createAdminArea;
  const updateAreaFn = deps.updateAdminArea ?? updateAdminArea;
  const deactivateAreaFn = deps.deactivateAdminArea ?? deactivateAdminArea;

  const listCurrenciesFn = deps.listAdminCurrencies ?? listAdminCurrencies;
  const getCurrencyFn = deps.getAdminCurrencyById ?? getAdminCurrencyById;
  const createCurrencyFn = deps.createAdminCurrency ?? createAdminCurrency;
  const updateCurrencyFn = deps.updateAdminCurrency ?? updateAdminCurrency;
  const deactivateCurrencyFn = deps.deactivateAdminCurrency ?? deactivateAdminCurrency;

  const listSettingsFn = deps.listAdminSettings ?? listAdminSettings;
  const getSettingFn = deps.getAdminSetting ?? getAdminSetting;
  const createSettingFn = deps.createAdminSetting ?? createAdminSetting;
  const updateSettingFn = deps.updateAdminSetting ?? updateAdminSetting;
  const deleteSettingFn = deps.deleteAdminSetting ?? deleteAdminSetting;

  // ---- Admin Areas ------------------------------------------------------------------------------

  router.get('/areas', async (req, res) => {
    const filter = parseAdminActiveFilterQuery(req.query as Record<string, unknown>);
    const items = await listAreasFn(filter);
    ok(res, items, 'Admin areas');
  });

  router.get('/areas/:id', async (req, res) => {
    const id = parseReferenceIdParam(req.params.id, 'area');
    const item = await getAreaFn(id);
    ok(res, item, 'Area');
  });

  router.post('/areas', async (req, res) => {
    const input = parseCreateAreaBody(req.body);
    const item = await createAreaFn(req.auth!.user.id, input);
    created(res, item, 'Area created');
  });

  router.patch('/areas/:id', async (req, res) => {
    const id = parseReferenceIdParam(req.params.id, 'area');
    const patch = parseUpdateAreaBody(req.body);
    const item = await updateAreaFn(req.auth!.user.id, id, patch);
    ok(res, item, 'Area updated');
  });

  router.delete('/areas/:id', async (req, res) => {
    const id = parseReferenceIdParam(req.params.id, 'area');
    const item = await deactivateAreaFn(req.auth!.user.id, id);
    ok(res, item, 'Area deactivated');
  });

  // ---- Admin Currencies -------------------------------------------------------------------------

  router.get('/currencies', async (req, res) => {
    const filter = parseAdminActiveFilterQuery(req.query as Record<string, unknown>);
    const items = await listCurrenciesFn(filter);
    ok(res, items, 'Admin currencies');
  });

  router.get('/currencies/:id', async (req, res) => {
    const id = parseReferenceIdParam(req.params.id, 'currency');
    const item = await getCurrencyFn(id);
    ok(res, item, 'Currency');
  });

  router.post('/currencies', async (req, res) => {
    const input = parseCreateCurrencyBody(req.body);
    const item = await createCurrencyFn(req.auth!.user.id, input);
    created(res, item, 'Currency created');
  });

  router.patch('/currencies/:id', async (req, res) => {
    const id = parseReferenceIdParam(req.params.id, 'currency');
    const patch = parseUpdateCurrencyBody(req.body);
    const item = await updateCurrencyFn(req.auth!.user.id, id, patch);
    ok(res, item, 'Currency updated');
  });

  router.delete('/currencies/:id', async (req, res) => {
    const id = parseReferenceIdParam(req.params.id, 'currency');
    const item = await deactivateCurrencyFn(req.auth!.user.id, id);
    ok(res, item, 'Currency deactivated');
  });

  // ---- Admin Settings ---------------------------------------------------------------------------

  router.get('/settings', async (_req, res) => {
    const items = await listSettingsFn();
    ok(res, items, 'Admin settings');
  });

  router.get('/settings/:id', async (req, res) => {
    const lookup = parseSettingLookupParam(req.params.id);
    const item = await getSettingFn(lookup);
    ok(res, item, 'Setting');
  });

  router.post('/settings', async (req, res) => {
    const input = parseCreateSettingBody(req.body);
    const item = await createSettingFn(req.auth!.user.id, input);
    created(res, item, 'Setting created');
  });

  router.patch('/settings/:id', async (req, res) => {
    const lookup = parseSettingLookupParam(req.params.id);
    const patch = parseUpdateSettingBody(req.body);
    const item = await updateSettingFn(req.auth!.user.id, lookup, patch);
    ok(res, item, 'Setting updated');
  });

  router.delete('/settings/:id', async (req, res) => {
    const lookup = parseSettingLookupParam(req.params.id);
    const item = await deleteSettingFn(req.auth!.user.id, lookup);
    ok(res, item, 'Setting deleted');
  });

  return router;
}

export const areasPublicRoutes = createAreasPublicRouter();
export const currenciesPublicRoutes = createCurrenciesPublicRouter();
export const categoriesPublicRoutes = createCategoriesPublicRouter();
export const serviceCategoriesPublicRoutes = createServiceCategoriesPublicRouter();
export const adminReferenceRoutes = createAdminReferenceRouter();
