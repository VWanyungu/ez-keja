import type { Knex } from 'knex';
import { generateUuidV7 } from './uuid.js';

export interface AuditEntry {
  actorUserId: string | null;
  /** 'staff' marks an Admin acting on behalf of users (FR-ADM-001). */
  actorType: 'user' | 'staff' | 'system';
  action: string;
  objectType: string;
  objectId?: string | null;
  buildingId?: string | null;
  changes?: Record<string, unknown>;
}

/** Append one audit_log row. Pass the transaction so the audit row commits with the change. */
export async function writeAudit(conn: Knex | Knex.Transaction, entry: AuditEntry): Promise<void> {
  await conn('audit_log').insert({
    id: generateUuidV7(),
    actor_user_id: entry.actorUserId,
    actor_type: entry.actorType,
    action: entry.action,
    object_type: entry.objectType,
    object_id: entry.objectId ?? null,
    building_id: entry.buildingId ?? null,
    changes: JSON.stringify(entry.changes ?? {}),
  });
}
