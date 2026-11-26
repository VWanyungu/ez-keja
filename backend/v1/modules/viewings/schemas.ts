import { badRequest } from '../../lib/http-error.js';
import { parseKeysetQuery, type KeysetQuery } from '../../lib/keyset.js';
import { asRecord, rejectUnknownFields } from '../../lib/validation.js';

export const VIEWING_STATUSES = ['requested', 'accepted', 'declined', 'counter_proposed', 'cancelled'] as const;
export type ViewingStatus = (typeof VIEWING_STATUSES)[number];

/** A request for a time further out than this is almost certainly a typo, so it is refused. */
export const MAX_DAYS_AHEAD = 365;

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

/** A future instant, written with an explicit zone ("2026-12-01T10:00:00+03:00"); returned as an ISO string. */
export function parseFutureTime(value: unknown, fieldName: string, now: () => number = Date.now): string {
  if (typeof value !== 'string' || !ISO_WITH_ZONE.test(value)) {
    throw badRequest(`Field "${fieldName}" must be an ISO-8601 date and time with a time zone, e.g. 2026-12-01T10:00:00+03:00.`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw badRequest(`Field "${fieldName}" is not a valid date and time.`);
  if (ms <= now()) throw badRequest(`Field "${fieldName}" must be in the future.`, { code: 'VIEWING_TIME_IN_PAST' });
  if (ms > now() + MAX_DAYS_AHEAD * 86_400_000) {
    throw badRequest(`Field "${fieldName}" must be within ${MAX_DAYS_AHEAD} days from now.`);
  }
  return new Date(ms).toISOString();
}

export function parseRequestViewingBody(raw: unknown, now?: () => number): { requestedFor: string } {
  const obj = asRecord(raw);
  rejectUnknownFields(obj, ['requestedFor']);
  return { requestedFor: parseFutureTime(obj.requestedFor, 'requestedFor', now) };
}

export function parseCounterBody(raw: unknown, now?: () => number): { proposedFor: string } {
  const obj = asRecord(raw);
  rejectUnknownFields(obj, ['proposedFor']);
  return { proposedFor: parseFutureTime(obj.proposedFor, 'proposedFor', now) };
}

export interface ListViewingsQuery extends KeysetQuery {
  status: ViewingStatus | null;
  as: 'client' | 'maintainer' | null;
}

export function parseListViewingsQuery(query: Record<string, unknown>): ListViewingsQuery {
  let status: ViewingStatus | null = null;
  if (query.status !== undefined) {
    if (typeof query.status !== 'string' || !(VIEWING_STATUSES as readonly string[]).includes(query.status)) {
      throw badRequest(`Query "status" must be one of: ${VIEWING_STATUSES.join(', ')}.`);
    }
    status = query.status as ViewingStatus;
  }
  let as: ListViewingsQuery['as'] = null;
  if (query.as !== undefined) {
    if (query.as !== 'client' && query.as !== 'maintainer') throw badRequest('Query "as" must be "client" or "maintainer".');
    as = query.as;
  }
  return { ...parseKeysetQuery(query), status, as };
}
