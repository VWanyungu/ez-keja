import { badRequest } from '../../lib/http-error.js';
import { isUuid } from '../../lib/uuid.js';
import {
  asRecord,
  parseDisplayName,
  parseRequiredEmail,
  rejectUnknownFields,
} from '../../lib/validation.js';

export const DEFAULT_ADMIN_INVITE_TTL_HOURS = 72;
export const MAX_ADMIN_INVITE_TTL_HOURS = 168;

export interface CreateAdminInviteInput {
  email: string;
  displayName: string;
  expiresInHours: number;
}

const CREATE_INVITE_FIELDS = ['email', 'displayName', 'expiresInHours'] as const;

export function parseCreateAdminInviteBody(raw: unknown): CreateAdminInviteInput {
  const obj = asRecord(raw);
  rejectUnknownFields(obj, CREATE_INVITE_FIELDS);

  const email = parseRequiredEmail(obj.email);
  const displayName = parseDisplayName(obj.displayName, 'displayName');

  let expiresInHours = DEFAULT_ADMIN_INVITE_TTL_HOURS;
  if (obj.expiresInHours !== undefined) {
    if (
      typeof obj.expiresInHours !== 'number' ||
      !Number.isInteger(obj.expiresInHours) ||
      obj.expiresInHours < 1 ||
      obj.expiresInHours > MAX_ADMIN_INVITE_TTL_HOURS
    ) {
      throw badRequest(
        `Field "expiresInHours" must be a whole number between 1 and ${MAX_ADMIN_INVITE_TTL_HOURS}.`,
      );
    }
    expiresInHours = obj.expiresInHours;
  }

  return { email, displayName, expiresInHours };
}

export function parseInviteIdParam(id: string | undefined): string {
  if (!id || !isUuid(id)) {
    throw badRequest('Invalid invite id.');
  }
  return id;
}
