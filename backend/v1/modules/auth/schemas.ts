import { badRequest } from '../../lib/http-error.js';
import {
  asRecord,
  parseDisplayName,
  parseLanguage,
  parseOptionalPhone,
  parseRequiredEmail,
  parseRequiredPassword,
  rejectUnknownFields,
} from '../../lib/validation.js';
import type { AgentType, LanguageCode } from '../../middlewares/auth.js';

export type RegisterRole = 'client' | 'landlord' | 'agent';

export interface RegisterInput {
  email: string;
  password: string;
  displayName: string;
  phone: string | null;
  language: LanguageCode;
  role: RegisterRole;
  agentType: AgentType | null;
  privacyNoticeAccepted: true;
  privacyNoticeVersion?: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface ForgotPasswordInput {
  email: string;
  redirectTo?: string;
}

export interface ResetPasswordInput {
  token: string;
  newPassword: string;
}

export interface RefreshTokenInput {
  refreshToken: string;
}

export interface AcceptConsentInput {
  accepted: true;
  version?: string;
}

export interface AcceptAdminInviteInput {
  token: string;
  password: string;
  displayName?: string;
  phone: string | null;
  language: LanguageCode;
  privacyNoticeAccepted: true;
  privacyNoticeVersion?: string;
}

const REGISTER_FIELDS = [
  'email',
  'password',
  'displayName',
  'name',
  'phone',
  'language',
  'role',
  'agentType',
  'privacyNoticeAccepted',
  'privacyNoticeVersion',
] as const;

const LOGIN_FIELDS = ['email', 'password'] as const;
const FORGOT_PASSWORD_FIELDS = ['email', 'redirectTo'] as const;
const RESET_PASSWORD_FIELDS = ['token', 'newPassword'] as const;
const REFRESH_FIELDS = ['refreshToken'] as const;
const CONSENT_FIELDS = ['accepted', 'version'] as const;

const ACCEPT_INVITE_FIELDS = [
  'token',
  'password',
  'displayName',
  'phone',
  'language',
  'privacyNoticeAccepted',
  'privacyNoticeVersion',
] as const;

function parsePrivacyNoticeAcceptance(obj: Record<string, unknown>): {
  privacyNoticeAccepted: true;
  privacyNoticeVersion?: string;
} {
  if (obj.privacyNoticeAccepted !== true) {
    throw badRequest('Privacy notice must be accepted to complete registration.', {
      code: 'PRIVACY_NOTICE_REQUIRED',
    });
  }
  let privacyNoticeVersion: string | undefined;
  if (obj.privacyNoticeVersion !== undefined) {
    if (typeof obj.privacyNoticeVersion !== 'string' || !obj.privacyNoticeVersion.trim()) {
      throw badRequest('Field "privacyNoticeVersion" must be a non-empty string.');
    }
    privacyNoticeVersion = obj.privacyNoticeVersion.trim();
  }
  return { privacyNoticeAccepted: true, privacyNoticeVersion };
}

export function parseRegisterBody(raw: unknown): RegisterInput {
  const obj = asRecord(raw);
  rejectUnknownFields(obj, REGISTER_FIELDS);

  const email = parseRequiredEmail(obj.email);
  const password = parseRequiredPassword(obj.password);
  const displayName = parseDisplayName(obj.displayName ?? obj.name, 'displayName');
  const phone = parseOptionalPhone(obj.phone) ?? null;
  const language = parseLanguage(obj.language);

  if (obj.role !== 'client' && obj.role !== 'landlord' && obj.role !== 'agent') {
    if (obj.role === 'admin') {
      throw badRequest('Admin accounts cannot be created via public registration.', {
        code: 'ROLE_NOT_ALLOWED',
      });
    }
    throw badRequest('Field "role" must be "client", "landlord", or "agent".');
  }
  const role: RegisterRole = obj.role;

  let agentType: AgentType | null = null;
  if (role === 'agent') {
    if (obj.agentType === undefined || obj.agentType === null) {
      agentType = 'agent';
    } else if (obj.agentType === 'agent' || obj.agentType === 'caretaker') {
      agentType = obj.agentType;
    } else {
      throw badRequest('Field "agentType" must be "agent" or "caretaker".');
    }
  } else if (obj.agentType !== undefined && obj.agentType !== null) {
    throw badRequest('Field "agentType" is only valid when role is "agent".');
  }

  const { privacyNoticeAccepted, privacyNoticeVersion } = parsePrivacyNoticeAcceptance(obj);

  return {
    email,
    password,
    displayName,
    phone,
    language,
    role,
    agentType,
    privacyNoticeAccepted,
    privacyNoticeVersion,
  };
}

export function parseLoginBody(raw: unknown): LoginInput {
  const obj = asRecord(raw);
  rejectUnknownFields(obj, LOGIN_FIELDS);

  const email = parseRequiredEmail(obj.email);
  if (typeof obj.password !== 'string' || obj.password.length === 0) {
    throw badRequest('Field "password" is required.');
  }

  return { email, password: obj.password };
}

export function parseForgotPasswordBody(raw: unknown): ForgotPasswordInput {
  const obj = asRecord(raw);
  rejectUnknownFields(obj, FORGOT_PASSWORD_FIELDS);

  const email = parseRequiredEmail(obj.email);
  let redirectTo: string | undefined;
  if (obj.redirectTo !== undefined) {
    if (typeof obj.redirectTo !== 'string' || !obj.redirectTo.trim()) {
      throw badRequest('Field "redirectTo" must be a non-empty string.');
    }
    redirectTo = obj.redirectTo.trim();
  }

  return { email, redirectTo };
}

export function parseResetPasswordBody(raw: unknown): ResetPasswordInput {
  const obj = asRecord(raw);
  rejectUnknownFields(obj, RESET_PASSWORD_FIELDS);

  if (typeof obj.token !== 'string' || !obj.token.trim()) {
    throw badRequest('Field "token" is required.');
  }
  const newPassword = parseRequiredPassword(obj.newPassword);

  return { token: obj.token.trim(), newPassword };
}

export function parseRefreshTokenBody(raw: unknown): RefreshTokenInput {
  const obj = asRecord(raw);
  rejectUnknownFields(obj, REFRESH_FIELDS);

  if (typeof obj.refreshToken !== 'string' || obj.refreshToken.trim().length < 16) {
    throw badRequest('Field "refreshToken" is required.');
  }

  return { refreshToken: obj.refreshToken.trim() };
}

export function parseAcceptConsentBody(raw: unknown): AcceptConsentInput {
  const obj = asRecord(raw);
  rejectUnknownFields(obj, CONSENT_FIELDS);

  if (obj.accepted !== true) {
    throw badRequest('Field "accepted" must be true to record consent.', {
      code: 'PRIVACY_NOTICE_REQUIRED',
    });
  }

  let version: string | undefined;
  if (obj.version !== undefined) {
    if (typeof obj.version !== 'string' || !obj.version.trim()) {
      throw badRequest('Field "version" must be a non-empty string.');
    }
    version = obj.version.trim();
  }

  return { accepted: true, version };
}

export function parseAcceptAdminInviteBody(raw: unknown): AcceptAdminInviteInput {
  const obj = asRecord(raw);
  rejectUnknownFields(obj, ACCEPT_INVITE_FIELDS);

  if (typeof obj.token !== 'string' || obj.token.trim().length < 16) {
    throw badRequest('Field "token" is required.');
  }
  const token = obj.token.trim();
  const password = parseRequiredPassword(obj.password);
  const displayName =
    obj.displayName !== undefined ? parseDisplayName(obj.displayName, 'displayName') : undefined;
  const phone = parseOptionalPhone(obj.phone) ?? null;
  const language = parseLanguage(obj.language);
  const { privacyNoticeAccepted, privacyNoticeVersion } = parsePrivacyNoticeAcceptance(obj);

  return {
    token,
    password,
    displayName,
    phone,
    language,
    privacyNoticeAccepted,
    privacyNoticeVersion,
  };
}
