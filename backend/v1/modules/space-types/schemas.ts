import { badRequest } from '../../lib/http-error.js';
import {
  asRecord,
  parseAmount,
  parseOptionalText,
  parseRequiredUuid,
  parseText,
  parseVersion,
  parseWholeNumber,
  rejectUnknownFields,
} from '../../lib/validation.js';

export const RENT_MODES = ['fixed', 'on_interest'] as const;
export type RentMode = (typeof RENT_MODES)[number];

const MAX_MONEY = 999_999_999_999.99; // numeric(14,2)
const MAX_SIZE_SQM = 999_999.99; // numeric(8,2)
const MAX_VACANT_COUNT = 1_000_000;

function parseRentMode(value: unknown): RentMode {
  if (typeof value === 'string' && (RENT_MODES as readonly string[]).includes(value)) {
    return value as RentMode;
  }
  throw badRequest('Field "rentMode" must be "fixed" or "on_interest".');
}

const parseRent = (value: unknown) => parseAmount(value, 'rentAmount', { allowZero: false, max: MAX_MONEY });
const parseDeposit = (value: unknown) => parseAmount(value, 'depositAmount', { allowZero: true, max: MAX_MONEY });
const parseSize = (value: unknown) => parseAmount(value, 'sizeSqm', { allowZero: false, max: MAX_SIZE_SQM });

/**
 * BR-013 / FR-UNT-004: a space type has one rent mode. `fixed` needs a positive amount and
 * `on_interest` has none. Mirrors `ck_space_types_rent`, so the caller gets a message, not a 500.
 * `patch.rentAmount` is `undefined` when not sent and `null` when explicitly cleared.
 */
export function resolveRent(
  current: { rentMode: RentMode; rentAmount: number | null },
  patch: { rentMode?: RentMode | undefined; rentAmount?: number | null | undefined },
): { rentMode: RentMode; rentAmount: number | null } {
  const rentMode = patch.rentMode ?? current.rentMode;
  if (rentMode === 'on_interest') {
    if (patch.rentAmount !== undefined && patch.rentAmount !== null) {
      throw badRequest('A space type with rent on interest has no "rentAmount".', { code: 'RENT_INVALID' });
    }
    return { rentMode, rentAmount: null };
  }
  const rentAmount = patch.rentAmount === undefined ? current.rentAmount : patch.rentAmount;
  if (rentAmount === null) {
    throw badRequest('A space type with a fixed rent needs "rentAmount" above zero.', { code: 'RENT_INVALID' });
  }
  return { rentMode, rentAmount };
}

export interface CreateSpaceTypeInput {
  name: string;
  categoryId: string;
  rentMode: RentMode;
  rentAmount: number | null;
  currencyId: string;
  depositAmount: number;
  sizeSqm: number | null;
  vacantCount: number;
}

const CREATE_FIELDS = [
  'name', 'categoryId', 'rentMode', 'rentAmount', 'currencyId', 'depositAmount', 'sizeSqm', 'vacantCount',
] as const;

export function parseCreateSpaceTypeBody(raw: unknown): CreateSpaceTypeInput {
  const obj = asRecord(raw);
  rejectUnknownFields(obj, CREATE_FIELDS);
  const rentMode = parseRentMode(obj.rentMode);
  const rentAmount = obj.rentAmount === undefined || obj.rentAmount === null ? null : parseRent(obj.rentAmount);
  const rent = resolveRent({ rentMode, rentAmount: null }, { rentAmount });
  return {
    name: parseText(obj.name, 'name', 1, 100),
    categoryId: parseRequiredUuid(obj.categoryId, 'categoryId'),
    rentMode: rent.rentMode,
    rentAmount: rent.rentAmount,
    currencyId: parseRequiredUuid(obj.currencyId, 'currencyId'),
    depositAmount: parseDeposit(obj.depositAmount),
    sizeSqm: obj.sizeSqm === undefined || obj.sizeSqm === null ? null : parseSize(obj.sizeSqm),
    vacantCount: parseWholeNumber(obj.vacantCount, 'vacantCount', 0, MAX_VACANT_COUNT),
  };
}

export interface PatchSpaceTypeInput {
  version: number;
  name?: string;
  categoryId?: string;
  rentMode?: RentMode;
  rentAmount?: number | null;
  currencyId?: string;
  depositAmount?: number;
  sizeSqm?: number | null;
}

export function parsePatchSpaceTypeBody(raw: unknown): PatchSpaceTypeInput {
  const obj = asRecord(raw);
  if (obj.vacantCount !== undefined) {
    throw badRequest('The vacant count is not changed by editing a space type.', { code: 'COUNT_NOT_EDITABLE' });
  }
  rejectUnknownFields(obj, ['version', ...CREATE_FIELDS]);
  const patch: PatchSpaceTypeInput = { version: parseVersion(obj.version) };

  if (obj.name !== undefined) patch.name = parseText(obj.name, 'name', 1, 100);
  if (obj.categoryId !== undefined) patch.categoryId = parseRequiredUuid(obj.categoryId, 'categoryId');
  if (obj.rentMode !== undefined) patch.rentMode = parseRentMode(obj.rentMode);
  if (obj.rentAmount !== undefined) patch.rentAmount = obj.rentAmount === null ? null : parseRent(obj.rentAmount);
  if (obj.currencyId !== undefined) patch.currencyId = parseRequiredUuid(obj.currencyId, 'currencyId');
  if (obj.depositAmount !== undefined) patch.depositAmount = parseDeposit(obj.depositAmount);
  if (obj.sizeSqm !== undefined) patch.sizeSqm = obj.sizeSqm === null ? null : parseSize(obj.sizeSqm);

  if (Object.keys(patch).length === 1) throw badRequest('Provide at least one field to change.');
  return patch;
}

export interface RestoreSpaceTypeInput {
  vacantCount: number;
  /** A new name, needed when a live space type has taken the old one (TX-14). */
  name: string | null;
}

export function parseRestoreSpaceTypeBody(raw: unknown): RestoreSpaceTypeInput {
  const obj = asRecord(raw);
  rejectUnknownFields(obj, ['vacantCount', 'name']);
  const name = parseOptionalText(obj.name, 'name', 100);
  if (name !== undefined && name !== null && name.length < 1) throw badRequest('Field "name" cannot be empty.');
  return {
    vacantCount: parseWholeNumber(obj.vacantCount, 'vacantCount', 0, MAX_VACANT_COUNT),
    name: name ?? null,
  };
}

export function parseIncludeRemoved(value: unknown): boolean {
  if (value === undefined) return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw badRequest('Query "includeRemoved" must be "true" or "false".');
}
