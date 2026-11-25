import { randomBytes } from 'node:crypto';
import type { Knex } from 'knex';
import db from '../../db/knex.js';
import { conflict, notFound } from '../../lib/http-error.js';
import { sendAdminInviteEmail } from '../../lib/mailer.js';
import { generateUuidV7 } from '../../lib/uuid.js';
import { hashInviteToken } from '../auth/service.js';
import type { CreateAdminInviteInput } from './schemas.js';

export type AdminInviteStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export interface AdminInviteSummary {
  id: string;
  email: string;
  displayName: string;
  invitedBy: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedUserId: string | null;
  revokedAt: Date | null;
  revokedBy: string | null;
  createdAt: Date;
  status: AdminInviteStatus;
}

export interface CreatedAdminInviteResult {
  invite: AdminInviteSummary;
  token: string;
}

export interface AdminInviteDeps {
  db?: Knex;
  sendInviteEmail?: (payload: {
    email: string;
    displayName: string;
    token: string;
    expiresAt: Date;
    invitedBy: string;
  }) => Promise<void>;
}

interface AdminInviteDbRow {
  id: string;
  email: string;
  display_name: string;
  invited_by: string;
  expires_at: Date | string;
  accepted_at: Date | string | null;
  accepted_user_id: string | null;
  revoked_at: Date | string | null;
  revoked_by: string | null;
  created_at: Date | string;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toNullableDate(value: Date | string | null): Date | null {
  return value === null ? null : toDate(value);
}

function computeStatus(row: AdminInviteDbRow): AdminInviteStatus {
  if (row.accepted_at !== null) return 'accepted';
  if (row.revoked_at !== null) return 'revoked';
  if (toDate(row.expires_at).getTime() <= Date.now()) return 'expired';
  return 'pending';
}

function mapInviteRow(row: AdminInviteDbRow): AdminInviteSummary {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    invitedBy: row.invited_by,
    expiresAt: toDate(row.expires_at),
    acceptedAt: toNullableDate(row.accepted_at),
    acceptedUserId: row.accepted_user_id,
    revokedAt: toNullableDate(row.revoked_at),
    revokedBy: row.revoked_by,
    createdAt: toDate(row.created_at),
    status: computeStatus(row),
  };
}

export async function createAdminInvite(
  adminUserId: string,
  input: CreateAdminInviteInput,
  deps: AdminInviteDeps = {},
): Promise<CreatedAdminInviteResult> {
  const conn = deps.db ?? db;
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashInviteToken(token);
  const expiresAt = new Date(Date.now() + input.expiresInHours * 3_600_000);

  const invite = await conn.transaction(async (trx) => {
    const existingUser = await trx('auth_users').where({ email: input.email }).first('id');
    if (existingUser) {
      throw conflict('An account with this email already exists.', {
        code: 'EMAIL_ALREADY_REGISTERED',
      });
    }

    const existingPending = (await trx('admin_invites')
      .where({ email: input.email })
      .whereNull('accepted_at')
      .whereNull('revoked_at')
      .forUpdate()
      .first('id', 'expires_at')) as { id: string; expires_at: Date | string } | undefined;

    if (existingPending) {
      if (toDate(existingPending.expires_at).getTime() > Date.now()) {
        throw conflict('A pending invite already exists for this email.', {
          code: 'INVITE_ALREADY_PENDING',
        });
      }
      await trx('admin_invites')
        .where({ id: existingPending.id })
        .update({
          revoked_at: trx.fn.now(),
          revoked_by: adminUserId,
        });
    }

    const inviteId = generateUuidV7();
    const [inserted] = (await trx('admin_invites')
      .insert({
        id: inviteId,
        email: input.email,
        display_name: input.displayName,
        token_hash: tokenHash,
        invited_by: adminUserId,
        expires_at: expiresAt,
      })
      .returning([
        'id',
        'email',
        'display_name',
        'invited_by',
        'expires_at',
        'accepted_at',
        'accepted_user_id',
        'revoked_at',
        'revoked_by',
        'created_at',
      ])) as AdminInviteDbRow[];

    await trx('audit_log').insert({
      id: generateUuidV7(),
      actor_user_id: adminUserId,
      actor_type: 'staff',
      action: 'admin_invite.create',
      object_type: 'admin_invite',
      object_id: inviteId,
      changes: JSON.stringify({
        email: input.email,
        display_name: input.displayName,
        expires_at: expiresAt.toISOString(),
      }),
    });

    return mapInviteRow(inserted!);
  });

  if (deps.sendInviteEmail) {
    await deps.sendInviteEmail({
      email: invite.email,
      displayName: invite.displayName,
      token,
      expiresAt: invite.expiresAt,
      invitedBy: adminUserId,
    });
  } else {
    const frontendBase = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
    const inviteUrl = `${frontendBase}/admin-invite?token=${encodeURIComponent(token)}`;
    await sendAdminInviteEmail({
      to: invite.email,
      displayName: invite.displayName,
      inviteUrl,
      expiresAt: invite.expiresAt,
      inviteId: invite.id,
    });
  }

  return { invite, token };
}

export async function listAdminInvites(conn: Knex = db): Promise<AdminInviteSummary[]> {
  const rows = (await conn('admin_invites')
    .select(
      'id',
      'email',
      'display_name',
      'invited_by',
      'expires_at',
      'accepted_at',
      'accepted_user_id',
      'revoked_at',
      'revoked_by',
      'created_at',
    )
    .orderBy('created_at', 'desc')) as AdminInviteDbRow[];

  return rows.map(mapInviteRow);
}

export async function revokeAdminInvite(
  adminUserId: string,
  inviteId: string,
  conn: Knex = db,
): Promise<AdminInviteSummary> {
  return conn.transaction(async (trx) => {
    const row = (await trx('admin_invites')
      .where({ id: inviteId })
      .forUpdate()
      .first(
        'id',
        'email',
        'display_name',
        'invited_by',
        'expires_at',
        'accepted_at',
        'accepted_user_id',
        'revoked_at',
        'revoked_by',
        'created_at',
      )) as AdminInviteDbRow | undefined;

    if (!row) {
      throw notFound('Invite not found.', { code: 'INVITE_NOT_FOUND' });
    }
    if (row.accepted_at !== null) {
      throw conflict('Accepted invite cannot be revoked.', { code: 'INVITE_ALREADY_ACCEPTED' });
    }
    if (row.revoked_at !== null) {
      throw conflict('Invite is already revoked.', { code: 'INVITE_ALREADY_REVOKED' });
    }

    const [updated] = (await trx('admin_invites')
      .where({ id: inviteId })
      .update({
        revoked_at: trx.fn.now(),
        revoked_by: adminUserId,
      })
      .returning([
        'id',
        'email',
        'display_name',
        'invited_by',
        'expires_at',
        'accepted_at',
        'accepted_user_id',
        'revoked_at',
        'revoked_by',
        'created_at',
      ])) as AdminInviteDbRow[];

    await trx('audit_log').insert({
      id: generateUuidV7(),
      actor_user_id: adminUserId,
      actor_type: 'staff',
      action: 'admin_invite.revoke',
      object_type: 'admin_invite',
      object_id: inviteId,
      changes: JSON.stringify({ email: row.email }),
    });

    return mapInviteRow(updated!);
  });
}
