import { badRequest } from '../../lib/http-error.js';
import { parseKeysetQuery, type KeysetQuery } from '../../lib/keyset.js';
import { asRecord, parseText, rejectUnknownFields } from '../../lib/validation.js';

export const ENQUIRY_STATUSES = ['new', 'responded', 'closed'] as const;
export type EnquiryStatus = (typeof ENQUIRY_STATUSES)[number];

/** `ck_msg_body_len`: 1 to 4000 characters once trimmed. */
export const MESSAGE_MAX_LENGTH = 4000;

export interface MessageInput {
  body: string;
}

export function parseMessageBody(raw: unknown): MessageInput {
  const obj = asRecord(raw);
  rejectUnknownFields(obj, ['body']);
  return { body: parseText(obj.body, 'body', 1, MESSAGE_MAX_LENGTH) };
}

export interface ListEnquiriesQuery extends KeysetQuery {
  status: EnquiryStatus | null;
  /** Only threads where the caller is the client, or only those on buildings they maintain. */
  as: 'client' | 'maintainer' | null;
}

export function parseListEnquiriesQuery(query: Record<string, unknown>): ListEnquiriesQuery {
  let status: EnquiryStatus | null = null;
  if (query.status !== undefined) {
    if (typeof query.status !== 'string' || !(ENQUIRY_STATUSES as readonly string[]).includes(query.status)) {
      throw badRequest('Query "status" must be "new", "responded" or "closed".');
    }
    status = query.status as EnquiryStatus;
  }
  let as: ListEnquiriesQuery['as'] = null;
  if (query.as !== undefined) {
    if (query.as !== 'client' && query.as !== 'maintainer') throw badRequest('Query "as" must be "client" or "maintainer".');
    as = query.as;
  }
  return { ...parseKeysetQuery(query), status, as };
}
