import { badRequest } from '../../lib/http-error.js';
import { isTimestampText } from '../../lib/keyset.js';
import { asRecord, parseRequiredUuid, parseWholeNumber, rejectUnknownFields } from '../../lib/validation.js';
import { MAX_VACANT_COUNT } from '../space-types/schemas.js';

/** FR-AVL-001 / BR-028: a whole number, zero or more. */
export const parseVacantCount = (value: unknown, min = 0): number =>
  parseWholeNumber(value, 'vacantCount', min, MAX_VACANT_COUNT);

export interface SetCountInput {
  vacantCount: number;
}

export function parseSetCountBody(raw: unknown): SetCountInput {
  const obj = asRecord(raw);
  rejectUnknownFields(obj, ['vacantCount']);
  return { vacantCount: parseVacantCount(obj.vacantCount) };
}

export interface ConfirmInput {
  /** The stepper value (FR-AVL-003); absent means "Still N vacant" with the count unchanged. */
  vacantCount?: number;
}

export function parseConfirmBody(raw: unknown): ConfirmInput {
  if (raw === undefined || raw === null) return {};
  const obj = asRecord(raw);
  rejectUnknownFields(obj, ['vacantCount']);
  return obj.vacantCount === undefined ? {} : { vacantCount: parseVacantCount(obj.vacantCount) };
}

export interface BulkConfirmItem {
  spaceTypeId: string;
  /** Text, so microseconds survive (design §7.4); compared for equality in SQL. */
  lastConfirmedAt: string;
  vacantCount: number;
}

export const MAX_BULK_ITEMS = 200;

export function parseBulkConfirmBody(raw: unknown): { items: BulkConfirmItem[] } {
  const obj = asRecord(raw);
  rejectUnknownFields(obj, ['items']);
  if (!Array.isArray(obj.items) || obj.items.length < 1 || obj.items.length > MAX_BULK_ITEMS) {
    throw badRequest(`Field "items" must list 1 to ${MAX_BULK_ITEMS} space types.`);
  }
  const seen = new Set<string>();
  const items = obj.items.map((entry: unknown, index) => {
    const item = asRecord(entry);
    rejectUnknownFields(item, ['spaceTypeId', 'lastConfirmedAt', 'vacantCount']);
    const spaceTypeId = parseRequiredUuid(item.spaceTypeId, `items[${index}].spaceTypeId`);
    if (seen.has(spaceTypeId)) throw badRequest(`Space type ${spaceTypeId} is listed twice.`);
    seen.add(spaceTypeId);
    if (typeof item.lastConfirmedAt !== 'string' || !isTimestampText(item.lastConfirmedAt)) {
      throw badRequest(`Field "items[${index}].lastConfirmedAt" must be the timestamp text you were shown.`);
    }
    // FR-AVL-004: Fully let space types are not part of a bulk confirmation.
    const vacantCount = parseWholeNumber(item.vacantCount, `items[${index}].vacantCount`, 1, MAX_VACANT_COUNT);
    return { spaceTypeId, lastConfirmedAt: item.lastConfirmedAt, vacantCount };
  });
  return { items };
}
