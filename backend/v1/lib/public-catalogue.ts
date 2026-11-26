/**
 * What the public (Guest and logged-in) catalogue may show, in one place: which buildings are on
 * display, the unavailable answers, photo URLs, the management designation and phone masking.
 * Search, the two public pages, lister profiles, contact events and commute all use it so the
 * rules cannot drift apart (BR-002, BR-009, FR-ACC-004, FR-VER-005, FR-SRC-007, FR-SRC-008).
 */
import { getCloudinary } from './cloudinary.js';
import { HttpError, notFound } from './http-error.js';
import type { AuthContext } from '../middlewares/auth.js';

export const BUILDING_UNAVAILABLE = 'BUILDING_UNAVAILABLE';

const SAFE_ALIAS = /^[a-z_][a-z0-9_]*$/i;
const alias = (value: string): string => {
  if (!SAFE_ALIAS.test(value)) throw new Error(`Unsafe SQL alias: ${value}`);
  return value;
};

/**
 * FR-ACC-004: a suspended or erased lister is hidden, and so is a building only they maintain. So a
 * building is on display only while at least one of its maintainers is active and not erased.
 */
export function hasActiveMaintainerSql(buildingAlias: string): string {
  const b = alias(buildingAlias);
  return `EXISTS (SELECT 1 FROM building_maintainers m JOIN profiles mp ON mp.user_id = m.user_id
    WHERE m.building_id = ${b}.id AND mp.account_status = 'active' AND mp.erased_at IS NULL)`;
}

/** The columns `assertPubliclyAvailable` needs, for any query that selects from `buildings`. */
export const availabilitySelectSql = (buildingAlias = 'b'): string => {
  const b = alias(buildingAlias);
  return `${b}.status, ${b}.status_before_suspension, ${b}.published_at,
    ${hasActiveMaintainerSql(b)} AS has_active_maintainer`;
};

export interface AvailabilityRow {
  status: string;
  status_before_suspension: string | null;
  published_at: Date | null;
  has_active_maintainer: boolean;
}

/**
 * The answer for a building a visitor may not see.
 *  - unknown, draft, pending, or suspended/withdrawn without ever having been public: 404, the same
 *    as a building that does not exist, so a stranger cannot probe for unpublished buildings;
 *  - was public and is now Suspended, Withdrawn, or Published with no active maintainer left:
 *    410 `BUILDING_UNAVAILABLE`, which the client renders as the "no longer available" notice.
 */
export function assertPubliclyAvailable(row: AvailabilityRow | undefined): void {
  const gone = () =>
    new HttpError(410, 'This building is no longer available.', { code: BUILDING_UNAVAILABLE });
  if (!row) throw notFound('Building not found.', { code: 'BUILDING_NOT_FOUND' });
  switch (row.status) {
    case 'published':
      if (!row.has_active_maintainer) throw gone();
      return;
    case 'suspended':
      if (row.status_before_suspension === 'published') throw gone();
      break;
    case 'withdrawn':
      if (row.published_at !== null) throw gone();
      break;
    default:
  }
  throw notFound('Building not found.', { code: 'BUILDING_NOT_FOUND' });
}

export interface PhotoUrls {
  thumb: string;
  medium: string;
  full: string;
}

/** NFR-PRF-02: three delivery sizes (thumb 320, medium 800, full) from the public Cloudinary id. */
export function photoUrls(publicId: string): PhotoUrls {
  const storage = getCloudinary();
  return {
    thumb: storage.publicUrl(publicId, 320),
    medium: storage.publicUrl(publicId, 800),
    full: storage.publicUrl(publicId),
  };
}

/** BR-009: only a request with a valid session sees a phone number. */
export function gatePhone(
  auth: Pick<AuthContext, 'user'> | undefined,
  phone: string | null,
): { phone: string | null; phoneRequiresLogin: boolean } {
  if (auth) return { phone, phoneRequiresLogin: false };
  return { phone: null, phoneRequiresLogin: phone !== null };
}

// ---- management designation and verification indicators --------------------------------------

/**
 * Joins for the shared building columns. Needs `buildings b`. The designated agent and landlord
 * show only while their account is active (a suspended or erased one is hidden, FR-ACC-004);
 * `lp` is the lister's profile, source of the account verification indicator.
 */
export const BUILDING_PROFILE_JOINS_SQL = `
  LEFT JOIN profiles pa ON pa.user_id = b.managing_agent_id AND pa.account_status = 'active' AND pa.erased_at IS NULL
  LEFT JOIN profiles pl ON pl.user_id = b.landlord_user_id AND pl.account_status = 'active' AND pl.erased_at IS NULL
  JOIN profiles lp ON lp.user_id = b.lister_id`;

export const BUILDING_PROFILE_SELECT_SQL = `
  b.management_type, b.landlord_name, pa.user_id AS agent_user_id, pa.display_name AS agent_name,
  pl.user_id AS landlord_user_id, pl.display_name AS landlord_profile_name,
  lp.verification_status AS account_verification, b.verification_status AS building_verification`;

export interface BuildingProfileRow {
  management_type: 'agent' | 'landlord';
  landlord_name: string | null;
  agent_user_id: string | null;
  agent_name: string | null;
  landlord_user_id: string | null;
  landlord_profile_name: string | null;
  account_verification: string;
  building_verification: string;
}

export interface ManagementDesignation {
  type: 'agent' | 'landlord';
  /** Null when the designated agent's account is not active. */
  name: string | null;
  /** The lister profile to link to, or null when there is none to show. */
  profileUserId: string | null;
}

/** FR-VER-005: the lister's account and the building are two separate indicators. */
export interface VerificationIndicators {
  account: string;
  building: string;
}

export function toManagement(row: BuildingProfileRow): ManagementDesignation {
  return row.management_type === 'agent'
    ? { type: 'agent', name: row.agent_name, profileUserId: row.agent_user_id }
    : {
        type: 'landlord',
        name: row.landlord_profile_name ?? row.landlord_name,
        profileUserId: row.landlord_user_id,
      };
}

export const toIndicators = (row: BuildingProfileRow): VerificationIndicators => ({
  account: row.account_verification,
  building: row.building_verification,
});

export const toNumber = (value: string | number | null): number | null =>
  value === null ? null : Number(value);
