import type { Knex } from 'knex';
import db from '../../db/knex.js';
import { badRequest, conflict, notFound } from '../../lib/http-error.js';
import { generateUuidV7 } from '../../lib/uuid.js';
import {
  validateSettingValueInRange,
  type AdminActiveFilter,
  type CreateAreaInput,
  type CreateCurrencyInput,
  type CreateSettingInput,
  type PublicCategoriesQuery,
  type SettingLookup,
  type SpaceCategoryKind,
  type UpdateAreaInput,
  type UpdateCurrencyInput,
  type UpdateSettingInput,
} from './schemas.js';

export const REQUIRED_SETTING_KEYS: ReadonlySet<string> = new Set([
  'freshness_days',
  'reminder_lead_days',
  'reminder_repeat_days',
  'hide_after_days',
  'max_promoted_per_building',
  'min_building_photos',
  'min_surroundings_photos',
  'min_space_type_photos',
  'require_verified_lister_to_publish',
]);

export interface AreaItem {
  id: string;
  name: string;
  slug: string;
  centreLat: number;
  centreLng: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CurrencyItem {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  sortOrder: number;
}

export interface SpaceCategoryItem {
  id: string;
  code: string;
  nameEn: string;
  nameSw: string;
  kind: SpaceCategoryKind;
  sortOrder: number;
  isActive: boolean;
}

export interface ServiceCategoryItem {
  id: string;
  code: string;
  nameEn: string;
  nameSw: string;
  sortOrder: number;
  isActive: boolean;
}

export interface SettingItem {
  id: string;
  key: string;
  value: number;
  minValue: number;
  maxValue: number | null;
  description: string;
  updatedBy: string | null;
  updatedAt: Date;
}

interface AreaDbRow {
  id: string;
  name: string;
  slug: string;
  centre_lat: string | number;
  centre_lng: string | number;
  is_active: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

interface CurrencyDbRow {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
  sort_order: number;
}

interface SpaceCategoryDbRow {
  id: string;
  code: string;
  name_en: string;
  name_sw: string;
  kind: SpaceCategoryKind;
  sort_order: number;
  is_active: boolean;
}

interface ServiceCategoryDbRow {
  id: string;
  code: string;
  name_en: string;
  name_sw: string;
  sort_order: number;
  is_active: boolean;
}

interface SettingDbRow {
  id: string;
  key: string;
  value: number;
  min_value: number;
  max_value: number | null;
  description: string;
  updated_by: string | null;
  updated_at: Date | string;
}

interface PgError {
  code?: string;
  constraint?: string;
  message?: string;
}

const AREA_COLUMNS = [
  'id',
  'name',
  'slug',
  'centre_lat',
  'centre_lng',
  'is_active',
  'created_at',
  'updated_at',
] as const;

const CURRENCY_COLUMNS = ['id', 'code', 'name', 'is_active', 'sort_order'] as const;

const SPACE_CATEGORY_COLUMNS = [
  'id',
  'code',
  'name_en',
  'name_sw',
  'kind',
  'sort_order',
  'is_active',
] as const;

const SERVICE_CATEGORY_COLUMNS = [
  'id',
  'code',
  'name_en',
  'name_sw',
  'sort_order',
  'is_active',
] as const;

const SETTING_COLUMNS = [
  'id',
  'key',
  'value',
  'min_value',
  'max_value',
  'description',
  'updated_by',
  'updated_at',
] as const;

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function mapAreaRow(row: AreaDbRow): AreaItem {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    centreLat: Number(row.centre_lat),
    centreLng: Number(row.centre_lng),
    isActive: row.is_active,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapCurrencyRow(row: CurrencyDbRow): CurrencyItem {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    isActive: row.is_active,
    sortOrder: Number(row.sort_order),
  };
}

function mapSpaceCategoryRow(row: SpaceCategoryDbRow): SpaceCategoryItem {
  return {
    id: row.id,
    code: row.code,
    nameEn: row.name_en,
    nameSw: row.name_sw,
    kind: row.kind,
    sortOrder: Number(row.sort_order),
    isActive: row.is_active,
  };
}

function mapServiceCategoryRow(row: ServiceCategoryDbRow): ServiceCategoryItem {
  return {
    id: row.id,
    code: row.code,
    nameEn: row.name_en,
    nameSw: row.name_sw,
    sortOrder: Number(row.sort_order),
    isActive: row.is_active,
  };
}

function mapSettingRow(row: SettingDbRow): SettingItem {
  return {
    id: row.id,
    key: row.key,
    value: Number(row.value),
    minValue: Number(row.min_value),
    maxValue: row.max_value === null ? null : Number(row.max_value),
    description: row.description,
    updatedBy: row.updated_by,
    updatedAt: toDate(row.updated_at),
  };
}

async function recordStaffAudit(
  trx: Knex.Transaction,
  adminUserId: string,
  action: string,
  objectType: 'area' | 'currency' | 'setting',
  objectId: string,
  changes: Record<string, unknown>,
): Promise<void> {
  await trx('audit_log').insert({
    id: generateUuidV7(),
    actor_user_id: adminUserId,
    actor_type: 'staff',
    action,
    object_type: objectType,
    object_id: objectId,
    changes: JSON.stringify(changes),
  });
}

function rethrowMappedAreaError(err: unknown): never {
  const pgErr = err as PgError;
  if (pgErr?.code === '23505') {
    if (pgErr.constraint === 'ux_areas_name_lower') {
      throw conflict('An area with this name already exists.', { code: 'AREA_NAME_EXISTS' });
    }
    if (pgErr.constraint === 'ux_areas_slug') {
      throw conflict('An area with this slug already exists.', { code: 'AREA_SLUG_EXISTS' });
    }
    throw conflict('Area violates a uniqueness constraint.', { code: 'AREA_CONFLICT' });
  }
  if (pgErr?.code === '23514') {
    throw badRequest(pgErr.message || 'Area fields violate a check constraint.', {
      code: 'AREA_INVALID',
    });
  }
  throw err;
}

function rethrowMappedCurrencyError(err: unknown): never {
  const pgErr = err as PgError;
  if (pgErr?.code === '23505') {
    throw conflict('A currency with this code already exists.', { code: 'CURRENCY_CODE_EXISTS' });
  }
  if (pgErr?.code === '23514') {
    throw badRequest(pgErr.message || 'Currency fields violate a check constraint.', {
      code: 'CURRENCY_INVALID',
    });
  }
  throw err;
}

function rethrowMappedSettingError(err: unknown): never {
  const pgErr = err as PgError;
  if (pgErr?.code === '23505') {
    throw conflict('A setting with this key already exists.', { code: 'SETTING_KEY_EXISTS' });
  }
  if (pgErr?.code === '23514') {
    throw badRequest(pgErr.message || 'Setting value is outside the allowed range.', {
      code: 'SETTING_OUT_OF_RANGE',
    });
  }
  throw err;
}

function settingWhereClause(lookup: SettingLookup): { id: string } | { key: string } {
  return lookup.kind === 'id' ? { id: lookup.value } : { key: lookup.value };
}

// ---- Public reads -----------------------------------------------------------------------------

export async function listPublicAreas(conn: Knex = db): Promise<AreaItem[]> {
  const rows = (await conn('areas')
    .where({ is_active: true })
    .select(...AREA_COLUMNS)
    .orderBy('name', 'asc')) as AreaDbRow[];
  return rows.map(mapAreaRow);
}

export async function getPublicAreaById(id: string, conn: Knex = db): Promise<AreaItem> {
  const row = (await conn('areas')
    .where({ id, is_active: true })
    .first(...AREA_COLUMNS)) as AreaDbRow | undefined;
  if (!row) {
    throw notFound('Area not found.', { code: 'AREA_NOT_FOUND' });
  }
  return mapAreaRow(row);
}

export async function listPublicCurrencies(conn: Knex = db): Promise<CurrencyItem[]> {
  const rows = (await conn('currencies')
    .where({ is_active: true })
    .select(...CURRENCY_COLUMNS)
    .orderBy([
      { column: 'sort_order', order: 'asc' },
      { column: 'code', order: 'asc' },
    ])) as CurrencyDbRow[];
  return rows.map(mapCurrencyRow);
}

export async function getPublicCurrencyById(id: string, conn: Knex = db): Promise<CurrencyItem> {
  const row = (await conn('currencies')
    .where({ id, is_active: true })
    .first(...CURRENCY_COLUMNS)) as CurrencyDbRow | undefined;
  if (!row) {
    throw notFound('Currency not found.', { code: 'CURRENCY_NOT_FOUND' });
  }
  return mapCurrencyRow(row);
}

export async function listPublicCategories(
  query: PublicCategoriesQuery = {},
  conn: Knex = db,
): Promise<SpaceCategoryItem[]> {
  const qb = conn('space_categories').where({ is_active: true });
  if (query.kind !== undefined) {
    qb.where({ kind: query.kind });
  }
  const rows = (await qb.select(...SPACE_CATEGORY_COLUMNS).orderBy([
    { column: 'sort_order', order: 'asc' },
    { column: 'code', order: 'asc' },
  ])) as SpaceCategoryDbRow[];
  return rows.map(mapSpaceCategoryRow);
}

export async function getPublicCategoryById(
  id: string,
  conn: Knex = db,
): Promise<SpaceCategoryItem> {
  const row = (await conn('space_categories')
    .where({ id, is_active: true })
    .first(...SPACE_CATEGORY_COLUMNS)) as SpaceCategoryDbRow | undefined;
  if (!row) {
    throw notFound('Space category not found.', { code: 'CATEGORY_NOT_FOUND' });
  }
  return mapSpaceCategoryRow(row);
}

export async function listPublicServiceCategories(
  conn: Knex = db,
): Promise<ServiceCategoryItem[]> {
  const rows = (await conn('service_categories')
    .where({ is_active: true })
    .select(...SERVICE_CATEGORY_COLUMNS)
    .orderBy([
      { column: 'sort_order', order: 'asc' },
      { column: 'code', order: 'asc' },
    ])) as ServiceCategoryDbRow[];
  return rows.map(mapServiceCategoryRow);
}

export async function getPublicServiceCategoryById(
  id: string,
  conn: Knex = db,
): Promise<ServiceCategoryItem> {
  const row = (await conn('service_categories')
    .where({ id, is_active: true })
    .first(...SERVICE_CATEGORY_COLUMNS)) as ServiceCategoryDbRow | undefined;
  if (!row) {
    throw notFound('Service category not found.', { code: 'SERVICE_CATEGORY_NOT_FOUND' });
  }
  return mapServiceCategoryRow(row);
}

// ---- Admin Areas CRUD -------------------------------------------------------------------------

export async function listAdminAreas(
  filter: AdminActiveFilter = {},
  conn: Knex = db,
): Promise<AreaItem[]> {
  const qb = conn('areas');
  if (filter.isActive !== undefined) {
    qb.where({ is_active: filter.isActive });
  }
  const rows = (await qb.select(...AREA_COLUMNS).orderBy('name', 'asc')) as AreaDbRow[];
  return rows.map(mapAreaRow);
}

export async function getAdminAreaById(id: string, conn: Knex = db): Promise<AreaItem> {
  const row = (await conn('areas').where({ id }).first(...AREA_COLUMNS)) as AreaDbRow | undefined;
  if (!row) {
    throw notFound('Area not found.', { code: 'AREA_NOT_FOUND' });
  }
  return mapAreaRow(row);
}

export async function createAdminArea(
  adminUserId: string,
  input: CreateAreaInput,
  conn: Knex = db,
): Promise<AreaItem> {
  return conn.transaction(async (trx) => {
    const existingByName = await trx('areas')
      .whereRaw('lower(name) = lower(?)', [input.name])
      .first('id');
    if (existingByName) {
      throw conflict('An area with this name already exists.', { code: 'AREA_NAME_EXISTS' });
    }

    const existingBySlug = await trx('areas').where({ slug: input.slug }).first('id');
    if (existingBySlug) {
      throw conflict('An area with this slug already exists.', { code: 'AREA_SLUG_EXISTS' });
    }

    const areaId = generateUuidV7();
    let inserted: AreaDbRow | undefined;
    try {
      [inserted] = (await trx('areas')
        .insert({
          id: areaId,
          name: input.name,
          slug: input.slug,
          centre_lat: input.centreLat,
          centre_lng: input.centreLng,
          is_active: input.isActive,
        })
        .returning([...AREA_COLUMNS])) as AreaDbRow[];
    } catch (err) {
      rethrowMappedAreaError(err);
    }

    const area = mapAreaRow(inserted!);
    await recordStaffAudit(trx, adminUserId, 'area.create', 'area', area.id, {
      name: area.name,
      slug: area.slug,
      centre_lat: area.centreLat,
      centre_lng: area.centreLng,
      is_active: area.isActive,
    });

    return area;
  });
}

export async function updateAdminArea(
  adminUserId: string,
  areaId: string,
  patch: UpdateAreaInput,
  conn: Knex = db,
): Promise<AreaItem> {
  return conn.transaction(async (trx) => {
    const current = (await trx('areas')
      .where({ id: areaId })
      .forUpdate()
      .first(...AREA_COLUMNS)) as AreaDbRow | undefined;
    if (!current) {
      throw notFound('Area not found.', { code: 'AREA_NOT_FOUND' });
    }

    const updates: Record<string, unknown> = {};
    const changes: Record<string, { from: unknown; to: unknown }> = {};

    if (patch.name !== undefined && patch.name !== current.name) {
      const conflictName = await trx('areas')
        .whereRaw('lower(name) = lower(?)', [patch.name])
        .whereNot({ id: areaId })
        .first('id');
      if (conflictName) {
        throw conflict('An area with this name already exists.', { code: 'AREA_NAME_EXISTS' });
      }
      updates.name = patch.name;
      changes.name = { from: current.name, to: patch.name };
    }

    if (patch.slug !== undefined && patch.slug !== current.slug) {
      const conflictSlug = await trx('areas')
        .where({ slug: patch.slug })
        .whereNot({ id: areaId })
        .first('id');
      if (conflictSlug) {
        throw conflict('An area with this slug already exists.', { code: 'AREA_SLUG_EXISTS' });
      }
      updates.slug = patch.slug;
      changes.slug = { from: current.slug, to: patch.slug };
    }

    const currentLat = Number(current.centre_lat);
    if (patch.centreLat !== undefined && patch.centreLat !== currentLat) {
      updates.centre_lat = patch.centreLat;
      changes.centre_lat = { from: currentLat, to: patch.centreLat };
    }

    const currentLng = Number(current.centre_lng);
    if (patch.centreLng !== undefined && patch.centreLng !== currentLng) {
      updates.centre_lng = patch.centreLng;
      changes.centre_lng = { from: currentLng, to: patch.centreLng };
    }

    if (patch.isActive !== undefined && patch.isActive !== current.is_active) {
      updates.is_active = patch.isActive;
      changes.is_active = { from: current.is_active, to: patch.isActive };
    }

    if (Object.keys(updates).length === 0) {
      return mapAreaRow(current);
    }

    let updated: AreaDbRow | undefined;
    try {
      [updated] = (await trx('areas')
        .where({ id: areaId })
        .update(updates)
        .returning([...AREA_COLUMNS])) as AreaDbRow[];
    } catch (err) {
      rethrowMappedAreaError(err);
    }

    await recordStaffAudit(trx, adminUserId, 'area.update', 'area', areaId, changes);

    return mapAreaRow(updated!);
  });
}

export async function deactivateAdminArea(
  adminUserId: string,
  areaId: string,
  conn: Knex = db,
): Promise<AreaItem> {
  return conn.transaction(async (trx) => {
    const current = (await trx('areas')
      .where({ id: areaId })
      .forUpdate()
      .first(...AREA_COLUMNS)) as AreaDbRow | undefined;
    if (!current) {
      throw notFound('Area not found.', { code: 'AREA_NOT_FOUND' });
    }

    if (!current.is_active) {
      return mapAreaRow(current);
    }

    const [updated] = (await trx('areas')
      .where({ id: areaId })
      .update({ is_active: false })
      .returning([...AREA_COLUMNS])) as AreaDbRow[];

    await recordStaffAudit(trx, adminUserId, 'area.deactivate', 'area', areaId, {
      is_active: { from: true, to: false },
    });

    return mapAreaRow(updated!);
  });
}

// ---- Admin Currencies CRUD --------------------------------------------------------------------

export async function listAdminCurrencies(
  filter: AdminActiveFilter = {},
  conn: Knex = db,
): Promise<CurrencyItem[]> {
  const qb = conn('currencies');
  if (filter.isActive !== undefined) {
    qb.where({ is_active: filter.isActive });
  }
  const rows = (await qb.select(...CURRENCY_COLUMNS).orderBy([
    { column: 'sort_order', order: 'asc' },
    { column: 'code', order: 'asc' },
  ])) as CurrencyDbRow[];
  return rows.map(mapCurrencyRow);
}

export async function getAdminCurrencyById(id: string, conn: Knex = db): Promise<CurrencyItem> {
  const row = (await conn('currencies')
    .where({ id })
    .first(...CURRENCY_COLUMNS)) as CurrencyDbRow | undefined;
  if (!row) {
    throw notFound('Currency not found.', { code: 'CURRENCY_NOT_FOUND' });
  }
  return mapCurrencyRow(row);
}

export async function createAdminCurrency(
  adminUserId: string,
  input: CreateCurrencyInput,
  conn: Knex = db,
): Promise<CurrencyItem> {
  return conn.transaction(async (trx) => {
    const existing = await trx('currencies').where({ code: input.code }).first('id');
    if (existing) {
      throw conflict('A currency with this code already exists.', { code: 'CURRENCY_CODE_EXISTS' });
    }

    const currencyId = generateUuidV7();
    let inserted: CurrencyDbRow | undefined;
    try {
      [inserted] = (await trx('currencies')
        .insert({
          id: currencyId,
          code: input.code,
          name: input.name,
          is_active: input.isActive,
          sort_order: input.sortOrder,
        })
        .returning([...CURRENCY_COLUMNS])) as CurrencyDbRow[];
    } catch (err) {
      rethrowMappedCurrencyError(err);
    }

    const currency = mapCurrencyRow(inserted!);
    await recordStaffAudit(trx, adminUserId, 'currency.create', 'currency', currency.id, {
      code: currency.code,
      name: currency.name,
      is_active: currency.isActive,
      sort_order: currency.sortOrder,
    });

    return currency;
  });
}

export async function updateAdminCurrency(
  adminUserId: string,
  currencyId: string,
  patch: UpdateCurrencyInput,
  conn: Knex = db,
): Promise<CurrencyItem> {
  return conn.transaction(async (trx) => {
    const current = (await trx('currencies')
      .where({ id: currencyId })
      .forUpdate()
      .first(...CURRENCY_COLUMNS)) as CurrencyDbRow | undefined;
    if (!current) {
      throw notFound('Currency not found.', { code: 'CURRENCY_NOT_FOUND' });
    }

    const updates: Record<string, unknown> = {};
    const changes: Record<string, { from: unknown; to: unknown }> = {};

    if (patch.code !== undefined && patch.code !== current.code) {
      const conflictCode = await trx('currencies')
        .where({ code: patch.code })
        .whereNot({ id: currencyId })
        .first('id');
      if (conflictCode) {
        throw conflict('A currency with this code already exists.', {
          code: 'CURRENCY_CODE_EXISTS',
        });
      }
      updates.code = patch.code;
      changes.code = { from: current.code, to: patch.code };
    }

    if (patch.name !== undefined && patch.name !== current.name) {
      updates.name = patch.name;
      changes.name = { from: current.name, to: patch.name };
    }

    if (patch.isActive !== undefined && patch.isActive !== current.is_active) {
      updates.is_active = patch.isActive;
      changes.is_active = { from: current.is_active, to: patch.isActive };
    }

    const currentOrder = Number(current.sort_order);
    if (patch.sortOrder !== undefined && patch.sortOrder !== currentOrder) {
      updates.sort_order = patch.sortOrder;
      changes.sort_order = { from: currentOrder, to: patch.sortOrder };
    }

    if (Object.keys(updates).length === 0) {
      return mapCurrencyRow(current);
    }

    let updated: CurrencyDbRow | undefined;
    try {
      [updated] = (await trx('currencies')
        .where({ id: currencyId })
        .update(updates)
        .returning([...CURRENCY_COLUMNS])) as CurrencyDbRow[];
    } catch (err) {
      rethrowMappedCurrencyError(err);
    }

    await recordStaffAudit(trx, adminUserId, 'currency.update', 'currency', currencyId, changes);

    return mapCurrencyRow(updated!);
  });
}

export async function deactivateAdminCurrency(
  adminUserId: string,
  currencyId: string,
  conn: Knex = db,
): Promise<CurrencyItem> {
  return conn.transaction(async (trx) => {
    const current = (await trx('currencies')
      .where({ id: currencyId })
      .forUpdate()
      .first(...CURRENCY_COLUMNS)) as CurrencyDbRow | undefined;
    if (!current) {
      throw notFound('Currency not found.', { code: 'CURRENCY_NOT_FOUND' });
    }

    if (!current.is_active) {
      return mapCurrencyRow(current);
    }

    const [updated] = (await trx('currencies')
      .where({ id: currencyId })
      .update({ is_active: false })
      .returning([...CURRENCY_COLUMNS])) as CurrencyDbRow[];

    await recordStaffAudit(trx, adminUserId, 'currency.deactivate', 'currency', currencyId, {
      is_active: { from: true, to: false },
    });

    return mapCurrencyRow(updated!);
  });
}

// ---- Admin Settings CRUD (Range-checked & Audited) --------------------------------------------

export async function listAdminSettings(conn: Knex = db): Promise<SettingItem[]> {
  const rows = (await conn('settings')
    .select(...SETTING_COLUMNS)
    .orderBy('key', 'asc')) as SettingDbRow[];
  return rows.map(mapSettingRow);
}

export async function getAdminSetting(
  lookup: SettingLookup,
  conn: Knex = db,
): Promise<SettingItem> {
  const row = (await conn('settings')
    .where(settingWhereClause(lookup))
    .first(...SETTING_COLUMNS)) as SettingDbRow | undefined;
  if (!row) {
    throw notFound('Setting not found.', { code: 'SETTING_NOT_FOUND' });
  }
  return mapSettingRow(row);
}

export async function createAdminSetting(
  adminUserId: string,
  input: CreateSettingInput,
  conn: Knex = db,
): Promise<SettingItem> {
  validateSettingValueInRange(input.key, input.value, input.minValue, input.maxValue);

  return conn.transaction(async (trx) => {
    const existing = await trx('settings').where({ key: input.key }).first('id');
    if (existing) {
      throw conflict('A setting with this key already exists.', { code: 'SETTING_KEY_EXISTS' });
    }

    const settingId = generateUuidV7();
    let inserted: SettingDbRow | undefined;
    try {
      [inserted] = (await trx('settings')
        .insert({
          id: settingId,
          key: input.key,
          value: input.value,
          min_value: input.minValue,
          max_value: input.maxValue,
          description: input.description,
          updated_by: adminUserId,
        })
        .returning([...SETTING_COLUMNS])) as SettingDbRow[];
    } catch (err) {
      rethrowMappedSettingError(err);
    }

    const setting = mapSettingRow(inserted!);
    await recordStaffAudit(trx, adminUserId, 'setting.create', 'setting', setting.id, {
      key: setting.key,
      value: setting.value,
      min_value: setting.minValue,
      max_value: setting.maxValue,
      description: setting.description,
    });

    return setting;
  });
}

export async function updateAdminSetting(
  adminUserId: string,
  lookup: SettingLookup,
  patch: UpdateSettingInput,
  conn: Knex = db,
): Promise<SettingItem> {
  return conn.transaction(async (trx) => {
    const current = (await trx('settings')
      .where(settingWhereClause(lookup))
      .forUpdate()
      .first(...SETTING_COLUMNS)) as SettingDbRow | undefined;
    if (!current) {
      throw notFound('Setting not found.', { code: 'SETTING_NOT_FOUND' });
    }

    const minValue = Number(current.min_value);
    const maxValue = current.max_value === null ? null : Number(current.max_value);
    const currentValue = Number(current.value);

    const updates: Record<string, unknown> = {};
    const changes: Record<string, { from: unknown; to: unknown }> = {};

    if (patch.value !== undefined) {
      validateSettingValueInRange(current.key, patch.value, minValue, maxValue);
      if (patch.value !== currentValue) {
        updates.value = patch.value;
        changes.value = { from: currentValue, to: patch.value };
      }
    }

    if (patch.description !== undefined && patch.description !== current.description) {
      updates.description = patch.description;
      changes.description = { from: current.description, to: patch.description };
    }

    if (Object.keys(updates).length === 0) {
      return mapSettingRow(current);
    }

    updates.updated_by = adminUserId;

    let updated: SettingDbRow | undefined;
    try {
      [updated] = (await trx('settings')
        .where({ id: current.id })
        .update(updates)
        .returning([...SETTING_COLUMNS])) as SettingDbRow[];
    } catch (err) {
      rethrowMappedSettingError(err);
    }

    await recordStaffAudit(trx, adminUserId, 'setting.update', 'setting', current.id, {
      key: current.key,
      ...changes,
    });

    return mapSettingRow(updated!);
  });
}

export async function deleteAdminSetting(
  adminUserId: string,
  lookup: SettingLookup,
  conn: Knex = db,
): Promise<SettingItem> {
  return conn.transaction(async (trx) => {
    const current = (await trx('settings')
      .where(settingWhereClause(lookup))
      .forUpdate()
      .first(...SETTING_COLUMNS)) as SettingDbRow | undefined;
    if (!current) {
      throw notFound('Setting not found.', { code: 'SETTING_NOT_FOUND' });
    }

    if (REQUIRED_SETTING_KEYS.has(current.key)) {
      throw conflict(`Required system setting "${current.key}" cannot be deleted.`, {
        code: 'SETTING_REQUIRED',
      });
    }

    await trx('settings').where({ id: current.id }).del();

    const deleted = mapSettingRow(current);
    await recordStaffAudit(trx, adminUserId, 'setting.delete', 'setting', deleted.id, {
      key: deleted.key,
      value: deleted.value,
      min_value: deleted.minValue,
      max_value: deleted.maxValue,
      description: deleted.description,
    });

    return deleted;
  });
}
