import db from '../../db/knex.js';
import { notFound } from '../../lib/http-error.js';
import { isoMicros, outdatedSql, summariseBuildingFreshness } from '../../lib/freshness.js';
import {
  assertPubliclyAvailable,
  availabilitySelectSql,
  BUILDING_PROFILE_JOINS_SQL,
  BUILDING_PROFILE_SELECT_SQL,
  gatePhone,
  hasActiveMaintainerSql,
  photoUrls,
  toIndicators,
  toManagement,
  toNumber,
  type AvailabilityRow,
  type BuildingProfileRow,
  type ManagementDesignation,
  type PhotoUrls,
  type VerificationIndicators,
} from '../../lib/public-catalogue.js';
import type { AuthContext } from '../../middlewares/auth.js';
import type { ContactEventInput } from './schemas.js';

type Viewer = Pick<AuthContext, 'user'> | undefined;

export interface PublicPhoto {
  id: string;
  sortOrder: number;
  urls: PhotoUrls;
}

/**
 * The designated contact (FR-ENQ-003). `phone` is null and `phoneRequiresLogin` true for a Guest
 * (BR-009). Null for a Fully let space type (no contact actions) or when the contact's account is
 * no longer active.
 */
export interface PublicContact {
  displayName: string;
  phone: string | null;
  phoneRequiresLogin: boolean;
}

export interface PublicSpaceTypeFields {
  id: string;
  name: string;
  category: { id: string; code: string; nameEn: string; nameSw: string };
  /** Null when no size was recorded. */
  sizeSqm: number | null;
  currency: { id: string; code: string };
  rentOnInterest: boolean;
  rentAmount: number | null;
  depositAmount: number;
  vacantCount: number;
  fullyLet: boolean;
  /** ISO-8601 with microseconds. */
  lastConfirmedAt: string;
  /** "Confirmed N days ago"; null when Fully let (nothing is being advertised). */
  confirmedDaysAgo: number | null;
  /** BR-001 from `lib/freshness.ts`; never true for a Fully let space type. */
  outdated: boolean;
}

export interface PublicBuildingPage {
  id: string;
  name: string;
  area: { id: string; name: string };
  /**
   * The pin exactly as stored. BR-019 wants an area-level public display, but the product default
   * (G-06) is the exact pin until the owner decides; area-level is a later API decision.
   */
  location: { latitude: number; longitude: number };
  description: string | null;
  photos: { cover: PublicPhoto | null; grounds: PublicPhoto[]; surroundings: PublicPhoto[] };
  management: ManagementDesignation;
  verification: VerificationIndicators;
  /** BR-030: latest update among the Vacant space types; null when none is Vacant. */
  latestUpdate: string | null;
  outdated: boolean;
  /** BR-002: every live space type, Fully let ones labelled by `fullyLet`. */
  spaceTypes: Array<PublicSpaceTypeFields & { photo: PhotoUrls | null }>;
  contact: PublicContact | null;
}

export interface PublicSpaceTypePage extends PublicSpaceTypeFields {
  building: { id: string; name: string; area: { id: string; name: string } };
  photos: PublicPhoto[];
  management: ManagementDesignation;
  verification: VerificationIndicators;
  /** Null when Fully let: no contact actions (FR-SRC-007). */
  contact: PublicContact | null;
}

// ---- shared row shapes and SQL ---------------------------------------------------------------

interface SpaceTypeRow {
  id: string;
  name: string;
  size_sqm: string | null;
  rent_mode: 'fixed' | 'on_interest';
  rent_amount: string | null;
  deposit_amount: string;
  vacant_count: number;
  category_id: string;
  category_code: string;
  category_name_en: string;
  category_name_sw: string;
  currency_id: string;
  currency_code: string;
  last_confirmed_at: string;
  days_since_confirmed: number;
  outdated: boolean;
}

/** Needs `space_types s`, `space_categories cat` and `currencies cu` joined. */
const SPACE_TYPE_SELECT_SQL = `
  s.id, s.name, s.size_sqm, s.rent_mode, s.rent_amount, s.deposit_amount, s.vacant_count,
  cat.id AS category_id, cat.code AS category_code, cat.name_en AS category_name_en, cat.name_sw AS category_name_sw,
  cu.id AS currency_id, cu.code AS currency_code,
  ${isoMicros('s.last_confirmed_at')} AS last_confirmed_at,
  floor(extract(epoch FROM (clock_timestamp() - s.last_confirmed_at)) / 86400)::int AS days_since_confirmed,
  ${outdatedSql('s')} AS outdated`;

const SPACE_TYPE_JOINS_SQL = `
  JOIN space_categories cat ON cat.id = s.category_id
  JOIN currencies cu ON cu.id = s.currency_id`;

