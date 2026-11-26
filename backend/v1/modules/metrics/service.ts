import type { Knex } from 'knex';
import db from '../../db/knex.js';
import { withTx } from '../../db/tx.js';
import { writeAudit } from '../../lib/audit.js';
import { toCsv } from '../../lib/csv.js';
import { outdatedSql } from '../../lib/freshness.js';
import type { AuthContext } from '../../middlewares/auth.js';
import { FILTER_NAMES, METRIC_CODES, type FilterName, type MetricCode, type MetricFilters } from './schemas.js';

/**
 * Admin metrics (FR-RPT-001, SRS §10.3). Everything here counts Vacant space types of PUBLISHED
 * buildings only (review R-17: Draft, Withdrawn and Suspended buildings are ignored), and takes
 * every freshness number from `lib/freshness.ts` so BR-001 is decided in one place.
 *
 * Point-in-time metrics (M01 to M05) describe "now" and ignore the date range: history exists only
 * as the weekly snapshots (RPT-M02 weekly snapshot, `snapshots.ts`). Period metrics (M06 to M10)
 * use `from`/`to`, defaulting to the start of the current UTC month up to now. Each metric lists the
 * filters it honours in the response `meta` (ASM-15); a filter it cannot honour is named as ignored,
 * never silently half-applied. A filter with no data gives zeros and nulls, not an error.
 */

type Conn = Knex | Knex.Transaction;

export interface Ctx {
  conn: Conn;
  f: MetricFilters;
  /** Trusted SQL for "now": the statement clock, or a fixed literal when a job injects `now`. */
  asOfSql: string;
  asOf: Date;
  period: { from: Date; to: Date };
}

export interface MetricsOptions {
  /** Injected by the snapshot job and tests; the live dashboard uses the database clock. */
  now?: Date;
}

export const startOfUtcMonth = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

export function makeCtx(conn: Conn, f: MetricFilters, opts: MetricsOptions = {}): Ctx {
  const asOf = opts.now ?? new Date();
  return {
    conn,
    f,
    asOf,
    // A literal built from Date#toISOString() can only be an ISO timestamp.
    asOfSql: opts.now ? `'${opts.now.toISOString()}'::timestamptz` : 'clock_timestamp()',
    period: { from: f.from ?? startOfUtcMonth(asOf), to: f.toExclusive ?? asOf },
  };
}

const round = (n: number | null, places: number): number | null => {
  if (n === null || n === undefined) return null;
  const k = 10 ** places;
  return Math.round(Number(n) * k) / k;
};
/** A percentage with two decimals; null when the denominator is zero (the ratio is undefined). */
export const percent = (n: number, d: number): number | null => (d > 0 ? Math.round((n * 10000) / d) / 100 : null);

/** area, management type, lister and (when the query has `st`) category. `b` is buildings, `st` space_types. */
function scope(qb: Knex.QueryBuilder, f: MetricFilters, withCategory = true): Knex.QueryBuilder {
  if (f.areaId) qb.where('b.area_id', f.areaId);
  if (f.managementType) qb.where('b.management_type', f.managementType);
  if (f.listerId) qb.where('b.lister_id', f.listerId);
  if (withCategory && f.categoryId) qb.where('st.category_id', f.categoryId);
  return qb;
}

/** Vacant, live space types of published buildings, with the filters applied. */
function vacantBase(c: Ctx): Knex.QueryBuilder {
  const qb = c.conn('space_types as st')
    .join('buildings as b', 'b.id', 'st.building_id')
    .where('b.status', 'published')
    .whereNull('st.removed_at')
    .where('st.vacant_count', '>', 0);
  return scope(qb, c.f);
}

const inPeriod = (qb: Knex.QueryBuilder, column: string, c: Ctx): Knex.QueryBuilder =>
  qb.where(column, '>=', c.period.from.toISOString()).where(column, '<', c.period.to.toISOString());

export interface FreshnessStats {
  total: number;
  fresh: number;
  medianDays: number | null;
  inVerifiedBuilding: number;
  listerVerified: number;
}

