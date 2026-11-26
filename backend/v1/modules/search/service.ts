import type { Knex } from 'knex';
import db from '../../db/knex.js';
import { isoMicros, outdatedSql, summariseBuildingFreshness } from '../../lib/freshness.js';
import { escapeLike } from '../../lib/like.js';
import {
  BUILDING_PROFILE_JOINS_SQL,
  BUILDING_PROFILE_SELECT_SQL,
  hasActiveMaintainerSql,
  photoUrls,
  toIndicators,
  toManagement,
  type BuildingProfileRow,
  type ManagementDesignation,
  type PhotoUrls,
  type VerificationIndicators,
} from '../../lib/public-catalogue.js';
import { encodeSearchCursor, type SearchFilters } from './schemas.js';

export interface RentRange {
  currencyId: string;
  currencyCode: string;
  min: number;
  max: number;
}

export interface BuildingCard {
  id: string;
  name: string;
  area: { id: string; name: string };
  coverPhoto: PhotoUrls | null;
  /**
   * FR-SRC-005: one range per currency over the building's Vacant space types that show a rent.
   * `rentOnInterest` is true exactly when none of them does (the card says "Rent on interest").
   */
  rent: { ranges: RentRange[]; rentOnInterest: boolean };
  management: ManagementDesignation;
  /** FR-VER-005: the lister's account and the building, kept apart. */
  verification: VerificationIndicators;
  /** BR-030: latest update among the building's Vacant space types, ISO-8601 with microseconds. */
  latestUpdate: string | null;
  outdated: boolean;
}

export interface SearchPage {
  items: BuildingCard[];
  nextCursor: string | null;
}

interface CandidateRow extends BuildingProfileRow {
  id: string;
  name: string;
  area_id: string;
  area_name: string;
  latest_text: string;
  min_rent: string | null;
}

const KM_PER_DEGREE = 111.32;

/**
 * QP-01 (DATABASE_DESIGN §11.1): published buildings with at least one matching Vacant space type,
 * via a lateral aggregate over `ix_space_types_building_vacant`. `u.latest` is NULL exactly when no
 * Vacant type matches, which is BR-002. Keyset only; the cursor carries `latest::text` so
 * microseconds survive (§7.4). Exported so the performance test explains the very SQL that runs.
 *
 * Under a category or rent filter `latest` is the latest update among the MATCHING types, so the
 * order is "newest matching update first"; the card's own `latestUpdate` always covers every Vacant
 * type (BR-030).
 */
