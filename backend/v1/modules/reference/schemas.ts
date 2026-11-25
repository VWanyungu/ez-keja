import { badRequest } from '../../lib/http-error.js';
import { isUuid } from '../../lib/uuid.js';
import { asRecord, rejectUnknownFields } from '../../lib/validation.js';

export const AREA_SLUG_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const CURRENCY_CODE_REGEX = /^[A-Z]{3}$/;
export const SETTING_KEY_REGEX = /^[a-z][a-z0-9_]{0,99}$/;
export const SPACE_CATEGORY_KINDS = ['residential', 'commercial'] as const;

export const PG_SMALLINT_MIN = -32768;
export const PG_SMALLINT_MAX = 32767;
export const PG_INT_MIN = -2147483648;
export const PG_INT_MAX = 2147483647;

export type SpaceCategoryKind = (typeof SPACE_CATEGORY_KINDS)[number];

export interface PublicCategoriesQuery {
  kind?: SpaceCategoryKind;
}

export interface AdminActiveFilter {
  isActive?: boolean;
}

export interface CreateAreaInput {
  name: string;
  slug: string;
  centreLat: number;
  centreLng: number;
  isActive: boolean;
}

export interface UpdateAreaInput {
  name?: string;
  slug?: string;
  centreLat?: number;
  centreLng?: number;
  isActive?: boolean;
}

export interface CreateCurrencyInput {
  code: string;
  name: string;
  isActive: boolean;
  sortOrder: number;
}

export interface UpdateCurrencyInput {
  code?: string;
  name?: string;
  isActive?: boolean;
  sortOrder?: number;
}

export interface CreateSettingInput {
  key: string;
  value: number;
  minValue: number;
  maxValue: number | null;
  description: string;
}

export interface UpdateSettingInput {
  value?: number;
  description?: string;
}

export interface SettingLookup {
  kind: 'id' | 'key';
  value: string;
}

const AREA_FIELDS = ['name', 'slug', 'centreLat', 'centreLng', 'isActive'] as const;
const CURRENCY_FIELDS = ['code', 'name', 'isActive', 'sortOrder'] as const;
const CREATE_SETTING_FIELDS = ['key', 'value', 'minValue', 'maxValue', 'description'] as const;
const UPDATE_SETTING_FIELDS = ['value', 'description'] as const;

