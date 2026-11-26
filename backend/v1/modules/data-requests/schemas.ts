import { badRequest } from '../../lib/http-error.js';
import { parseKeysetQuery, type KeysetQuery } from '../../lib/keyset.js';
import { asRecord, parseOptionalText, rejectUnknownFields } from '../../lib/validation.js';

export const REQUEST_TYPES = ['access', 'correction', 'export', 'deletion'] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

export const REQUEST_STATUSES = ['open', 'in_progress', 'completed', 'rejected'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const NOTE_MAX_LENGTH = 1000;
export const OUTCOME_MAX_LENGTH = 2000;
// shortcut: a fixed 7-day download window after completion (FR-PRV-002 sets none; OQ-15, OQ-24);
// move it to `settings` if legal review asks for another period.
export const EXPORT_WINDOW_DAYS = 7;

function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T | null {
  if (value === undefined) return null;
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  throw badRequest(`${name} must be one of: ${allowed.join(', ')}.`);
}

export interface CreateRequestInput {
  type: RequestType;
  note: string | null;
}

export function parseCreateRequestBody(raw: unknown): CreateRequestInput {
  const body = asRecord(raw);
  rejectUnknownFields(body, ['type', 'note']);
  const type = oneOf(body.type, REQUEST_TYPES, 'Field "type"');
  if (type === null) throw badRequest(`Field "type" is required: one of ${REQUEST_TYPES.join(', ')}.`);
  return { type, note: parseOptionalText(body.note, 'note', NOTE_MAX_LENGTH) ?? null };
}

/** `complete` and `reject` carry a mandatory outcome (FR-PRV-002: "request and outcome recorded"). */
export function parseOutcomeBody(raw: unknown): { outcome: string } {
  const body = raw === undefined ? {} : asRecord(raw);
  rejectUnknownFields(body, ['outcome']);
  const outcome = typeof body.outcome === 'string' ? body.outcome.trim() : '';
  if (outcome === '') throw badRequest('An outcome is required (FR-PRV-002).', { code: 'OUTCOME_REQUIRED' });
  if (outcome.length > OUTCOME_MAX_LENGTH) {
    throw badRequest(`Field "outcome" must be at most ${OUTCOME_MAX_LENGTH} characters.`);
  }
  return { outcome };
}

export type AdminListStatus = RequestStatus | 'all';

export interface AdminListQuery extends KeysetQuery {
  /** `null` is the default queue: open and in progress. */
  status: AdminListStatus | null;
  type: RequestType | null;
}

export function parseAdminListQuery(query: Record<string, unknown>): AdminListQuery {
  return {
    ...parseKeysetQuery(query),
    status: oneOf(query.status, [...REQUEST_STATUSES, 'all'] as const, 'Query "status"'),
    type: oneOf(query.type, REQUEST_TYPES, 'Query "type"'),
  };
}

export const parseOwnListQuery = (query: Record<string, unknown>): KeysetQuery => parseKeysetQuery(query);
