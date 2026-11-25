import { badRequest } from '../../lib/http-error.js';
import { asRecord, parseOptionalText, rejectUnknownFields } from '../../lib/validation.js';
import { parseVacantCount } from '../availability/schemas.js';

/** Values of `followups.outcome` (`ck_followups_outcome`). */
export const FOLLOW_UP_OUTCOMES = ['confirmed', 'fully_let', 'unreachable'] as const;
export type FollowUpOutcome = (typeof FOLLOW_UP_OUTCOMES)[number];

export interface RecordFollowUpInput {
  outcome: FollowUpOutcome;
  /** Required for `confirmed`: the count the lister confirmed by phone (1 or more). */
  vacantCount: number | null;
  note: string | null;
}

export function parseRecordFollowUpBody(raw: unknown): RecordFollowUpInput {
  const obj = asRecord(raw);
  rejectUnknownFields(obj, ['outcome', 'vacantCount', 'note']);
  if (typeof obj.outcome !== 'string' || !(FOLLOW_UP_OUTCOMES as readonly string[]).includes(obj.outcome)) {
    throw badRequest('Field "outcome" must be "confirmed", "fully_let" or "unreachable".');
  }
  const outcome = obj.outcome as FollowUpOutcome;

  let vacantCount: number | null = null;
  if (outcome === 'confirmed') {
    // A count of 0 is the "fully_let" outcome, so "confirmed" always means still Vacant.
    vacantCount = parseVacantCount(obj.vacantCount, 1);
  } else if (obj.vacantCount !== undefined) {
    throw badRequest('Field "vacantCount" is only allowed with the "confirmed" outcome.');
  }
  return { outcome, vacantCount, note: parseOptionalText(obj.note, 'note', 1000) ?? null };
}
