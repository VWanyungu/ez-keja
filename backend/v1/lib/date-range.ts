import { badRequest } from './http-error.js';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/;
const DAY_MS = 86_400_000;

function parseBound(value: unknown, name: string): { date: Date; dateOnly: boolean } {
  const message = `Query "${name}" must be a date (YYYY-MM-DD, UTC) or an ISO-8601 timestamp with a time zone.`;
  if (typeof value !== 'string') throw badRequest(message);
  const dateOnly = DATE_ONLY.test(value);
  if (!dateOnly && !TIMESTAMP.test(value)) throw badRequest(message);
  const ms = Date.parse(dateOnly ? `${value}T00:00:00Z` : value);
  // Date.parse rolls 2026-02-31 over to March: reject it by round-tripping a plain date.
  if (!Number.isFinite(ms) || (dateOnly && new Date(ms).toISOString().slice(0, 10) !== value)) throw badRequest(message);
  return { date: new Date(ms), dateOnly };
}

export interface DateRange {
  /** Inclusive start, or null for "from the beginning". */
  from: Date | null;
  /** Exclusive end, or null for "until now". A plain `to` date includes that whole UTC day. */
  toExclusive: Date | null;
}

/** `from` and `to` as `YYYY-MM-DD` (UTC days) or ISO timestamps; `to` is inclusive. */
export function parseDateRange(query: { from?: unknown; to?: unknown }): DateRange {
  const from = query.from === undefined ? null : parseBound(query.from, 'from').date;
  let toExclusive: Date | null = null;
  if (query.to !== undefined) {
    const to = parseBound(query.to, 'to');
    toExclusive = new Date(to.date.getTime() + (to.dateOnly ? DAY_MS : 1));
  }
  if (from && toExclusive && from.getTime() >= toExclusive.getTime()) {
    throw badRequest('Query "from" must not be after "to".');
  }
  return { from, toExclusive };
}