function toSpaceTypeFields(row: SpaceTypeRow): PublicSpaceTypeFields {
  const fullyLet = row.vacant_count === 0;
  return {
    id: row.id,
    name: row.name,
    category: {
      id: row.category_id,
      code: row.category_code,
      nameEn: row.category_name_en,
      nameSw: row.category_name_sw,
    },
    sizeSqm: toNumber(row.size_sqm),
    currency: { id: row.currency_id, code: row.currency_code },
    rentOnInterest: row.rent_mode === 'on_interest',
    rentAmount: toNumber(row.rent_amount),
    depositAmount: Number(row.deposit_amount),
    vacantCount: row.vacant_count,
    fullyLet,
    lastConfirmedAt: row.last_confirmed_at,
    confirmedDaysAgo: fullyLet ? null : row.days_since_confirmed,
    outdated: row.outdated,
  };
}

interface ContactColumns {
  contact_name: string | null;
  contact_phone: string | null;
}

/** The contact joins only while their account is active; see `CONTACT_JOIN_SQL`. */
function toContact(row: ContactColumns, viewer: Viewer): PublicContact | null {
  if (row.contact_name === null) return null;
  return { displayName: row.contact_name, ...gatePhone(viewer, row.contact_phone) };
}

const CONTACT_SELECT_SQL = 'ct.display_name AS contact_name, ct.phone AS contact_phone';
const CONTACT_JOIN_SQL = `
  LEFT JOIN profiles ct ON ct.user_id = b.contact_user_id AND ct.account_status = 'active' AND ct.erased_at IS NULL`;

const toPhoto = (row: { id: string; sort_order: number; public_id: string }): PublicPhoto => ({
  id: row.id,
  sortOrder: row.sort_order,
  urls: photoUrls(row.public_id),
});

// ---- building page ---------------------------------------------------------------------------

interface BuildingPageRow extends BuildingProfileRow, AvailabilityRow, ContactColumns {
  id: string;
  name: string;
  area_id: string;
  area_name: string;
  latitude: string;
  longitude: string;
  description: string | null;
}

/** FR-SRC-008, BR-002, BR-009, FR-VER-005. Throws 404 or 410 per `assertPubliclyAvailable`. */
export async function getPublicBuilding(viewer: Viewer, buildingId: string): Promise<PublicBuildingPage> {
  const result = await db.raw(
    `SELECT b.id, b.name, b.area_id, a.name AS area_name, b.latitude, b.longitude, b.description,
       ${availabilitySelectSql('b')}, ${BUILDING_PROFILE_SELECT_SQL}, ${CONTACT_SELECT_SQL}
     FROM buildings b
     JOIN areas a ON a.id = b.area_id
     ${BUILDING_PROFILE_JOINS_SQL}
     ${CONTACT_JOIN_SQL}
     WHERE b.id = ?`,
    [buildingId],
  );
  const building = result.rows[0] as BuildingPageRow | undefined;
  assertPubliclyAvailable(building);
  const b = building!;

  const types = (
    await db.raw(
      `SELECT ${SPACE_TYPE_SELECT_SQL}
       FROM space_types s ${SPACE_TYPE_JOINS_SQL}
       WHERE s.building_id = ? AND s.removed_at IS NULL
       ORDER BY s.created_at, s.id`,
      [buildingId],
    )
  ).rows as SpaceTypeRow[];

  const [buildingPhotos, typePhotos] = await Promise.all([
    db('photos as p')
      .join('files as f', 'f.id', 'p.file_id')
      .where('p.building_id', buildingId)
      .whereNull('p.removed_at')
      .orderBy('p.sort_order')
      .orderBy('p.created_at')
      .orderBy('p.id')
      .select('p.id', 'p.category', 'p.sort_order', 'f.public_id') as Promise<
      Array<{ id: string; category: string; sort_order: number; public_id: string }>
    >,
    // The first photo of each space type is its thumbnail on the building page.
    types.length === 0
      ? Promise.resolve([] as Array<{ space_type_id: string; public_id: string }>)
      : (db('photos as p')
          .join('files as f', 'f.id', 'p.file_id')
          .distinctOn('p.space_type_id')
          .whereIn('p.space_type_id', types.map((t) => t.id))
          .whereNull('p.removed_at')
          .orderBy('p.space_type_id')
          .orderBy('p.sort_order')
          .orderBy('p.created_at')
          .orderBy('p.id')
          .select('p.space_type_id', 'f.public_id') as Promise<Array<{ space_type_id: string; public_id: string }>>),
  ]);
  const thumbOf = new Map(typePhotos.map((p) => [p.space_type_id, p.public_id]));
  const fields = types.map(toSpaceTypeFields);
  const { state, latestUpdate } = summariseBuildingFreshness(
    fields.map((t) => ({ vacantCount: t.vacantCount, lastConfirmedAt: t.lastConfirmedAt, outdated: t.outdated })),
  );
  const cover = buildingPhotos.find((p) => p.category === 'cover');

  return {
    id: b.id,
    name: b.name,
    area: { id: b.area_id, name: b.area_name },
    location: { latitude: Number(b.latitude), longitude: Number(b.longitude) },
    description: b.description,
    photos: {
      cover: cover ? toPhoto(cover) : null,
      grounds: buildingPhotos.filter((p) => p.category === 'grounds').map(toPhoto),
      surroundings: buildingPhotos.filter((p) => p.category === 'surroundings').map(toPhoto),
    },
    management: toManagement(b),
    verification: toIndicators(b),
    latestUpdate,
    outdated: state === 'may_be_outdated',
    spaceTypes: fields.map((t) => {
      const publicId = thumbOf.get(t.id);
      return { ...t, photo: publicId ? photoUrls(publicId) : null };
    }),
    contact: toContact(b, viewer),
  };
}