export function buildSearchQuery(f: SearchFilters): { sql: string; bindings: Knex.RawBinding[] } {
  const bindings: Knex.RawBinding[] = [];
  const bind = (value: Knex.RawBinding): string => {
    bindings.push(value);
    return '?';
  };

  // FR-SRC-002, FR-SRC-003: what a space type must satisfy to make its building match.
  const lateral: string[] = ['s.building_id = b.id', 's.vacant_count > 0', 's.removed_at IS NULL'];
  if (f.categoryId) lateral.push(`s.category_id = ${bind(f.categoryId)}`);
  if (f.currencyId) {
    // `bind` order must follow the order the placeholders appear in the SQL text.
    lateral.push(`s.currency_id = ${bind(f.currencyId)}`);
    const fixed = [`s.rent_mode = 'fixed'`];
    if (f.rentMin !== null) fixed.push(`s.rent_amount >= ${bind(f.rentMin)}`);
    if (f.rentMax !== null) fixed.push(`s.rent_amount <= ${bind(f.rentMax)}`);
    const arms = [`(${fixed.join(' AND ')})`];
    if (f.includeRentOnInterest) arms.push(`s.rent_mode = 'on_interest'`);
    lateral.push(`(${arms.join(' OR ')})`);
  }
  const lowestRent = f.currencyId
    ? `min(s.rent_amount) FILTER (WHERE s.rent_mode = 'fixed')`
    : 'NULL::numeric';

  const where: string[] = [`b.status = 'published'`];
  if (f.areaId) where.push(`b.area_id = ${bind(f.areaId)}`);
  if (f.radius) {
    // QP-02: bounding box (served by ix_buildings_published_latlng), then exact haversine.
    // shortcut: no antimeridian or polar wrap; fine for one country near the equator, revisit if
    // the platform ever covers other regions.
    const { lat, lng, radiusKm } = f.radius;
    const dLat = radiusKm / KM_PER_DEGREE;
    const dLng = radiusKm / (KM_PER_DEGREE * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
    where.push(
      `b.latitude BETWEEN ${bind(lat - dLat)} AND ${bind(lat + dLat)}`,
      `b.longitude BETWEEN ${bind(lng - dLng)} AND ${bind(lng + dLng)}`,
      `6371 * 2 * asin(sqrt(power(sin(radians(b.latitude::float8 - ${bind(lat)}::float8) / 2), 2)
        + cos(radians(${bind(lat)}::float8)) * cos(radians(b.latitude::float8))
        * power(sin(radians(b.longitude::float8 - ${bind(lng)}::float8) / 2), 2))) <= ${bind(radiusKm)}::float8`,
    );
  }
  if (f.management) where.push(`b.management_type = ${bind(f.management)}`);
  if (f.verifiedOnly) where.push(`b.verification_status = 'verified'`); // FR-SRC-004
  if (f.q) {
    // shortcut: a plain substring scan over published buildings; add a trigram index if the catalogue outgrows it.
    const pattern = `%${escapeLike(f.q)}%`;
    where.push(`(b.name ILIKE ${bind(pattern)} ESCAPE '\\' OR a.name ILIKE ${bind(pattern)} ESCAPE '\\')`);
  }
  where.push('u.latest IS NOT NULL', hasActiveMaintainerSql('b'));

  let orderBy = 'u.latest DESC, b.id DESC';
  const cursor = f.cursor;
  if (f.sort === 'updated') {
    if (cursor?.kind === 'updated') {
      where.push(`(u.latest, b.id) < (${bind(cursor.t)}::timestamptz, ${bind(cursor.id)}::uuid)`);
    }
  } else {
    // FR-SRC-006: lowest Vacant rent, buildings without a fixed rent last whichever way it runs.
    const asc = f.sort === 'rent_asc';
    orderBy = `u.min_rent ${asc ? 'ASC' : 'DESC'} NULLS LAST, b.id DESC`;
    if (cursor?.kind === 'rent') {
      if (cursor.r === null) {
        where.push(`(u.min_rent IS NULL AND b.id < ${bind(cursor.id)}::uuid)`);
      } else {
        const op = asc ? '>' : '<';
        where.push(
          `(u.min_rent ${op} ${bind(cursor.r)}::numeric
            OR (u.min_rent = ${bind(cursor.r)}::numeric AND b.id < ${bind(cursor.id)}::uuid)
            OR u.min_rent IS NULL)`,
        );
      }
    }
  }

  const sql = `
    SELECT b.id, b.name, b.area_id, a.name AS area_name, u.latest::text AS latest_text,
      u.min_rent::text AS min_rent, ${BUILDING_PROFILE_SELECT_SQL}
    FROM buildings b
    CROSS JOIN LATERAL (
      SELECT max(s.last_confirmed_at) AS latest, ${lowestRent} AS min_rent
      FROM space_types s
      WHERE ${lateral.join(' AND ')}
    ) u
    JOIN areas a ON a.id = b.area_id
    ${BUILDING_PROFILE_JOINS_SQL}
    WHERE ${where.join('\n      AND ')}
    ORDER BY ${orderBy}
    LIMIT ${bind(f.limit + 1)}`;
  return { sql, bindings };
}

interface RentGroupRow {
  building_id: string;
  currency_id: string;
  currency_code: string;
  min_rent: string | null;
  max_rent: string | null;
  all_outdated: boolean;
  latest: string;
}

/** FR-SRC-005 / OQ-53: a range per currency; a currency whose Vacant types are all "on interest" adds none. */
export function summariseRent(
  groups: ReadonlyArray<Pick<RentGroupRow, 'currency_id' | 'currency_code' | 'min_rent' | 'max_rent'>>,
): BuildingCard['rent'] {
  const ranges = groups
    .filter((g) => g.min_rent !== null && g.max_rent !== null)
    .map((g) => ({
      currencyId: g.currency_id,
      currencyCode: g.currency_code,
      min: Number(g.min_rent),
      max: Number(g.max_rent),
    }))
    .sort((a, b) => a.currencyCode.localeCompare(b.currencyCode));
  return { ranges, rentOnInterest: ranges.length === 0 };
}

/** FR-SRC-001 to FR-SRC-006, BR-002. */
export async function searchBuildings(filters: SearchFilters): Promise<SearchPage> {
  const { sql, bindings } = buildSearchQuery(filters);
  const result = await db.raw(sql, bindings);
  const rows = result.rows as CandidateRow[];
  const page = rows.slice(0, filters.limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > filters.limit && last
      ? encodeSearchCursor(
          filters.sort === 'updated'
            ? { kind: 'updated', t: last.latest_text, id: last.id }
            : { kind: 'rent', r: last.min_rent, id: last.id },
        )
      : null;
  if (page.length === 0) return { items: [], nextCursor: null };

  const ids = page.map((r) => r.id);
  // QP-04: the rent ranges and freshness of the whole page in one grouped read of the covering index.
  const [groups, covers] = await Promise.all([
    db('space_types as s')
      .join('currencies as c', 'c.id', 's.currency_id')
      .whereIn('s.building_id', ids)
      .where('s.vacant_count', '>', 0)
      .whereNull('s.removed_at')
      .groupBy('s.building_id', 's.currency_id', 'c.code')
      .select(
        's.building_id',
        's.currency_id',
        'c.code as currency_code',
        db.raw(`min(s.rent_amount) FILTER (WHERE s.rent_mode = 'fixed')::text AS min_rent`),
        db.raw(`max(s.rent_amount) FILTER (WHERE s.rent_mode = 'fixed')::text AS max_rent`),
        db.raw(`bool_and(${outdatedSql('s')}) AS all_outdated`),
        db.raw(`${isoMicros('max(s.last_confirmed_at)')} AS latest`),
      ) as Promise<RentGroupRow[]>,
    db('photos as p')
      .join('files as f', 'f.id', 'p.file_id')
      .whereIn('p.building_id', ids)
      .where('p.category', 'cover')
      .whereNull('p.removed_at')
      .select('p.building_id', 'f.public_id') as Promise<Array<{ building_id: string; public_id: string }>>,
  ]);
  const coverOf = new Map(covers.map((c) => [c.building_id, c.public_id]));

  const items = page.map((row): BuildingCard => {
    const own = groups.filter((g) => g.building_id === row.id);
    // Every group here is Vacant by construction, so a count of 1 stands for "has Vacant types".
    const { state, latestUpdate } = summariseBuildingFreshness(
      own.map((g) => ({ vacantCount: 1, lastConfirmedAt: g.latest, outdated: g.all_outdated })),
    );
    const publicId = coverOf.get(row.id);
    return {
      id: row.id,
      name: row.name,
      area: { id: row.area_id, name: row.area_name },
      coverPhoto: publicId ? photoUrls(publicId) : null,
      rent: summariseRent(own),
      management: toManagement(row),
      verification: toIndicators(row),
      latestUpdate,
      outdated: state === 'may_be_outdated',
    };
  });
  return { items, nextCursor };
}
