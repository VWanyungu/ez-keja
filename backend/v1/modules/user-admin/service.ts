import { withTx } from '../../db/tx.js';
import { writeAudit } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/http-error.js';
import { keysetPage, keysetWhere } from '../../lib/keyset.js';
import type { AuthContext } from '../../middlewares/auth.js';
import type { AssignableRole, UserListQuery } from './schemas.js';

/**
 * User administration (FR-ADM-003 roles part, FR-ADM-006, NFR-AUD-01).
 *
 * Reading personal data is logged: every page of the list and every detail view writes ONE
 * `pii.view` audit row in the same transaction as the read, so no personal data is returned
 * without its log row. The row's `changes` hold field NAMES, a count and user ids only: never an
 * email, name, phone or the search text (which may itself be an email address).
 */

export interface UserListItem {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
  accountStatus: string;
  verificationStatus: string;
  lastLoginAt: Date | null;
  erasedAt: Date | null;
  createdAt: string;
}

const escapeLike = (text: string): string => text.replace(/[\\%_]/g, '\\$&');

export async function listUsers(
  auth: AuthContext,
  query: UserListQuery,
): Promise<{ items: UserListItem[]; nextCursor: string | null }> {
  return withTx(async (trx) => {
    const qb = trx('profiles as p')
      .join('auth_users as u', 'u.id', 'p.user_id')
      .select(
        'p.user_id as id',
        'u.email',
        'p.display_name',
        'p.account_status',
        'p.verification_status',
        'p.last_login_at',
        'p.erased_at',
        trx.raw('p.created_at::text AS cursor_t'),
        trx.raw("(SELECT coalesce(array_agg(r.role ORDER BY r.role), '{}') FROM user_roles r WHERE r.user_id = p.user_id) AS roles"),
      )
      .orderBy('p.created_at', 'desc')
      .orderBy('p.user_id', 'desc')
      .limit(query.limit + 1);
    if (query.q) {
      const pattern = `%${escapeLike(query.q)}%`;
      qb.whereRaw("(u.email ILIKE ? ESCAPE '\\' OR p.display_name ILIKE ? ESCAPE '\\')", [pattern, pattern]);
    }
    if (query.role) qb.whereExists(trx('user_roles as r').whereRaw('r.user_id = p.user_id').where('r.role', query.role));
    if (query.status) qb.where('p.account_status', query.status);
    if (query.verification) qb.where('p.verification_status', query.verification);
    const where = keysetWhere('p.created_at', 'p.user_id', query.cursor);
    if (where) qb.whereRaw(where[0], where[1]);

    const rows = (await qb) as Array<{
      id: string; email: string; display_name: string; roles: string[]; account_status: string;
      verification_status: string; last_login_at: Date | null; erased_at: Date | null; cursor_t: string;
    }>;
    const page = keysetPage(rows, query.limit);

    await writeAudit(trx, {
      actorUserId: auth.user.id,
      actorType: 'staff',
      action: 'pii.view',
      objectType: 'user',
      changes: {
        view: 'user_list',
        fields: ['email', 'displayName'],
        count: page.items.length,
        filters: (['q', 'role', 'status', 'verification'] as const).filter((k) => query[k] !== null),
        userIds: page.items.map((r) => r.id),
      },
    });
    return {
      nextCursor: page.nextCursor,
      items: page.items.map((r) => ({
        id: r.id,
        email: r.email,
        displayName: r.display_name,
        roles: r.roles,
        accountStatus: r.account_status,
        verificationStatus: r.verification_status,
        lastLoginAt: r.last_login_at,
        erasedAt: r.erased_at,
        createdAt: r.cursor_t,
      })),
    };
  });
}

export interface UserDetail extends Omit<UserListItem, 'createdAt'> {
  phone: string | null;
  language: string;
  agentType: string | null;
  suspendedReason: string | null;
  suspendedAt: Date | null;
  suspendedBy: string | null;
  createdAt: Date;
  buildings: Array<{ id: string; name: string; status: string; isContact: boolean }>;
}

