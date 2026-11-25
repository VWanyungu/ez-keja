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

export function parseRequiredUuid(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !isUuid(value)) {
    throw badRequest(`Field "${fieldName}" must be a valid UUID.`);
  }
  return value;
}

/** Required string, trimmed, `min` to `max` characters. */
export function parseText(value: unknown, fieldName: string, min: number, max: number): string {
  if (typeof value !== 'string') throw badRequest(`Field "${fieldName}" is required.`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw badRequest(`Field "${fieldName}" must be between ${min} and ${max} characters.`);
  }
  return trimmed;
}

/** Optional string: undefined = not sent, null or blank = clear it. */
export function parseOptionalText(value: unknown, fieldName: string, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw badRequest(`Field "${fieldName}" must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw badRequest(`Field "${fieldName}" must be at most ${max} characters.`);
  return trimmed === '' ? null : trimmed;
}

export function parseNumberInRange(value: unknown, fieldName: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw badRequest(`Field "${fieldName}" must be a number from ${min} to ${max}.`);
  }
  return value;
}

export function parseWholeNumber(value: unknown, fieldName: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw badRequest(`Field "${fieldName}" must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

/** An amount of money or a size: finite, at most two decimals, `> 0` or `>= 0`. */
export function parseAmount(
  value: unknown,
  fieldName: string,
  opts: { allowZero: boolean; max: number },
): number {
  const tooSmall = typeof value === 'number' && (opts.allowZero ? value < 0 : value <= 0);
  const twoDecimals = typeof value === 'number' && Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
  if (typeof value !== 'number' || !Number.isFinite(value) || tooSmall || value > opts.max || !twoDecimals) {
    throw badRequest(
      `Field "${fieldName}" must be a number ${opts.allowZero ? 'of zero or more' : 'above zero'}, with at most two decimals.`,
    );
  }
  return value;
}

/** The optimistic-lock version the client last saw (FR-UNT-007, TX-04). */
export function parseVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw badRequest('Field "version" is required: send the version you last loaded.');
  }
  return value;
}

export function parseOptionalUuid(value: unknown, fieldName: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !isUuid(value)) {
    throw badRequest(`Field "${fieldName}" must be a valid UUID.`);
  }
  return value;
}
