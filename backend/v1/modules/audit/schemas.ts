import { badRequest } from '../../lib/http-error.js';
import { parseDateRange } from '../../lib/date-range.js';
import { parseKeysetQuery, type KeysetQuery } from '../../lib/keyset.js';
import { isUuid } from '../../lib/uuid.js';

export interface AuditFilters {
  userId: string | null;
  buildingId: string | null;
  action: string | null;
  from: Date | null;
  /** Exclusive: a plain `to` date has already been moved to the start of the next day. */
  toExclusive: Date | null;
}

export interface AuditQuery extends KeysetQuery {
  filters: AuditFilters;
  format: 'json' | 'csv';
}

const ACTION = /^[a-z0-9_.]{1,100}$/i;

function uuidParam(value: unknown, name: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !isUuid(value)) throw badRequest(`Query "${name}" must be a valid UUID.`);
  return value;
}

/** FR-ADM-007: `userId`, `buildingId`, `from`, `to` (and an exact `action`); `format=csv` exports (FR-RPT-002). */
export function parseAuditQuery(query: Record<string, unknown>): AuditQuery {
  if (query.action !== undefined && (typeof query.action !== 'string' || !ACTION.test(query.action))) {
    throw badRequest('Query "action" must be an action name such as "user.suspend".');
  }
  if (query.format !== undefined && query.format !== 'json' && query.format !== 'csv') {
    throw badRequest('Query "format" must be "json" or "csv".');
  }
  const { from, toExclusive } = parseDateRange(query);
  return {
    ...parseKeysetQuery(query, 50, 200),
    format: query.format === 'csv' ? 'csv' : 'json',
    filters: {
      userId: uuidParam(query.userId, 'userId'),
      buildingId: uuidParam(query.buildingId, 'buildingId'),
      action: typeof query.action === 'string' ? query.action : null,
      from,
      toExclusive,
    },
  };
}
