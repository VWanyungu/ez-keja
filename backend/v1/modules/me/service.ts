import type { Knex } from 'knex';
import db from '../../db/knex.js';
import { badRequest, conflict } from '../../lib/http-error.js';
import { generateUuidV7 } from '../../lib/uuid.js';
import type {
  AccountStatus,
  AgentType,
  AuthContext,
  LanguageCode,
  UserRole,
  VerificationStatus,
} from '../../middlewares/auth.js';
import { recordAccountReopened } from '../verification/service.js';
import type { PatchMeInput } from './schemas.js';

export interface MePayload {
  id: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  phone: string | null;
  language: LanguageCode;
  agentType: AgentType | null;
  photoFileId: string | null;
  accountStatus: AccountStatus;
  verificationStatus: VerificationStatus;
  roles: UserRole[];
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  consent: {
    currentNoticeVersion: string | null;
    acceptedAt: Date | null;
  };
}

interface ProfileDbRow {
  user_id: string;
  display_name: string;
  phone: string | null;
  language: LanguageCode;
  agent_type: AgentType | null;
  photo_file_id: string | null;
  account_status: AccountStatus;
  verification_status: VerificationStatus;
  last_login_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface PgError {
  code?: string;
  constraint?: string;
  message?: string;
}

function toDate(val: Date | string): Date {
  return val instanceof Date ? val : new Date(val);
}

function toNullableDate(val: Date | string | null): Date | null {
  return val === null ? null : toDate(val);
}

export function getMe(authContext: AuthContext): MePayload {
  return {
    id: authContext.user.id,
    email: authContext.user.email,
    emailVerified: authContext.user.emailVerified,
    displayName: authContext.profile.displayName,
    phone: authContext.profile.phone,
    language: authContext.profile.language,
    agentType: authContext.profile.agentType,
    photoFileId: authContext.profile.photoFileId,
    accountStatus: authContext.profile.accountStatus,
    verificationStatus: authContext.profile.verificationStatus,
    roles: authContext.roles,
    lastLoginAt: authContext.profile.lastLoginAt,
    createdAt: authContext.profile.createdAt,
    updatedAt: authContext.profile.updatedAt,
    consent: {
      currentNoticeVersion: authContext.consent.currentNotice?.version ?? null,
      acceptedAt: authContext.consent.acceptedAt,
    },
  };
}

export async function updateMe(
  authContext: AuthContext,
  patch: PatchMeInput,
  conn: Knex = db,
): Promise<MePayload> {
  if (patch.agentType !== undefined && patch.agentType !== null && !authContext.roles.includes('agent')) {
    throw badRequest('Field "agentType" is only valid for accounts with the agent role.');
  }

  const userId = authContext.user.id;

  const updatedProfile = await conn.transaction(async (trx) => {
    if (patch.photoFileId !== undefined && patch.photoFileId !== null) {
      const file = await trx('files')
        .where({ id: patch.photoFileId, visibility: 'public' })
        .whereNull('purged_at')
        .first('id');
      if (!file) {
        throw badRequest('Referenced photo file was not found or is not public.');
      }
    }

    const current = (await trx('profiles')
      .where({ user_id: userId })
      .forUpdate()
      .first(
        'user_id',
        'display_name',
        'phone',
        'language',
        'agent_type',
        'photo_file_id',
        'account_status',
        'verification_status',
        'last_login_at',
        'created_at',
        'updated_at',
      )) as ProfileDbRow;

    const updates: Record<string, unknown> = {};
    const changes: Record<string, { from: unknown; to: unknown }> = {};

    if (patch.displayName !== undefined && patch.displayName !== current.display_name) {
      updates.display_name = patch.displayName;
      changes.display_name = { from: current.display_name, to: patch.displayName };
    }
    if (patch.phone !== undefined && patch.phone !== current.phone) {
      updates.phone = patch.phone;
      changes.phone = { from: current.phone, to: patch.phone };
    }
    if (patch.language !== undefined && patch.language !== current.language) {
      updates.language = patch.language;
      changes.language = { from: current.language, to: patch.language };
    }
    if (patch.agentType !== undefined && patch.agentType !== current.agent_type) {
      updates.agent_type = patch.agentType;
      changes.agent_type = { from: current.agent_type, to: patch.agentType };
    }
    if (patch.photoFileId !== undefined && patch.photoFileId !== current.photo_file_id) {
      updates.photo_file_id = patch.photoFileId;
      changes.photo_file_id = { from: current.photo_file_id, to: patch.photoFileId };
    }

    if (Object.keys(updates).length > 0) {
      try {
        await trx('profiles').where({ user_id: userId }).update(updates);
      } catch (err) {
        const pgErr = err as PgError;
        if (pgErr?.code === '23514') {
          throw conflict(
            pgErr.message || 'Profile update violates a database integrity rule.',
            { code: 'PROFILE_UPDATE_CONFLICT' },
          );
        }
        throw err;
      }

      if (updates.display_name !== undefined) {
        await trx('auth_users').where({ id: userId }).update({ name: updates.display_name });
      }

      // FR-VER-007: editing a verified identity field (display_name or phone) returns a
      // verified account to pending via verification_cases + trigger T3 (T7 guards direct writes).
      const identityFieldChanged =
        updates.display_name !== undefined || updates.phone !== undefined;
      if (current.verification_status === 'verified' && identityFieldChanged) {
        await trx('verification_cases')
          .where({
            subject_type: 'account',
            subject_user_id: userId,
            status: 'approved',
          })
          .update({ status: 'superseded' });

        const [reopened] = (await trx('verification_cases')
          .insert({
            id: generateUuidV7(),
            subject_type: 'account',
            subject_user_id: userId,
            origin: 'material_change',
            status: 'pending',
            submitted_at: trx.raw('clock_timestamp()'),
          })
          .returning('id')) as Array<{ id: string }>;
        // N-03 to every Admin, plus the audit row (FR-VER-007).
        await recordAccountReopened(trx, {
          userId,
          caseId: reopened!.id,
          changed: ['display_name', 'phone'].filter((field) => field in updates),
        });
      }

      await trx('audit_log').insert({
        id: generateUuidV7(),
        actor_user_id: userId,
        actor_type: 'user',
        action: 'profile.update',
        object_type: 'profile',
        object_id: userId,
        changes: JSON.stringify(changes),
      });
    }

    return (await trx('profiles')
      .where({ user_id: userId })
      .first(
        'user_id',
        'display_name',
        'phone',
        'language',
        'agent_type',
        'photo_file_id',
        'account_status',
        'verification_status',
        'last_login_at',
        'created_at',
        'updated_at',
      )) as ProfileDbRow;
  });

  return {
    id: authContext.user.id,
    email: authContext.user.email,
    emailVerified: authContext.user.emailVerified,
    displayName: updatedProfile.display_name,
    phone: updatedProfile.phone,
    language: updatedProfile.language,
    agentType: updatedProfile.agent_type,
    photoFileId: updatedProfile.photo_file_id,
    accountStatus: updatedProfile.account_status,
    verificationStatus: updatedProfile.verification_status,
    roles: authContext.roles,
    lastLoginAt: toNullableDate(updatedProfile.last_login_at),
    createdAt: toDate(updatedProfile.created_at),
    updatedAt: toDate(updatedProfile.updated_at),
    consent: {
      currentNoticeVersion: authContext.consent.currentNotice?.version ?? null,
      acceptedAt: authContext.consent.acceptedAt,
    },
  };
}