function parseTrimmedString(
  value: unknown,
  fieldName: string,
  minLen: number,
  maxLen: number,
): string {
  if (typeof value !== 'string') {
    throw badRequest(`Field "${fieldName}" must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length < minLen || trimmed.length > maxLen) {
    throw badRequest(`Field "${fieldName}" must be between ${minLen} and ${maxLen} characters.`);
  }
  return trimmed;
}

function parseBooleanField(value: unknown, fieldName: string): boolean {
  if (typeof value !== 'boolean') {
    throw badRequest(`Field "${fieldName}" must be a boolean.`);
  }
  return value;
}

function parseFiniteNumberInRange(
  value: unknown,
  fieldName: string,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw badRequest(`Field "${fieldName}" must be a finite number.`);
  }
  if (value < min || value > max) {
    throw badRequest(`Field "${fieldName}" must be between ${min} and ${max}.`);
  }
  return value;
}

function parseIntegerInRange(
  value: unknown,
  fieldName: string,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw badRequest(`Field "${fieldName}" must be a whole number.`);
  }
  if (value < min || value > max) {
    throw badRequest(`Field "${fieldName}" must be between ${min} and ${max}.`);
  }
  return value;
}

export function slugifyAreaName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parseAreaSlug(value: unknown): string {
  const trimmed = parseTrimmedString(value, 'slug', 1, 100);
  if (!AREA_SLUG_REGEX.test(trimmed)) {
    throw badRequest(
      'Field "slug" must contain only lowercase letters, numbers, and single hyphens.',
    );
  }
  return trimmed;
}

function parseCurrencyCode(value: unknown): string {
  if (typeof value !== 'string') {
    throw badRequest('Field "code" must be a 3-letter ISO currency code.');
  }
  const normalized = value.trim().toUpperCase();
  if (!CURRENCY_CODE_REGEX.test(normalized)) {
    throw badRequest('Field "code" must be a 3-letter uppercase ISO currency code (e.g. KES).');
  }
  return normalized;
}

function parseSettingKey(value: unknown): string {
  if (typeof value !== 'string') {
    throw badRequest('Field "key" must be a string.');
  }
  const trimmed = value.trim();
  if (!SETTING_KEY_REGEX.test(trimmed)) {
    throw badRequest(
      'Field "key" must start with a lowercase letter and contain only lowercase letters, numbers, and underscores.',
    );
  }
  return trimmed;
}

export function validateSettingValueInRange(
  key: string,
  value: number,
  minValue: number,
  maxValue: number | null,
): void {
  if (value < minValue || (maxValue !== null && value > maxValue)) {
    const message =
      maxValue !== null
        ? `Value for setting "${key}" must be between ${minValue} and ${maxValue}.`
        : `Value for setting "${key}" must be at least ${minValue}.`;

    throw badRequest(message, {
      code: 'SETTING_OUT_OF_RANGE',
      data: { key, value, minValue, maxValue },
    });
  }
}

export function parseReferenceIdParam(id: string | undefined, resourceName = 'resource'): string {
  if (!id || !isUuid(id)) {
    throw badRequest(`Invalid ${resourceName} id.`);
  }
  return id;
}

export function parseSettingLookupParam(param: string | undefined): SettingLookup {
  if (!param) {
    throw badRequest('Invalid setting id or key.');
  }
  if (isUuid(param)) {
    return { kind: 'id', value: param };
  }
  if (SETTING_KEY_REGEX.test(param)) {
    return { kind: 'key', value: param };
  }
  throw badRequest('Invalid setting id or key.');
}

export function parsePublicCategoriesQuery(
  rawQuery: Record<string, unknown>,
): PublicCategoriesQuery {
  const rawKind = rawQuery.kind;
  if (rawKind === undefined || rawKind === '') {
    return {};
  }
  if (rawKind === 'residential' || rawKind === 'commercial') {
    return { kind: rawKind };
  }
  throw badRequest('Invalid kind parameter. Expected "residential" or "commercial".');
}

export function parseAdminActiveFilterQuery(rawQuery: Record<string, unknown>): AdminActiveFilter {
  const rawActive = rawQuery.isActive;
  if (rawActive === undefined || rawActive === '') {
    return {};
  }
  if (rawActive === 'true') {
    return { isActive: true };
  }
  if (rawActive === 'false') {
    return { isActive: false };
  }
  throw badRequest('Invalid isActive parameter. Expected "true" or "false".');
}

export function parseCreateAreaBody(raw: unknown): CreateAreaInput {
  const obj = asRecord(raw);
  rejectUnknownFields(obj, AREA_FIELDS);

  const name = parseTrimmedString(obj.name, 'name', 1, 100);

  let slug: string;
  if (obj.slug !== undefined) {
    slug = parseAreaSlug(obj.slug);
  } else {
    slug = slugifyAreaName(name);
    if (!slug || slug.length > 100 || !AREA_SLUG_REGEX.test(slug)) {
      throw badRequest(
        'Could not derive a valid slug from "name". Provide a lowercase hyphenated "slug".',
      );
    }
  }

  const centreLat = parseFiniteNumberInRange(obj.centreLat, 'centreLat', -90, 90);
  const centreLng = parseFiniteNumberInRange(obj.centreLng, 'centreLng', -180, 180);
  const isActive =
    obj.isActive === undefined ? true : parseBooleanField(obj.isActive, 'isActive');

  return { name, slug, centreLat, centreLng, isActive };
}

export function parseUpdateAreaBody(raw: unknown): UpdateAreaInput {
  const obj = asRecord(raw);
  rejectUnknownFields(obj, AREA_FIELDS);

  const patch: UpdateAreaInput = {};

  if ('name' in obj) {
    patch.name = parseTrimmedString(obj.name, 'name', 1, 100);
  }
  if ('slug' in obj) {
    patch.slug = parseAreaSlug(obj.slug);
  }
  if ('centreLat' in obj) {
    patch.centreLat = parseFiniteNumberInRange(obj.centreLat, 'centreLat', -90, 90);
  }
  if ('centreLng' in obj) {
    patch.centreLng = parseFiniteNumberInRange(obj.centreLng, 'centreLng', -180, 180);
  }
  if ('isActive' in obj) {
    patch.isActive = parseBooleanField(obj.isActive, 'isActive');
  }

  if (Object.keys(patch).length === 0) {
    throw badRequest('At least one area field must be provided.');
  }

  return patch;
}

export function parseCreateCurrencyBody(raw: unknown): CreateCurrencyInput {
  const obj = asRecord(raw);
  rejectUnknownFields(obj, CURRENCY_FIELDS);

  const code = parseCurrencyCode(obj.code);
  const name = parseTrimmedString(obj.name, 'name', 1, 100);
  const isActive =
    obj.isActive === undefined ? true : parseBooleanField(obj.isActive, 'isActive');
  const sortOrder =
    obj.sortOrder === undefined
      ? 0
      : parseIntegerInRange(obj.sortOrder, 'sortOrder', PG_SMALLINT_MIN, PG_SMALLINT_MAX);

  return { code, name, isActive, sortOrder };
}

export function parseUpdateCurrencyBody(raw: unknown): UpdateCurrencyInput {
  const obj = asRecord(raw);
  rejectUnknownFields(obj, CURRENCY_FIELDS);

  const patch: UpdateCurrencyInput = {};

  if ('code' in obj) {
    patch.code = parseCurrencyCode(obj.code);
  }
  if ('name' in obj) {
    patch.name = parseTrimmedString(obj.name, 'name', 1, 100);
  }
  if ('isActive' in obj) {
    patch.isActive = parseBooleanField(obj.isActive, 'isActive');
  }
  if ('sortOrder' in obj) {
    patch.sortOrder = parseIntegerInRange(
      obj.sortOrder,
      'sortOrder',
      PG_SMALLINT_MIN,
      PG_SMALLINT_MAX,
    );
  }

  if (Object.keys(patch).length === 0) {
    throw badRequest('At least one currency field must be provided.');
  }

  return patch;
}

export function parseCreateSettingBody(raw: unknown): CreateSettingInput {
  const obj = asRecord(raw);
  rejectUnknownFields(obj, CREATE_SETTING_FIELDS);

  const key = parseSettingKey(obj.key);
  const minValue =
    obj.minValue === undefined
      ? 1
      : parseIntegerInRange(obj.minValue, 'minValue', PG_INT_MIN, PG_INT_MAX);

  let maxValue: number | null = null;
  if (obj.maxValue !== undefined && obj.maxValue !== null) {
    maxValue = parseIntegerInRange(obj.maxValue, 'maxValue', PG_INT_MIN, PG_INT_MAX);
    if (maxValue < minValue) {
      throw badRequest('Field "maxValue" must be greater than or equal to "minValue".');
    }
  }

  const value = parseIntegerInRange(obj.value, 'value', PG_INT_MIN, PG_INT_MAX);
  validateSettingValueInRange(key, value, minValue, maxValue);

  const description = parseTrimmedString(obj.description, 'description', 1, 500);

  return { key, value, minValue, maxValue, description };
}

export function parseUpdateSettingBody(raw: unknown): UpdateSettingInput {
  const obj = asRecord(raw);
  rejectUnknownFields(obj, UPDATE_SETTING_FIELDS);

  const patch: UpdateSettingInput = {};

  if ('value' in obj) {
    patch.value = parseIntegerInRange(obj.value, 'value', PG_INT_MIN, PG_INT_MAX);
  }
  if ('description' in obj) {
    patch.description = parseTrimmedString(obj.description, 'description', 1, 500);
  }

  if (Object.keys(patch).length === 0) {
    throw badRequest('At least one setting field must be provided.');
  }

  return patch;
}