// ---- space-type page -------------------------------------------------------------------------

interface SpaceTypePageRow extends SpaceTypeRow, BuildingProfileRow, AvailabilityRow, ContactColumns {
  building_id: string;
  building_name: string;
  area_id: string;
  area_name: string;
  removed_at: Date | null;
}

/** FR-SRC-007. A removed space type, and the building's unavailable cases, follow the building page. */
export async function getPublicSpaceType(viewer: Viewer, spaceTypeId: string): Promise<PublicSpaceTypePage> {
  const result = await db.raw(
    `SELECT ${SPACE_TYPE_SELECT_SQL}, s.building_id, s.removed_at, b.name AS building_name,
       b.area_id, a.name AS area_name, ${availabilitySelectSql('b')},
       ${BUILDING_PROFILE_SELECT_SQL}, ${CONTACT_SELECT_SQL}
     FROM space_types s
     ${SPACE_TYPE_JOINS_SQL}
     JOIN buildings b ON b.id = s.building_id
     JOIN areas a ON a.id = b.area_id
     ${BUILDING_PROFILE_JOINS_SQL}
     ${CONTACT_JOIN_SQL}
     WHERE s.id = ?`,
    [spaceTypeId],
  );
  const row = result.rows[0] as SpaceTypePageRow | undefined;
  if (row) assertPubliclyAvailable(row);
  if (!row || row.removed_at !== null) {
    throw notFound('Space type not found.', { code: 'SPACE_TYPE_NOT_FOUND' });
  }

  const photos = (await db('photos as p')
    .join('files as f', 'f.id', 'p.file_id')
    .where('p.space_type_id', spaceTypeId)
    .whereNull('p.removed_at')
    .orderBy('p.sort_order')
    .orderBy('p.created_at')
    .orderBy('p.id')
    .select('p.id', 'p.sort_order', 'f.public_id')) as Array<{ id: string; sort_order: number; public_id: string }>;

  const fields = toSpaceTypeFields(row);
  return {
    ...fields,
    building: { id: row.building_id, name: row.building_name, area: { id: row.area_id, name: row.area_name } },
    photos: photos.map(toPhoto),
    management: toManagement(row),
    verification: toIndicators(row),
    contact: fields.fullyLet ? null : toContact(row, viewer),
  };
}

// ---- contact events --------------------------------------------------------------------------

/**
 * FR-ENQ-004: one tap-to-call. One INSERT ... SELECT, no transaction: it checks that the building
 * is on public display and that the space type (if any) is a live one of that building in the same
 * statement. A Guest's row holds no identifier at all (`user_id` NULL; the table has no IP or
 * user-agent column and none is added). 404 when nothing was inserted.
 */
export async function recordContactEvent(
  viewer: Viewer,
  buildingId: string,
  input: ContactEventInput,
): Promise<void> {
  const result = await db.raw(
    `INSERT INTO contact_events (building_id, space_type_id, user_id)
     SELECT b.id, st.id, ?::uuid
     FROM buildings b
     LEFT JOIN space_types st ON st.id = ?::uuid AND st.building_id = b.id AND st.removed_at IS NULL
     WHERE b.id = ? AND b.status = 'published' AND ${hasActiveMaintainerSql('b')}
       AND (?::uuid IS NULL OR st.id IS NOT NULL)
     RETURNING id`,
    [viewer?.user.id ?? null, input.spaceTypeId, buildingId, input.spaceTypeId],
  );
  if (result.rows.length === 0) {
    throw notFound('Building not found.', { code: 'BUILDING_NOT_FOUND' });
  }
}
