import { badRequest } from '../../lib/http-error.js';
import { parseKeysetQuery, type KeysetQuery } from '../../lib/keyset.js';
import {
  asRecord,
  parseOptionalText,
  parseRequiredUuid,
  parseText,
  rejectUnknownFields,
} from '../../lib/validation.js';

export const SUBJECT_TYPES = ['account', 'building'] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

export const CASE_STATUSES = ['pending', 'approved', 'rejected', 'revoked', 'superseded'] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const DECISIONS = ['approve', 'reject'] as const;
export type Decision = (typeof DECISIONS)[number];

/** One file of evidence the applicant attaches to a submission. */
export interface EvidenceInput {
  evidenceType: string;
  fileId: string;
}

export const MAX_EVIDENCE_ITEMS = 5;
export const MAX_REASON_LENGTH = 1000;

/**
 * `{ evidence: [{ evidenceType, fileId }] }`. An empty or absent list is accepted here on purpose:
 * the service then refuses it by naming the missing item (FR-VER-001 / -003 acceptance criteria).
 * Which types are allowed is a service rule (OQ-02 is open), so only the shape is checked.
 */
export function parseSubmitBody(raw: unknown): { evidence: EvidenceInput[] } {
  const body = raw === undefined ? {} : asRecord(raw);
  rejectUnknownFields(body, ['evidence']);
  const list = body.evidence ?? [];
  if (!Array.isArray(list) || list.length > MAX_EVIDENCE_ITEMS) {
    throw badRequest(`Field "evidence" must be a list of at most ${MAX_EVIDENCE_ITEMS} items.`);
  }
  const evidence = list.map((item, i) => {
    const entry = asRecord(item);
    rejectUnknownFields(entry, ['evidenceType', 'fileId']);
    return {
      evidenceType: parseText(entry.evidenceType, `evidence[${i}].evidenceType`, 1, 50),
      fileId: parseRequiredUuid(entry.fileId, `evidence[${i}].fileId`),
    };
  });
  return { evidence };
}

/** Reason is mandatory on a rejection (FR-VER-002) and optional on an approval. */
export function parseDecisionBody(raw: unknown): { decision: Decision; reason: string | null } {
  const body = asRecord(raw);
  rejectUnknownFields(body, ['decision', 'reason']);
  if (!(DECISIONS as readonly unknown[]).includes(body.decision)) {
    throw badRequest('Field "decision" must be "approve" or "reject".');
  }
  const decision = body.decision as Decision;
  if (decision === 'reject') {
    return { decision, reason: parseText(body.reason, 'reason', 1, MAX_REASON_LENGTH) };
  }
  return { decision, reason: parseOptionalText(body.reason, 'reason', MAX_REASON_LENGTH) ?? null };
}

export interface RevokeInput {
  subject: SubjectType;
  id: string;
  reason: string;
}

/** FR-VER-006: the reason is mandatory. `id` is the user id (account) or building id (building). */
export function parseRevokeBody(raw: unknown): RevokeInput {
  const body = asRecord(raw);
  rejectUnknownFields(body, ['subject', 'id', 'reason']);
  if (!(SUBJECT_TYPES as readonly unknown[]).includes(body.subject)) {
    throw badRequest('Field "subject" must be "account" or "building".');
  }
  return {
    subject: body.subject as SubjectType,
    id: parseRequiredUuid(body.id, 'id'),
    reason: parseText(body.reason, 'reason', 1, MAX_REASON_LENGTH),
  };
}

/** Evidence the Admin may add while reviewing (there is no SMS channel, so phone is confirmed by hand). */
export function parseAddEvidenceBody(raw: unknown): { evidenceType: string } {
  const body = asRecord(raw);
  rejectUnknownFields(body, ['evidenceType']);
  return { evidenceType: parseText(body.evidenceType, 'evidenceType', 1, 50) };
}

export interface QueueQuery extends KeysetQuery {
  subject: SubjectType | null;
  status: CaseStatus;
}

/** `GET /admin/verification/cases`: `status` defaults to pending, `subject` to both kinds. */
export function parseQueueQuery(query: Record<string, unknown>): QueueQuery {
  const { subject, status } = query;
  if (subject !== undefined && !(SUBJECT_TYPES as readonly unknown[]).includes(subject)) {
    throw badRequest('Query "subject" must be "account" or "building".');
  }
  if (status !== undefined && !(CASE_STATUSES as readonly unknown[]).includes(status)) {
    throw badRequest(`Query "status" must be one of: ${CASE_STATUSES.join(', ')}.`);
  }
  return {
    subject: (subject as SubjectType | undefined) ?? null,
    status: (status as CaseStatus | undefined) ?? 'pending',
    ...parseKeysetQuery(query),
  };
}
