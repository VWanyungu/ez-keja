import type { Knex } from 'knex';
import db from '../../db/knex.js';
import { withTx } from '../../db/tx.js';
import { freshnessStats, makeCtx, percent, type FreshnessStats } from './service.js';
import { NO_FILTERS, type MetricFilters } from './schemas.js';

/**
 * Weekly metric snapshots (RPT-M02 "weekly snapshot", design §5.7). Point-in-time freshness cannot
 * be rebuilt later, so a weekly job stores it. Rows per week:
 *   RPT-M02  value = freshness percent, numerator = updated within the threshold, denominator = Vacant space types
 *   RPT-M03  value = median days since the last update
 *   RPT-M04  value = percent of Vacant space types in a Verified building (the lister-verified figure has no
 *            metric code of its own in `ck_snapshots_metric`, so only the building figure is stored)
 *   RPT-M09  value = users who logged in during the last 7 days (the table cannot hold a role dimension)
 * Slices: all, then each area, each category and each management type on its own (never crossed, so
 * the history is filterable by one of them, ASM-15). A slice with no Vacant space type writes no row.
 * `snapshot_date` is the Monday of the ISO week, in UTC.
 *
 * Idempotent and safe on two instances: a transaction advisory lock makes overlapping runs take
 * turns, and `ON CONFLICT DO NOTHING` on `ux_snapshots_key` means a week is written once.
 */

export interface SnapshotResult {
  snapshotDate: string;
  written: number;
  /** Rows that already existed for this week. */
  existing: number;
}

export function isoWeekStart(now: Date): string {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

interface Slice {
  areaId: string | null;
  categoryId: string | null;
  managementType: 'agent' | 'landlord' | null;
}

type Row = [metric: string, slice: Slice, numerator: number | null, denominator: number | null, value: number];

function rowsFor(slice: Slice, s: FreshnessStats, overall: boolean): Row[] {
  if (s.total === 0 && !overall) return [];
  const rows: Row[] = [
    ['RPT-M02', slice, s.fresh, s.total, percent(s.fresh, s.total) ?? 0],
    ['RPT-M04', slice, s.inVerifiedBuilding, s.total, percent(s.inVerifiedBuilding, s.total) ?? 0],
  ];
  if (s.medianDays !== null) rows.push(['RPT-M03', slice, null, null, Math.round(s.medianDays * 100) / 100]);
  return rows;
}

const asFilters = (slice: Slice): MetricFilters => ({ ...NO_FILTERS, ...slice });
const NIL_UUID = "'00000000-0000-0000-0000-000000000000'::uuid";

export async function snapshotMetrics(options: { now?: Date; conn?: Knex } = {}): Promise<SnapshotResult> {
  const now = options.now ?? new Date();
  const snapshotDate = isoWeekStart(now);
  return withTx(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`snapshot-metrics:${snapshotDate}`]);

    const dims = {
      areas: (await trx('buildings as b')
        .join('space_types as st', 'st.building_id', 'b.id')
        .where('b.status', 'published').whereNull('st.removed_at').where('st.vacant_count', '>', 0)
        .distinct('b.area_id').orderBy('b.area_id').pluck('b.area_id')) as string[],
      categories: (await trx('buildings as b')
        .join('space_types as st', 'st.building_id', 'b.id')
        .where('b.status', 'published').whereNull('st.removed_at').where('st.vacant_count', '>', 0)
        .distinct('st.category_id').orderBy('st.category_id').pluck('st.category_id')) as string[],
    };
    const slices: Slice[] = [
      { areaId: null, categoryId: null, managementType: null },
      ...dims.areas.map((areaId) => ({ areaId, categoryId: null, managementType: null })),
      ...dims.categories.map((categoryId) => ({ areaId: null, categoryId, managementType: null })),
      ...(['agent', 'landlord'] as const).map((managementType) => ({ areaId: null, categoryId: null, managementType })),
    ];

    const rows: Row[] = [];
    for (const [i, slice] of slices.entries()) {
      const stats = await freshnessStats(makeCtx(trx, asFilters(slice), { now }));
      rows.push(...rowsFor(slice, stats, i === 0));
    }

    const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    const users = (await trx('profiles')
      .whereNull('erased_at')
      .first(
        trx.raw('count(*)::int AS total'),
        trx.raw('count(*) FILTER (WHERE last_login_at > ? AND last_login_at <= ?)::int AS active', [weekAgo, now.toISOString()]),
      )) as { total: number; active: number };
    rows.push(['RPT-M09', slices[0]!, users.active, users.total, users.active]);

    const written = (
      (await trx.raw(
        `INSERT INTO metric_snapshots (snapshot_date, metric_code, area_id, category_id, management_type, numerator, denominator, value)
         VALUES ${rows.map(() => '(?::date, ?, ?::uuid, ?::uuid, ?, ?, ?, ?)').join(', ')}
         ON CONFLICT (snapshot_date, metric_code, COALESCE(area_id, ${NIL_UUID}), COALESCE(category_id, ${NIL_UUID}), COALESCE(management_type, ''))
         DO NOTHING RETURNING id`,
        rows.flatMap(([metric, s, num, den, value]) => [snapshotDate, metric, s.areaId, s.categoryId, s.managementType, num, den, value]),
      )) as { rows: unknown[] }
    ).rows.length;
    return { snapshotDate, written, existing: rows.length - written };
  }, options.conn ?? db);
}
