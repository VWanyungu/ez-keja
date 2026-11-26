import { asRecord, parseOptionalUuid, rejectUnknownFields } from '../../lib/validation.js';

export interface ContactEventInput {
  spaceTypeId: string | null;
}

/** FR-ENQ-004: the body is optional; only the space type the tap came from may be sent. */
export function parseContactEventBody(raw: unknown): ContactEventInput {
  if (raw === undefined || raw === null) return { spaceTypeId: null };
  const body = asRecord(raw);
  rejectUnknownFields(body, ['spaceTypeId']);
  return { spaceTypeId: parseOptionalUuid(body.spaceTypeId, 'spaceTypeId') ?? null };
}
