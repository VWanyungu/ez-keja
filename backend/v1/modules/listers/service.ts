import db from '../../db/knex.js';
import { notFound } from '../../lib/http-error.js';
import { gatePhone, photoUrls, type PhotoUrls } from '../../lib/public-catalogue.js';
import type { AuthContext } from '../../middlewares/auth.js';

export interface ListerProfile {
  userId: string;
  displayName: string;
  photo: PhotoUrls | null;
  /** 'agent' or 'caretaker' for an Agent account, otherwise null. */
  agentType: string | null;
  /** FR-VER-005: the account indicator. */
  accountVerification: string;
  /** Published buildings this lister maintains. */
  publishedBuildings: number;
  /** BR-009: null for a Guest, with `phoneRequiresLogin` set. */
  phone: string | null;
  phoneRequiresLogin: boolean;
}

/**
 * FR-ACC-004: a Landlord or Agent's public profile. A suspended or erased account, or one that is
 * not a lister, is a plain 404, the same as an unknown id. The buildings only a hidden lister
 * maintains are hidden by `hasActiveMaintainerSql` wherever buildings are listed.
 */
export async function getLister(
  viewer: Pick<AuthContext, 'user'> | undefined,
  userId: string,
): Promise<ListerProfile> {
  const profile = (await db('profiles as p')
    .leftJoin('files as f', function joinPhoto() {
      this.on('f.id', 'p.photo_file_id').andOn('f.visibility', db.raw('?', ['public']));
    })
    .where('p.user_id', userId)
    .where('p.account_status', 'active')
    .whereNull('p.erased_at')
    .whereExists(db('user_roles as r').whereRaw('r.user_id = p.user_id').whereIn('r.role', ['landlord', 'agent']))
    .first('p.display_name', 'p.phone', 'p.agent_type', 'p.verification_status', 'f.public_id')) as
    | {
        display_name: string;
        phone: string | null;
        agent_type: string | null;
        verification_status: string;
        public_id: string | null;
      }
    | undefined;
  if (!profile) throw notFound('Lister not found.', { code: 'LISTER_NOT_FOUND' });

  const counted = (await db('building_maintainers as m')
    .join('buildings as b', 'b.id', 'm.building_id')
    .where('m.user_id', userId)
    .where('b.status', 'published')
    .count({ n: '*' })
    .first()) as { n: string | number } | undefined;

  return {
    userId,
    displayName: profile.display_name,
    photo: profile.public_id ? photoUrls(profile.public_id) : null,
    agentType: profile.agent_type,
    accountVerification: profile.verification_status,
    publishedBuildings: Number(counted?.n ?? 0),
    ...gatePhone(viewer, profile.phone),
  };
}
