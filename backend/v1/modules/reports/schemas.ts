import { badRequest } from '../../lib/http-error.js';
import { parseKeysetQuery, type KeysetQuery } from '../../lib/keyset.js';
import { asRecord, parseOptionalText, rejectUnknownFields } from '../../lib/validation.js';

export const REPORT_REASONS = ['unavailable', 'inaccurate', 'suspicious'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export const REPORT_STATUSES = ['open', 'actioned', 'dismissed'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** `ck_reports_comment_len`. */
export const COMMENT_MAX_LENGTH = 2000;
export const RESOLUTION_NOTE_MAX_LENGTH = 2000;

export interface CreateReportInput {
  reason: ReportReason;
  comment: string | null;
}

export function parseCreateReportBody(raw: unknown): CreateReportInput {
  const obj = asRecord(raw);
  rejectUnknownFields(obj, ['reason', 'comment']);
  if (typeof obj.reason !== 'string' || !(REPORT_REASONS as readonly string[]).includes(obj.reason)) {
    throw badRequest('Field "reason" must be "unavailable", "inaccurate" or "suspicious".');
  }
  return {
    reason: obj.reason as ReportReason,
    comment: parseOptionalText(obj.comment, 'comment', COMMENT_MAX_LENGTH) ?? null,
  };
}

export interface ResolveReportInput {
  resolution: 'actioned' | 'dismissed';
  note: string | null;
}

export function parseResolveReportBody(raw: unknown): ResolveReportInput {
  const obj = asRecord(raw);
  rejectUnknownFields(obj, ['resolution', 'note']);
  if (obj.resolution !== 'actioned' && obj.resolution !== 'dismissed') {
    throw badRequest('Field "resolution" must be "actioned" or "dismissed".');
  }
  return { resolution: obj.resolution, note: parseOptionalText(obj.note, 'note', RESOLUTION_NOTE_MAX_LENGTH) ?? null };
}

export interface ListReportsQuery extends KeysetQuery {
  status: ReportStatus;
}

/** FR-ADM-005: the queue defaults to open reports, oldest first. */
export function parseListReportsQuery(query: Record<string, unknown>): ListReportsQuery {
  let status: ReportStatus = 'open';
  if (query.status !== undefined) {
    if (typeof query.status !== 'string' || !(REPORT_STATUSES as readonly string[]).includes(query.status)) {
      throw badRequest('Query "status" must be "open", "actioned" or "dismissed".');
    }
    status = query.status as ReportStatus;
  }
  return { ...parseKeysetQuery(query), status };
}
