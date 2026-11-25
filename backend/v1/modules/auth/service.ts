import { createHash } from 'node:crypto';
import { hashPassword as betterAuthHashPassword } from 'better-auth/crypto';
import type { Knex } from 'knex';
import db from '../../db/knex.js';
import {
  badRequest,
  conflict,
  notFound,
  serviceUnavailable,
} from '../../lib/http-error.js';
import { getCurrentPrivacyNotice, type PrivacyNoticeVersion } from '../../lib/privacy-notice.js';
import {
  issueTokenPair,
  type TokenPair,
  type TokenRequestMeta,
} from '../../lib/tokens.js';
import { generateUuidV7 } from '../../lib/uuid.js';
import {
  defaultLoadAccountSnapshot,
  type AccountStatus,
  type AgentType,
  type LanguageCode,
  type UserRole,
  type VerificationStatus,
} from '../../middlewares/auth.js';
import type {
  AcceptAdminInviteInput,
  AcceptConsentInput,
  RegisterInput,
} from './schemas.js';

export interface RegisteredAccountResult {
  user: {
    id: string;
    email: string;
    name: string;
    emailVerified: boolean;
  };
  profile: {
    userId: string;
    displayName: string;
    phone: string | null;
    language: LanguageCode;
    agentType: AgentType | null;
    accountStatus: AccountStatus;
    verificationStatus: VerificationStatus;
  };
  roles: UserRole[];
  consent: {
    noticeVersionId: string;
    noticeVersion: string;
    acceptedAt: Date | null;
    requiresReconsent?: boolean;
  };
}

export interface AuthenticatedAccountResult extends RegisteredAccountResult {
  tokens: TokenPair;
}

export interface ConsentRecordResult {
  userId: string;
  noticeVersionId: string;
  noticeVersion: string;
  acceptedAt: Date;
}

export interface AdminInvitePreview {
  email: string;
  displayName: string;
  expiresAt: Date;
  privacyNotice: PrivacyNoticeVersion | null;
}

export interface AuthServiceDeps {
  db?: Knex;
  hashPassword?: (password: string) => Promise<string>;
}

interface PgError {
  code?: string;
  constraint?: string;
}

function isPgUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as PgError).code === '23505';
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

async function resolveAndValidateNotice(
  trx: Knex.Transaction,
  expectedVersion?: string,
): Promise<PrivacyNoticeVersion> {
  const notice = await getCurrentPrivacyNotice(trx);
  if (!notice) {
    throw serviceUnavailable('No privacy notice version is configured.');
  }
  if (expectedVersion !== undefined && expectedVersion !== notice.version) {
    throw badRequest('Accepted privacy notice version does not match the current notice.', {
      code: 'PRIVACY_NOTICE_VERSION_MISMATCH',
      data: { currentNotice: notice },
    });
  }
  return notice;
}

export async function registerAccount(
  input: RegisterInput,
  deps: AuthServiceDeps = {},
): Promise<RegisteredAccountResult> {
  const conn = deps.db ?? db;
  const hashFn = deps.hashPassword ?? betterAuthHashPassword;
  const passwordHash = await hashFn(input.password);

  return conn.transaction(async (trx) => {
    const notice = await resolveAndValidateNotice(trx, input.privacyNoticeVersion);

    const userId = generateUuidV7();
    const roles: UserRole[] =
      input.role === 'client' ? ['client'] : ['client', input.role];

    try {
      await trx('auth_users').insert({
        id: userId,
        name: input.displayName,
        email: input.email,
        email_verified: false,
      });
    } catch (err) {
      if (isPgUniqueViolation(err)) {
        // FR-ACC-001: refuse duplicate registration without revealing account details.
        throw conflict('Unable to complete registration with the provided details.', {
          code: 'REGISTRATION_FAILED',
        });
      }
      throw err;
    }

    await trx('auth_accounts').insert({
      id: generateUuidV7(),
      account_id: userId,
      provider_id: 'credential',
      user_id: userId,
      password: passwordHash,
    });

    await trx('profiles').insert({
      user_id: userId,
      display_name: input.displayName,
      phone: input.phone,
      language: input.language,
      agent_type: input.agentType,
    });

    await trx('user_roles').insert(
      roles.map((role) => ({
        id: generateUuidV7(),
        user_id: userId,
        role,
      })),
    );

    const [consentRow] = (await trx('consent_records')
      .insert({
        id: generateUuidV7(),
        user_id: userId,
        notice_version_id: notice.id,
      })
      .returning(['accepted_at'])) as Array<{ accepted_at: Date | string }>;

    await trx('audit_log').insert({
      id: generateUuidV7(),
      actor_user_id: userId,
      actor_type: 'user',
      action: 'account.register',
      object_type: 'user',
      object_id: userId,
      changes: JSON.stringify({
        roles,
        language: input.language,
        notice_version: notice.version,
      }),
    });

    return {
      user: {
        id: userId,
        email: input.email,
        name: input.displayName,
        emailVerified: false,
      },
      profile: {
        userId,
        displayName: input.displayName,
        phone: input.phone,
        language: input.language,
        agentType: input.agentType,
        accountStatus: 'active',
        verificationStatus: 'unverified',
      },
      roles,
      consent: {
        noticeVersionId: notice.id,
        noticeVersion: notice.version,
        acceptedAt: toDate(consentRow!.accepted_at),
      },
    };
  });
}