/** The numbers behind M02, M03 and M04 (and the weekly snapshot): one pass over the Vacant space types. */
export async function freshnessStats(c: Ctx): Promise<FreshnessStats> {
  const r = (await vacantBase(c)
    .join('profiles as lp', 'lp.user_id', 'b.lister_id')
    .first(
      c.conn.raw('count(*)::int AS total'),
      c.conn.raw(`count(*) FILTER (WHERE NOT ${outdatedSql('st', c.asOfSql)})::int AS fresh`),
      c.conn.raw(
        `percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (${c.asOfSql} - st.last_confirmed_at))::float8 / 86400.0) AS median_days`,
      ),
      c.conn.raw("count(*) FILTER (WHERE b.verification_status = 'verified')::int AS in_verified_building"),
      c.conn.raw("count(*) FILTER (WHERE lp.verification_status = 'verified')::int AS lister_verified"),
    )) as { total: number; fresh: number; median_days: number | null; in_verified_building: number; lister_verified: number };
  return {
    total: r.total,
    fresh: r.fresh,
    medianDays: r.median_days === null ? null : Number(r.median_days),
    inVerifiedBuilding: r.in_verified_building,
    listerVerified: r.lister_verified,
  };
}

/**
 * ASM-15: the "average number of Vacant space types in the month" is not stored anywhere. It is
 * approximated by the mean `denominator` of the weekly RPT-M02 snapshots dated inside the period,
 * for the matching slice (all, or one area, or one category, or one management type). When no such
 * snapshot exists (no job run yet, a filter combination the snapshots do not slice, or a lister
 * filter) it falls back to the number of Vacant space types right now. The response says which.
 */
async function averageVacant(c: Ctx): Promise<{ value: number; method: 'snapshot_average' | 'current_count'; snapshots: number }> {
  if (!c.f.listerId) {
    const lastDay = new Date(c.period.to.getTime() - 1).toISOString().slice(0, 10);
    const r = (await c.conn('metric_snapshots')
      .where('metric_code', 'RPT-M02')
      .where('snapshot_date', '>=', c.period.from.toISOString().slice(0, 10))
      .where('snapshot_date', '<=', lastDay)
      .whereRaw('area_id IS NOT DISTINCT FROM ?::uuid', [c.f.areaId])
      .whereRaw('category_id IS NOT DISTINCT FROM ?::uuid', [c.f.categoryId])
      .whereRaw('management_type IS NOT DISTINCT FROM ?::text', [c.f.managementType])
      .first(c.conn.raw('count(*)::int AS n'), c.conn.raw('avg(denominator)::float8 AS mean'))) as { n: number; mean: number | null };
    if (r.n > 0 && r.mean !== null) return { value: round(r.mean, 2)!, method: 'snapshot_average', snapshots: r.n };
  }
  const live = (await vacantBase(c).count({ n: '*' }).first()) as { n: string | number };
  return { value: Number(live.n), method: 'current_count', snapshots: 0 };
}

const medianSeconds = (c: Ctx, expr: string) =>
  c.conn.raw(`percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (${expr}))::float8) AS median_seconds`);

type Table = { headers: string[]; rows: unknown[][] };
interface MetricDef {
  /** Filters this metric applies to everything it counts; any filter not listed here or in `partial` is reported as ignored. */
  honours: readonly FilterName[];
  /** Filters that narrow only part of the metric (RPT-M10: area and management type narrow the building half only). */
  partial?: readonly FilterName[];
  run: (c: Ctx) => Promise<any>;
  table: (result: any) => Table;
}

const FOUR: readonly FilterName[] = ['areaId', 'categoryId', 'managementType', 'listerId'];
const FOUR_AND_DATES: readonly FilterName[] = [...FOUR, 'dateRange'];

