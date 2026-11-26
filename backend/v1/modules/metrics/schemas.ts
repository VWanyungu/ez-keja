import { parseDateRange } from '../../lib/date-range.js';
import { badRequest } from '../../lib/http-error.js';
import { isUuid } from '../../lib/uuid.js';

/** SRS §10.3. RPT-M11 is withdrawn (D-26); RPT-M12 and M13 (advertising) are on hold. */
export const METRIC_CODES = [
  'RPT-M01', 'RPT-M02', 'RPT-M03', 'RPT-M04', 'RPT-M05',
  'RPT-M06', 'RPT-M07', 'RPT-M08', 'RPT-M09', 'RPT-M10',
] as const;
export type MetricCode = (typeof METRIC_CODES)[number];

export const FILTER_NAMES = ['areaId', 'categoryId', 'managementType', 'listerId', 'dateRange'] as const;
export type FilterName = (typeof FILTER_NAMES)[number];

export interface MetricFilters {
  areaId: string | null;
  categoryId: string | null;
  managementType: 'agent' | 'landlord' | null;
  listerId: string | null;
  from: Date | null;
  /** Exclusive end; a plain `to` date has already been moved to the start of the next day. */
  toExclusive: Date | null;
}

export const NO_FILTERS: MetricFilters = {
  areaId: null, categoryId: null, managementType: null, listerId: null, from: null, toExclusive: null,
};

function uuidParam(value: unknown, name: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !isUuid(value)) throw badRequest(`Query "${name}" must be a valid UUID.`);
  return value;
}

/** FR-RPT-001 filters: area, space-type category, management type, lister and date range. */
export function parseMetricFilters(query: Record<string, unknown>): MetricFilters {
  if (query.managementType !== undefined && query.managementType !== 'agent' && query.managementType !== 'landlord') {
    throw badRequest('Query "managementType" must be "agent" or "landlord".');
  }
  const { from, toExclusive } = parseDateRange(query);
  return {
    areaId: uuidParam(query.areaId, 'areaId'),
    categoryId: uuidParam(query.categoryId, 'categoryId'),
    managementType: (query.managementType as 'agent' | 'landlord' | undefined) ?? null,
    listerId: uuidParam(query.listerId, 'listerId'),
    from,
    toExclusive,
  };
}

/** `metric=RPT-M06` (also `M06` or `rpt-m06`). */
export function parseExportQuery(query: Record<string, unknown>): { metric: MetricCode; filters: MetricFilters } {
  const raw = typeof query.metric === 'string' ? query.metric.trim().toUpperCase() : '';
  const code = (raw.startsWith('RPT-') ? raw : `RPT-${raw}`) as MetricCode;
  if (!(METRIC_CODES as readonly string[]).includes(code)) {
    throw badRequest(`Query "metric" must be one of: ${METRIC_CODES.join(', ')}.`, { code: 'UNKNOWN_METRIC' });
  }
  return { metric: code, filters: parseMetricFilters(query) };
}