export async function getActivePrivacyNotice(
  conn: Knex = db,
): Promise<PrivacyNoticeVersion> {
  const notice = await getCurrentPrivacyNotice(conn);
  if (!notice) {
    throw serviceUnavailable('No privacy notice version is configured.');
  }
  return notice;
}

export async function recordUserConsent(
  userId: string,
  input: AcceptConsentInput,
  conn: Knex = db,
): Promise<ConsentRecordResult> {
  return conn.transaction(async (trx) => {
    const notice = await resolveAndValidateNotice(trx, input.version);

    await trx('consent_records')
      .insert({
        id: generateUuidV7(),
        user_id: userId,
        notice_version_id: notice.id,
      })
      .onConflict(['user_id', 'notice_version_id'])
      .ignore();

    const row = (await trx('consent_records')
      .where({ user_id: userId, notice_version_id: notice.id })
      .first('accepted_at')) as { accepted_at: Date | string };

    return {
      userId,
      noticeVersionId: notice.id,
      noticeVersion: notice.version,
      acceptedAt: toDate(row.accepted_at),
    };
  });
}

export async function loadAuthenticatedAccount(
  userId: string,
  conn: Knex = db,
): Promise<RegisteredAccountResult> {
  const [userRow, snapshot] = await Promise.all([
    conn('auth_users')
      .where({ id: userId })
      .first('id', 'email', 'name', 'email_verified') as Promise<
      { id: string; email: string; name: string; email_verified: boolean } | undefined
    >,
    defaultLoadAccountSnapshot(userId),
  ]);

  if (!userRow || !snapshot.profile) {
    throw notFound('Account not found.');
  }

  return {
    user: {
      id: userRow.id,
      email: userRow.email,
      name: userRow.name,
      emailVerified: userRow.email_verified,
    },
    profile: {
      userId: snapshot.profile.userId,
      displayName: snapshot.profile.displayName,
      phone: snapshot.profile.phone,
      language: snapshot.profile.language,
      agentType: snapshot.profile.agentType,
      accountStatus: snapshot.profile.accountStatus,
      verificationStatus: snapshot.profile.verificationStatus,
    },
    roles: snapshot.roles,
    consent: {
      noticeVersionId: snapshot.consent.currentNotice?.id ?? '',
      noticeVersion: snapshot.consent.currentNotice?.version ?? '',
      acceptedAt: snapshot.consent.acceptedAt,
      requiresReconsent: snapshot.consent.requiresReconsent,
    },
  };
}

export async function issueTokensForSessionToken(
  userId: string,
  sessionToken: string,
  meta: TokenRequestMeta = {},
  conn: Knex = db,
): Promise<TokenPair> {
  const sessionRow = (await conn('auth_sessions')
    .where({ token: sessionToken, user_id: userId })
    .first('id')) as { id: string } | undefined;

  if (!sessionRow) {
    throw serviceUnavailable('Created session could not be located.');
  }

  return issueTokenPair(
    {
      userId,
      sessionId: sessionRow.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    },
    conn,
  );
}

interface AdminInviteRow {
  id: string;
  email: string;
  display_name: string;
  invited_by: string;
  expires_at: Date | string;
  accepted_at: Date | string | null;
  revoked_at: Date | string | null;
}

