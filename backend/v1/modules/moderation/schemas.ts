import { badRequest } from '../../lib/http-error.js';
import { asRecord, rejectUnknownFields } from '../../lib/validation.js';

export const MAX_REASON_LENGTH = 1000;

/** FR-ADM-003: every suspension and reinstatement carries a reason (mandatory), kept in the audit row. */
export function parseModerationBody(raw: unknown): { reason: string } {
  const body = raw === undefined ? {} : asRecord(raw);
  rejectUnknownFields(body, ['reason']);
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason === '') {
    throw badRequest('A reason is required (FR-ADM-003).', { code: 'REASON_REQUIRED' });
  }
  if (reason.length > MAX_REASON_LENGTH) {
    throw badRequest(`Field "reason" must be at most ${MAX_REASON_LENGTH} characters.`);
  }
  return { reason };
}