export async function getUser(auth: AuthContext, userId: string): Promise<UserDetail> {
  return withTx(async (trx) => {
    const row = (await trx('profiles as p')
      .join('auth_users as u', 'u.id', 'p.user_id')
      .where('p.user_id', userId)
      .first(
        'p.user_id as id', 'u.email', 'p.display_name', 'p.phone', 'p.language', 'p.agent_type', 'p.account_status',
        'p.suspended_reason', 'p.suspended_at', 'p.suspended_by', 'p.verification_status', 'p.last_login_at',
        'p.erased_at', 'p.created_at',
      )) as Record<string, any> | undefined;
    if (!row) throw notFound('User not found.', { code: 'USER_NOT_FOUND' });

    const roles = (await trx('user_roles').where({ user_id: userId }).orderBy('role').pluck('role')) as string[];
    const buildings = (await trx('building_maintainers as m')
      .join('buildings as b', 'b.id', 'm.building_id')
      .where('m.user_id', userId)
      .orderBy('b.name')
      .orderBy('b.id')
      .select('b.id', 'b.name', 'b.status', trx.raw('(b.contact_user_id = m.user_id) AS is_contact'))) as Array<{
      id: string; name: string; status: string; is_contact: boolean;
    }>;

    await writeAudit(trx, {
      actorUserId: auth.user.id,
      actorType: 'staff',
      action: 'pii.view',
      objectType: 'user',
      objectId: userId,
      changes: { view: 'user_detail', fields: ['email', 'displayName', 'phone'] },
    });
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      phone: row.phone,
      language: row.language,
      agentType: row.agent_type,
      roles,
      accountStatus: row.account_status,
      suspendedReason: row.suspended_reason,
      suspendedAt: row.suspended_at,
      suspendedBy: row.suspended_by,
      verificationStatus: row.verification_status,
      lastLoginAt: row.last_login_at,
      erasedAt: row.erased_at,
      createdAt: row.created_at,
      buildings: buildings.map((b) => ({ id: b.id, name: b.name, status: b.status, isContact: Boolean(b.is_contact) })),
    };
  });
}

/** Locks the user's role rows so two role changes on one user cannot both pass a "last role" check. */
async function lockRoles(trx: import('knex').Knex.Transaction, userId: string): Promise<string[]> {
  const profile = (await trx('profiles').where({ user_id: userId }).first('erased_at')) as { erased_at: Date | null } | undefined;
  if (!profile) throw notFound('User not found.', { code: 'USER_NOT_FOUND' });
  if (profile.erased_at) throw conflict('An erased account cannot be changed.', { code: 'USER_ERASED' });
  return (await trx('user_roles').where({ user_id: userId }).orderBy('role').forUpdate().pluck('role')) as string[];
}

/** Grants `client`, `landlord` or `agent`. `admin` cannot be granted here (FR-ADM-006). */
export async function grantRole(auth: AuthContext, userId: string, role: AssignableRole): Promise<{ roles: string[] }> {
  return withTx(async (trx) => {
    const roles = await lockRoles(trx, userId);
    if (roles.includes(role)) throw conflict(`This user already has the ${role} role.`, { code: 'ROLE_ALREADY_GRANTED' });
    await trx('user_roles').insert({ user_id: userId, role, granted_by: auth.user.id });
    await writeAudit(trx, {
      actorUserId: auth.user.id,
      actorType: 'staff',
      action: 'user.role.grant',
      objectType: 'user',
      objectId: userId,
      changes: { role },
    });
    return { roles: [...roles, role].sort() };
  });
}

/** Revokes `client`, `landlord` or `agent`; a user always keeps at least one role. */
export async function revokeRole(auth: AuthContext, userId: string, role: AssignableRole): Promise<{ roles: string[] }> {
  return withTx(async (trx) => {
    const roles = await lockRoles(trx, userId);
    if (!roles.includes(role)) throw notFound(`This user does not have the ${role} role.`, { code: 'ROLE_NOT_HELD' });
    if (roles.length === 1) {
      throw conflict('A user must keep at least one role.', { code: 'LAST_ROLE' });
    }
    await trx('user_roles').where({ user_id: userId, role }).delete();
    await writeAudit(trx, {
      actorUserId: auth.user.id,
      actorType: 'staff',
      action: 'user.role.revoke',
      objectType: 'user',
      objectId: userId,
      changes: { role },
    });
    return { roles: roles.filter((r) => r !== role) };
  });
}
