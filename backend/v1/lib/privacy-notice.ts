import type { Knex } from 'knex';
import db from '../db/knex.js';

export interface PrivacyNoticeVersion {
  id: string;
  version: string;
  effectiveAt: Date;
}

interface PrivacyNoticeRow {
  id: string;
  version: string;
  effective_at: Date | string;
}

function mapNotice(row: PrivacyNoticeRow): PrivacyNoticeVersion {
  return {
    id: row.id,
    version: row.version,
    effectiveAt: row.effective_at instanceof Date ? row.effective_at : new Date(row.effective_at),
  };
}

/**
 * Returns the latest active privacy notice version (effective_at <= now()).
 * Falls back to the latest seeded notice version if none has reached effective_at yet,
 * matching 06_dev_admin.ts when only the initial placeholder notice is present.
 */
export async function getCurrentPrivacyNotice(
  conn: Knex | Knex.Transaction = db,
): Promise<PrivacyNoticeVersion | null> {
  const effective = (await conn('privacy_notice_versions')
    .where('effective_at', '<=', conn.fn.now())
    .orderBy('effective_at', 'desc')
    .orderBy('created_at', 'desc')
    .first('id', 'version', 'effective_at')) as PrivacyNoticeRow | undefined;

  if (effective) {
    return mapNotice(effective);
  }

  const fallback = (await conn('privacy_notice_versions')
    .orderBy('effective_at', 'desc')
    .orderBy('created_at', 'desc')
    .first('id', 'version', 'effective_at')) as PrivacyNoticeRow | undefined;

  return fallback ? mapNotice(fallback) : null;
}
