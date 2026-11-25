import { badRequest } from './http-error.js';
import { isUuid } from './uuid.js';

/**
 * Keyset pagination over `(created_at DESC, id DESC)` (design §7.4). The timestamp travels as
 * `created_at::text`, never as a JavaScript Date, because a Date drops microseconds and the next
 * page could then skip rows written in the same millisecond. Never use OFFSET.
 */
export interface KeysetCursor {
  /** `created_at::text` exactly as PostgreSQL printed it. */
  t: string;
  id: string;
}

const TIMESTAMP_TEXT = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

export const isTimestampText = (value: string): boolean => TIMESTAMP_TEXT.test(value);

export const encodeCursor = (cursor: KeysetCursor): string =>
  Buffer.from(JSON.stringify(cursor)).toString('base64url');

export function decodeCursor(value: string): KeysetCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<KeysetCursor>;
    if (typeof parsed.t === 'string' && isTimestampText(parsed.t) && typeof parsed.id === 'string' && isUuid(parsed.id)) {
      return { t: parsed.t, id: parsed.id };
    }
  } catch {
    // fall through to the 400 below
  }
  throw badRequest('Query "cursor" is not valid. Use the "nextCursor" of the previous page.');
}

export interface KeysetQuery {
  limit: number;
  cursor: KeysetCursor | null;
}

export function parseKeysetQuery(
  query: { limit?: unknown; cursor?: unknown },
  defaultLimit = 25,
  maxLimit = 100,
): KeysetQuery {
  let limit = defaultLimit;
  if (query.limit !== undefined) {
    const n = typeof query.limit === 'string' && /^\d+$/.test(query.limit) ? Number(query.limit) : Number.NaN;
    if (!Number.isInteger(n) || n < 1 || n > maxLimit) {
      throw badRequest(`Query "limit" must be a whole number from 1 to ${maxLimit}.`);
    }
    limit = n;
  }
  let cursor: KeysetCursor | null = null;
  if (query.cursor !== undefined) {
    if (typeof query.cursor !== 'string' || query.cursor === '') {
      throw badRequest('Query "cursor" is not valid. Use the "nextCursor" of the previous page.');
    }
    cursor = decodeCursor(query.cursor);
  }
  return { limit, cursor };
}