const REGISTRY: Record<MetricCode, MetricDef> = {
  // RPT-M01 active listings
  'RPT-M01': {
    honours: FOUR,
    async run(c) {
      const v = (await vacantBase(c).first(
        c.conn.raw('count(DISTINCT b.id)::int AS buildings'),
        c.conn.raw('count(*)::int AS space_types'),
        c.conn.raw('coalesce(sum(st.vacant_count), 0)::int AS units'),
      )) as { buildings: number; space_types: number; units: number };
      const published = c.conn('buildings as b').where('b.status', 'published');
      if (c.f.categoryId) {
        published.whereExists(
          c.conn('space_types as st2').whereRaw('st2.building_id = b.id').whereNull('st2.removed_at').where('st2.category_id', c.f.categoryId),
        );
      }
      const all = (await scope(published, c.f, false).count({ n: '*' }).first()) as { n: string | number };
      return {
        publishedBuildings: Number(all.n),
        buildingsWithVacancy: v.buildings,
        vacantSpaceTypes: v.space_types,
        totalVacantUnits: v.units,
      };
    },
    table: (r) => ({
      headers: ['measure', 'value'],
      rows: [
        ['published_buildings', r.publishedBuildings],
        ['published_buildings_with_vacancy', r.buildingsWithVacancy],
        ['vacant_space_types', r.vacantSpaceTypes],
        ['total_vacant_units', r.totalVacantUnits],
      ],
    }),
  },

  // RPT-M02 freshness rate
  'RPT-M02': {
    honours: FOUR,
    async run(c) {
      const s = await freshnessStats(c);
      return { vacantSpaceTypes: s.total, updatedWithinThreshold: s.fresh, percent: percent(s.fresh, s.total) };
    },
    table: (r) => ({
      headers: ['vacant_space_types', 'updated_within_threshold', 'percent'],
      rows: [[r.vacantSpaceTypes, r.updatedWithinThreshold, r.percent]],
    }),
  },

  // RPT-M03 median days since last update
  'RPT-M03': {
    honours: FOUR,
    async run(c) {
      const s = await freshnessStats(c);
      return { vacantSpaceTypes: s.total, medianDays: round(s.medianDays, 2) };
    },
    table: (r) => ({ headers: ['vacant_space_types', 'median_days_since_update'], rows: [[r.vacantSpaceTypes, r.medianDays]] }),
  },

  // RPT-M04 verified share: BOTH figures
  'RPT-M04': {
    honours: FOUR,
    async run(c) {
      const s = await freshnessStats(c);
      return {
        vacantSpaceTypes: s.total,
        inVerifiedBuilding: { count: s.inVerifiedBuilding, percent: percent(s.inVerifiedBuilding, s.total) },
        listerVerified: { count: s.listerVerified, percent: percent(s.listerVerified, s.total) },
      };
    },
    table: (r) => ({
      headers: ['measure', 'vacant_space_types', 'verified', 'percent'],
      rows: [
        ['in_verified_building', r.vacantSpaceTypes, r.inVerifiedBuilding.count, r.inVerifiedBuilding.percent],
        ['lister_verified', r.vacantSpaceTypes, r.listerVerified.count, r.listerVerified.percent],
      ],
    }),
  },

  // RPT-M05 update compliance per lister. Lister ids only: names are personal data (see `user-admin`).
  'RPT-M05': {
    honours: FOUR,
    async run(c) {
      const rows = (await vacantBase(c)
        .groupBy('b.lister_id')
        .select(
          'b.lister_id',
          c.conn.raw('count(*)::int AS total'),
          c.conn.raw(`count(*) FILTER (WHERE NOT ${outdatedSql('st', c.asOfSql)})::int AS fresh`),
        )) as Array<{ lister_id: string; total: number; fresh: number }>;
      const listers = rows
        .map((r) => ({
          listerId: r.lister_id,
          vacantSpaceTypes: r.total,
          updatedWithinThreshold: r.fresh,
          compliancePercent: percent(r.fresh, r.total),
        }))
        .sort((a, b) => (a.compliancePercent ?? 0) - (b.compliancePercent ?? 0) || a.listerId.localeCompare(b.listerId));
      return { listers };
    },
    table: (r) => ({
      headers: ['lister_id', 'vacant_space_types', 'updated_within_threshold', 'compliance_percent'],
      rows: r.listers.map((l: any) => [l.listerId, l.vacantSpaceTypes, l.updatedWithinThreshold, l.compliancePercent]),
    }),
  },

  // RPT-M06 engagement: (enquiries + tap-to-call) in the period / average Vacant space types
  'RPT-M06': {
    honours: FOUR_AND_DATES,
    async run(c) {
      const enquiries = inPeriod(
        scope(
          c.conn('enquiries as e').join('space_types as st', 'st.id', 'e.space_type_id').join('buildings as b', 'b.id', 'st.building_id'),
          c.f,
        ),
        'e.created_at',
        c,
      );
      // A tap on a building with no space type cannot be attributed to a category: with a category filter it is left out.
      const taps = inPeriod(
        scope(
          c.conn('contact_events as ce').join('buildings as b', 'b.id', 'ce.building_id').leftJoin('space_types as st', 'st.id', 'ce.space_type_id'),
          c.f,
        ),
        'ce.created_at',
        c,
      );
      const [e, t, avg] = await Promise.all([
        enquiries.count({ n: '*' }).first() as Promise<{ n: string | number }>,
        taps.count({ n: '*' }).first() as Promise<{ n: string | number }>,
        averageVacant(c),
      ]);
      const total = Number(e.n) + Number(t.n);
      return {
        enquiries: Number(e.n),
        tapToCallEvents: Number(t.n),
        averageVacantSpaceTypes: avg,
        perVacantSpaceType: avg.value > 0 ? round(total / avg.value, 4) : null,
      };
    },
    table: (r) => ({
      headers: ['enquiries', 'tap_to_call_events', 'average_vacant_space_types', 'denominator_method', 'per_vacant_space_type'],
      rows: [[r.enquiries, r.tapToCallEvents, r.averageVacantSpaceTypes.value, r.averageVacantSpaceTypes.method, r.perVacantSpaceType]],
    }),
  },

  // RPT-M07 median time from enquiry creation to the first maintainer reply
  'RPT-M07': {
    honours: FOUR_AND_DATES,
    async run(c) {
      const r = (await inPeriod(
        scope(
          c.conn('enquiries as e').join('space_types as st', 'st.id', 'e.space_type_id').join('buildings as b', 'b.id', 'st.building_id'),
          c.f,
        ),
        'e.created_at',
        c,
      ).first(
        c.conn.raw('count(*)::int AS total'),
        c.conn.raw('count(e.first_response_at)::int AS responded'),
        medianSeconds(c, 'e.first_response_at - e.created_at'),
      )) as { total: number; responded: number; median_seconds: number | null };
      const seconds = r.median_seconds === null ? null : Number(r.median_seconds);
      return {
        enquiries: r.total,
        responded: r.responded,
        medianSeconds: round(seconds, 1),
        medianHours: seconds === null ? null : round(seconds / 3600, 2),
      };
    },
    table: (r) => ({
      headers: ['enquiries', 'responded', 'median_response_hours'],
      rows: [[r.enquiries, r.responded, r.medianHours]],
    }),
  },

  // RPT-M08 "unavailable" reports in the period / average Vacant space types
  'RPT-M08': {
    honours: FOUR_AND_DATES,
    async run(c) {
      // A building-level report has no space type, so a category filter leaves it out.
      const reports = inPeriod(
        scope(
          c.conn('reports as r')
            .leftJoin('space_types as st', 'st.id', 'r.space_type_id')
            .joinRaw('JOIN buildings b ON b.id = COALESCE(r.building_id, st.building_id)')
            .where('r.reason', 'unavailable'),
          c.f,
        ),
        'r.created_at',
        c,
      );
      const [n, avg] = await Promise.all([reports.count({ n: '*' }).first() as Promise<{ n: string | number }>, averageVacant(c)]);
      return {
        unavailableReports: Number(n.n),
        averageVacantSpaceTypes: avg,
        ratePercent: percent(Number(n.n), avg.value),
      };
    },
    table: (r) => ({
      headers: ['unavailable_reports', 'average_vacant_space_types', 'denominator_method', 'rate_percent'],
      rows: [[r.unavailableReports, r.averageVacantSpaceTypes.value, r.averageVacantSpaceTypes.method, r.ratePercent]],
    }),
  },

  // RPT-M09 users: new registrations and active users in the period, by role
  'RPT-M09': {
    honours: ['dateRange'],
    async run(c) {
      const from = c.period.from.toISOString();
      const to = c.period.to.toISOString();
      const byRole = (await c.conn('profiles as p')
        .join('user_roles as r', 'r.user_id', 'p.user_id')
        .whereNull('p.erased_at')
        .groupBy('r.role')
        .select(
          'r.role',
          c.conn.raw('count(*) FILTER (WHERE p.created_at >= ? AND p.created_at < ?)::int AS new_users', [from, to]),
          c.conn.raw('count(*) FILTER (WHERE p.last_login_at >= ? AND p.last_login_at < ?)::int AS active_users', [from, to]),
        )) as Array<{ role: string; new_users: number; active_users: number }>;
      const all = (await c.conn('profiles as p')
        .whereNull('p.erased_at')
        .first(
          c.conn.raw('count(*) FILTER (WHERE p.created_at >= ? AND p.created_at < ?)::int AS new_users', [from, to]),
          c.conn.raw('count(*) FILTER (WHERE p.last_login_at >= ? AND p.last_login_at < ?)::int AS active_users', [from, to]),
        )) as { new_users: number; active_users: number };
      const roles: Record<string, { newRegistrations: number; activeUsers: number }> = {};
      for (const role of ['client', 'landlord', 'agent', 'admin']) {
        const row = byRole.find((x) => x.role === role);
        roles[role] = { newRegistrations: row?.new_users ?? 0, activeUsers: row?.active_users ?? 0 };
      }
      // A user with two roles counts in each role but once in the total.
      return { roles, total: { newRegistrations: all.new_users, activeUsers: all.active_users } };
    },
    table: (r) => ({
      headers: ['role', 'new_registrations', 'active_users'],
      rows: [
        ...Object.entries(r.roles).map(([role, v]: [string, any]) => [role, v.newRegistrations, v.activeUsers]),
        ['all', r.total.newRegistrations, r.total.activeUsers],
      ],
    }),
  },

  // RPT-M10 verification turnaround: median Pending-to-decision, decisions made in the period
  'RPT-M10': {
    honours: ['listerId', 'dateRange'],
    partial: ['areaId', 'managementType'],
    async run(c) {
      // What was filtered is unchanged: accounts have no area or management type, so those narrow the building half only.
      const given = givenFilters(c.f);
      const accountFilters = given.filter((n) => n === 'listerId' || n === 'dateRange');
      const buildingFilters = given.filter((n) => n === 'areaId' || n === 'managementType' || n === 'listerId' || n === 'dateRange');
      const accounts = c.conn('verification_cases as vc').where('vc.subject_type', 'account');
      if (c.f.listerId) accounts.where('vc.subject_user_id', c.f.listerId);
      const buildings = scope(
        c.conn('verification_cases as vc')
          .join('buildings as b', 'b.id', 'vc.subject_building_id')
          .where('vc.subject_type', 'building'),
        c.f,
        false,
      );
      const stats = async (qb: Knex.QueryBuilder) => {
        const r = (await inPeriod(qb, 'vc.decided_at', c).first(
          c.conn.raw('count(*)::int AS decisions'),
          medianSeconds(c, 'vc.decided_at - vc.submitted_at'),
        )) as { decisions: number; median_seconds: number | null };
        return { decisions: r.decisions, medianHours: r.median_seconds === null ? null : round(Number(r.median_seconds) / 3600, 2) };
      };
      const [a, b] = await Promise.all([stats(accounts), stats(buildings)]);
      return { accounts: { ...a, filtersApplied: accountFilters }, buildings: { ...b, filtersApplied: buildingFilters } };
    },
    table: (r) => ({
      headers: ['subject', 'decisions', 'median_hours'],
      rows: [
        ['account', r.accounts.decisions, r.accounts.medianHours],
        ['building', r.buildings.decisions, r.buildings.medianHours],
      ],
    }),
  },
};