function assertInviteUsable(invite: AdminInviteRow | undefined): asserts invite is AdminInviteRow {
  if (!invite) {
    throw notFound('Invite token is invalid.', { code: 'INVITE_NOT_FOUND' });
  }
  if (invite.revoked_at !== null) {
    throw badRequest('This invite has been revoked.', { code: 'INVITE_REVOKED' });
  }
  if (invite.accepted_at !== null) {
    throw conflict('This invite has already been accepted.', { code: 'INVITE_ALREADY_ACCEPTED' });
  }
  if (toDate(invite.expires_at).getTime() <= Date.now()) {
    throw badRequest('This invite has expired.', { code: 'INVITE_EXPIRED' });
  }
}

export async function getAdminInvitePreview(
  token: string,
  conn: Knex = db,
): Promise<AdminInvitePreview> {
  const tokenHash = hashInviteToken(token);
  const invite = (await conn('admin_invites')
    .where({ token_hash: tokenHash })
    .first('id', 'email', 'display_name', 'invited_by', 'expires_at', 'accepted_at', 'revoked_at')) as
    | AdminInviteRow
    | undefined;

  assertInviteUsable(invite);

  const privacyNotice = await getCurrentPrivacyNotice(conn);
  return {
    email: invite.email,
    displayName: invite.display_name,
    expiresAt: toDate(invite.expires_at),
    privacyNotice,
  };
}

export async function acceptAdminInvite(
  input: AcceptAdminInviteInput,
  deps: AuthServiceDeps = {},
): Promise<RegisteredAccountResult> {
  const conn = deps.db ?? db;
  const hashFn = deps.hashPassword ?? betterAuthHashPassword;
  const tokenHash = hashInviteToken(input.token);
  const passwordHash = await hashFn(input.password);

  return conn.transaction(async (trx) => {
    const invite = (await trx('admin_invites')
      .where({ token_hash: tokenHash })
      .forUpdate()
      .first('id', 'email', 'display_name', 'invited_by', 'expires_at', 'accepted_at', 'revoked_at')) as
      | AdminInviteRow
      | undefined;

    assertInviteUsable(invite);

    const notice = await resolveAndValidateNotice(trx, input.privacyNoticeVersion);
    const displayName = input.displayName ?? invite.display_name;
    const userId = generateUuidV7();

    try {
      await trx('auth_users').insert({
        id: userId,
        name: displayName,
        email: invite.email,
        email_verified: true,
      });
    } catch (err) {
      if (isPgUniqueViolation(err)) {
        throw conflict('An account with this email already exists.', {
          code: 'EMAIL_ALREADY_REGISTERED',
        });
      }
      throw err;
    }

    await trx('auth_accounts').insert({
      id: generateUuidV7(),
      account_id: userId,
      provider_id: 'credential',
      user_id: userId,
      password: passwordHash,
    });

    await trx('profiles').insert({
      user_id: userId,
      display_name: displayName,
      phone: input.phone,
      language: input.language,
    });

    await trx('user_roles').insert({
      id: generateUuidV7(),
      user_id: userId,
      role: 'admin',
      granted_by: invite.invited_by,
    });

    const [consentRow] = (await trx('consent_records')
      .insert({
        id: generateUuidV7(),
        user_id: userId,
        notice_version_id: notice.id,
      })
      .returning(['accepted_at'])) as Array<{ accepted_at: Date | string }>;

    await trx('admin_invites')
      .where({ id: invite.id })
      .update({
        accepted_at: trx.fn.now(),
        accepted_user_id: userId,
      });

    await trx('audit_log').insert({
      id: generateUuidV7(),
      actor_user_id: userId,
      actor_type: 'staff',
      action: 'admin_invite.accept',
      object_type: 'user',
      object_id: userId,
      changes: JSON.stringify({
        invite_id: invite.id,
        granted_by: invite.invited_by,
        role: 'admin',
        notice_version: notice.version,
      }),
    });

    return {
      user: {
        id: userId,
        email: invite.email,
        name: displayName,
        emailVerified: true,
      },
      profile: {
        userId,
        displayName,
        phone: input.phone,
        language: input.language,
        agentType: null,
        accountStatus: 'active',
        verificationStatus: 'unverified',
      },
      roles: ['admin'],
      consent: {
        noticeVersionId: notice.id,
        noticeVersion: notice.version,
        acceptedAt: toDate(consentRow!.accepted_at),
      },
    };
  });
}
