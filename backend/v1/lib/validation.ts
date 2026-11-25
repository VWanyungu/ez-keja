import { badRequest } from './http-error.js';
import { isUuid } from './uuid.js';
import type { LanguageCode } from '../middlewares/auth.js';

export const E164_REGEX = /^\+[1-9][0-9]{7,14}$/;
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export function asRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw badRequest('Request body must be a JSON object.');
  }
  return raw as Record<string, unknown>;
}

export function rejectUnknownFields(obj: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      throw badRequest(`Field "${key}" is not allowed.`);
    }
  }
}

export function parseRequiredEmail(value: unknown): string {
  if (typeof value !== 'string') {
    throw badRequest('Field "email" is required.');
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized || !EMAIL_REGEX.test(normalized)) {
    throw badRequest('Field "email" must be a valid email address.');
  }
  return normalized;
}

export function parseRequiredPassword(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw badRequest('Field "password" is required.');
  }
  if (value.length < PASSWORD_MIN_LENGTH) {
    throw badRequest(`Field "password" must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  if (value.length > PASSWORD_MAX_LENGTH) {
    throw badRequest(`Field "password" must be at most ${PASSWORD_MAX_LENGTH} characters.`);
  }
  return value;
}

export function parseDisplayName(value: unknown, fieldName = 'displayName'): string {
  if (typeof value !== 'string') {
    throw badRequest(`Field "${fieldName}" is required.`);
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 120) {
    throw badRequest(`Field "${fieldName}" must be between 1 and 120 characters.`);
  }
  return trimmed;
}

export function parseOptionalPhone(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw badRequest('Field "phone" must be a string in E.164 format.');
  }
  const trimmed = value.trim();
  if (!E164_REGEX.test(trimmed)) {
    throw badRequest('Field "phone" must be a valid E.164 phone number (e.g. +254712345678).');
  }
  return trimmed;
}

export function parseLanguage(value: unknown): LanguageCode {
  if (value === undefined) return 'en';
  if (value === 'en' || value === 'sw') return value;
  throw badRequest('Field "language" must be "en" or "sw".');
}

export function parseOptionalUuid(value: unknown, fieldName: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !isUuid(value)) {
    throw badRequest(`Field "${fieldName}" must be a valid UUID.`);
  }
  return value;
}
