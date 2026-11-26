import { badRequest } from '../../lib/http-error.js';
import { parseKeysetQuery, type KeysetQuery } from '../../lib/keyset.js';
import { asRecord, rejectUnknownFields } from '../../lib/validation.js';
import type { AccountStatus, UserRole, VerificationStatus } from '../../middlewares/auth.js';

/** FR-ADM-006: `admin` comes only from an invite, so it is never granted or revoked here. */
export const ASSIGNABLE_ROLES = ['client', 'landlord', 'agent'] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

const ALL_ROLES: readonly UserRole[] = ['client', 'landlord', 'agent', 'admin'];
const STATUSES: readonly AccountStatus[] = ['active', 'suspended'];
const VERIFICATION: readonly VerificationStatus[] = ['unverified', 'pending', 'verified', 'rejected', 'revoked'];

export interface UserListQuery extends KeysetQuery {
  q: string | null;
  role: UserRole | null;
  status: AccountStatus | null;
  verification: VerificationStatus | null;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T | null {
  if (value === undefined) return null;
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  throw badRequest(`Query "${name}" must be one of: ${allowed.join(', ')}.`);
}

export function parseUserListQuery(query: Record<string, unknown>): UserListQuery {
  let q: string | null = null;
  if (query.q !== undefined) {
    const text = typeof query.q === 'string' ? query.q.trim() : '';
    if (text.length < 1 || text.length > 100) throw badRequest('Query "q" must be 1 to 100 characters.');
    q = text;
  }
  return {
    ...parseKeysetQuery(query),
    q,
    role: oneOf(query.role, ALL_ROLES, 'role'),
    status: oneOf(query.status, STATUSES, 'status'),
    verification: oneOf(query.verification, VERIFICATION, 'verification'),
  };
}

const adminRoleRefusal = () =>
  badRequest('The admin role is never granted or revoked here: Admin accounts come only from invites (FR-ADM-006).', {
    code: 'ADMIN_ROLE_NOT_ASSIGNABLE',
  });

export function parseRole(value: unknown): AssignableRole {
  if (value === 'admin') throw adminRoleRefusal();
  if (typeof value === 'string' && (ASSIGNABLE_ROLES as readonly string[]).includes(value)) return value as AssignableRole;
  throw badRequest(`Field "role" must be one of: ${ASSIGNABLE_ROLES.join(', ')}.`);
}

export function parseGrantRoleBody(raw: unknown): { role: AssignableRole } {
  const body = asRecord(raw);
  rejectUnknownFields(body, ['role']);
  return { role: parseRole(body.role) };
}
