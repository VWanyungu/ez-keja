/**
 * Freshness (BR-001, BR-030, FR-AVL-005). Derived on read, never stored (design §8.1).
 *
 * The SQL helpers are the single source of truth: the maintainer dashboard, the reminder job, the
 * follow-up queue and (Phase 7) public search all build their predicate from `outdatedSql`, so
 * "exactly 7 days is not outdated" is decided in one place and by the database clock.
 */

export type FreshnessState = 'fresh' | 'may_be_outdated' | 'not_applicable';

const SAFE_ALIAS = /^[a-z_][a-z0-9_]*$/i;
const alias = (value: string): string => {
  if (!SAFE_ALIAS.test(value)) throw new Error(`Unsafe SQL alias: ${value}`);
  return value;
};

/** `settings.freshness_days`, read inside the statement so it needs no extra round trip. */
export const FRESHNESS_DAYS_SQL = "(SELECT value FROM settings WHERE key = 'freshness_days')";

/**
 * BR-001 / BR-030: true for a live Vacant space type whose last update is MORE than
 * `freshness_days` days before `asOfSql` (default: the statement clock). Equal is not outdated.
 * Fully let and removed space types are never outdated, so they are neither labelled nor reminded.
 * `asOfSql` is trusted SQL (a literal or `clock_timestamp()`); never pass user input.
 */
export function outdatedSql(spaceTypeAlias: string, asOfSql = 'clock_timestamp()'): string {
  const a = alias(spaceTypeAlias);
  return `(${a}.vacant_count > 0 AND ${a}.removed_at IS NULL
    AND ${asOfSql} - ${a}.last_confirmed_at > make_interval(days => ${FRESHNESS_DAYS_SQL}))`;
}

/** BR-030 (Q-D4): a building's latest update counts only its live Vacant space types. */
export function latestVacantUpdateSql(spaceTypeAlias: string): string {
  const a = alias(spaceTypeAlias);
  return `max(${a}.last_confirmed_at) FILTER (WHERE ${a}.vacant_count > 0 AND ${a}.removed_at IS NULL)`;
}

/**
 * A timestamptz as ISO-8601 text with microseconds. JSON dates stop at milliseconds, and the bulk
 * confirm compares `last_confirmed_at` for equality (TX-02), so the exact value must round-trip
 * as text (design §7.4). The fixed format also sorts correctly as a string.
 */
export function isoMicros(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

export const freshnessOf = (vacantCount: number, outdated: boolean): FreshnessState =>
  vacantCount <= 0 ? 'not_applicable' : outdated ? 'may_be_outdated' : 'fresh';

export interface BuildingFreshness {
  state: FreshnessState;
  /** Latest `last_confirmed_at` among the building's Vacant space types; null when none is Vacant. */
  latestUpdate: string | null;
}

/**
 * BR-030 from space types already flagged by `outdatedSql`. The latest Vacant update is older
 * than the threshold exactly when every Vacant space type is, so no second threshold test is needed.
 * `lastConfirmedAt` must be `isoMicros` text so the strings compare as times.
 */
export function summariseBuildingFreshness(
  spaceTypes: ReadonlyArray<{ vacantCount: number; lastConfirmedAt: string; outdated: boolean }>,
): BuildingFreshness {
  const vacant = spaceTypes.filter((t) => t.vacantCount > 0);
  if (vacant.length === 0) return { state: 'not_applicable', latestUpdate: null };
  const latestUpdate = vacant.reduce((max, t) => (t.lastConfirmedAt > max ? t.lastConfirmedAt : max), '');
  return { state: vacant.every((t) => t.outdated) ? 'may_be_outdated' : 'fresh', latestUpdate };
}