const givenFilters = (f: MetricFilters): FilterName[] =>
  FILTER_NAMES.filter((name) => (name === 'dateRange' ? f.from !== null || f.toExclusive !== null : f[name] !== null));

const filterEcho = (f: MetricFilters) => ({
  areaId: f.areaId,
  categoryId: f.categoryId,
  managementType: f.managementType,
  listerId: f.listerId,
  from: f.from?.toISOString() ?? null,
  toExclusive: f.toExclusive?.toISOString() ?? null,
});

export interface MetricsResponse {
  generatedAt: string;
  filters: ReturnType<typeof filterEcho>;
  /** The window used by the period metrics (M06 to M10). */
  period: { from: string; toExclusive: string };
  metrics: Record<MetricCode, any>;
  meta: {
    pointInTime: MetricCode[];
    /** Per metric: which of the filters the caller sent it applied, applied to part of it only (`partial`), and ignored (ASM-15). */
    filterSupport: Record<MetricCode, { applied: FilterName[]; partial: FilterName[]; ignored: FilterName[] }>;
    notes: string[];
  };
}

/** FR-RPT-001: RPT-M01 to M10 in one response. */
export async function getMetrics(f: MetricFilters, opts: MetricsOptions = {}, conn: Conn = db): Promise<MetricsResponse> {
  const c = makeCtx(conn, f, opts);
  const results = await Promise.all(METRIC_CODES.map(async (code) => [code, await REGISTRY[code].run(c)] as const));
  const given = givenFilters(f);
  const filterSupport = Object.fromEntries(
    METRIC_CODES.map((code) => {
      const honoured = REGISTRY[code].honours;
      const partial = REGISTRY[code].partial ?? [];
      return [
        code,
        {
          applied: given.filter((n) => honoured.includes(n)),
          partial: given.filter((n) => partial.includes(n)),
          ignored: given.filter((n) => !honoured.includes(n) && !partial.includes(n)),
        },
      ];
    }),
  ) as MetricsResponse['meta']['filterSupport'];
  return {
    generatedAt: c.asOf.toISOString(),
    filters: filterEcho(f),
    period: { from: c.period.from.toISOString(), toExclusive: c.period.to.toISOString() },
    metrics: Object.fromEntries(results) as MetricsResponse['metrics'],
    meta: {
      pointInTime: ['RPT-M01', 'RPT-M02', 'RPT-M03', 'RPT-M04', 'RPT-M05'],
      filterSupport,
      notes: [
        'Counts cover Vacant space types of Published buildings only.',
        'RPT-M01 to M05 describe now; the date range applies to RPT-M06 to M10 (default: this UTC month so far).',
        'RPT-M06 and M08 divide by the average number of Vacant space types in the period: the mean of the weekly RPT-M02 snapshots when available, else the current count (see averageVacantSpaceTypes.method).',
        'RPT-M09 active users are users whose LAST login falls in the period.',
        'RPT-M05 lists lister ids, not names; open the user in the user administration to see a name.',
        'RPT-M10: area and management type narrow the building cases only; the lister filter narrows both account and building cases.',
      ],
    },
  };
}

const EXPORT_FILENAMES = (code: MetricCode) => `${code.toLowerCase()}.csv`;

/** FR-RPT-002: one metric as a CSV table (headers only when it has no rows) and its `export.run` audit row. */
export async function exportMetricCsv(
  auth: AuthContext,
  code: MetricCode,
  f: MetricFilters,
  opts: MetricsOptions = {},
): Promise<{ csv: string; rowCount: number; filename: string }> {
  return withTx(async (trx) => {
    const c = makeCtx(trx, f, opts);
    const table = REGISTRY[code].table(await REGISTRY[code].run(c));
    await writeAudit(trx, {
      actorUserId: auth.user.id,
      actorType: 'staff',
      action: 'export.run',
      objectType: 'export',
      changes: { export: code, filters: filterEcho(f), rowCount: table.rows.length },
    });
    return { csv: toCsv(table.headers, table.rows), rowCount: table.rows.length, filename: EXPORT_FILENAMES(code) };
  });
}
