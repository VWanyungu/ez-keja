import { badRequest } from '../../lib/http-error.js';
import {
  asRecord,
  parseDisplayName,
  parseLanguage,
  parseOptionalPhone,
  parseOptionalUuid,
  rejectUnknownFields,
} from '../../lib/validation.js';
import type { AgentType, LanguageCode } from '../../middlewares/auth.js';

export interface PatchMeInput {
  displayName?: string;
  phone?: string | null;
  language?: LanguageCode;
  agentType?: AgentType | null;
  photoFileId?: string | null;
}

const PATCH_ME_FIELDS = ['displayName', 'phone', 'language', 'agentType', 'photoFileId'] as const;

export function parsePatchMeBody(raw: unknown): PatchMeInput {
  const obj = asRecord(raw);
  rejectUnknownFields(obj, PATCH_ME_FIELDS);

  const patch: PatchMeInput = {};

  if ('displayName' in obj) {
    patch.displayName = parseDisplayName(obj.displayName, 'displayName');
  }
  if ('phone' in obj) {
    patch.phone = parseOptionalPhone(obj.phone);
  }
  if ('language' in obj) {
    patch.language = parseLanguage(obj.language);
  }
  if ('agentType' in obj) {
    if (obj.agentType === null) {
      patch.agentType = null;
    } else if (obj.agentType === 'agent' || obj.agentType === 'caretaker') {
      patch.agentType = obj.agentType;
    } else {
      throw badRequest('Field "agentType" must be "agent", "caretaker", or null.');
    }
  }
  if ('photoFileId' in obj) {
    patch.photoFileId = parseOptionalUuid(obj.photoFileId, 'photoFileId');
  }

  if (Object.keys(patch).length === 0) {
    throw badRequest('At least one profile field must be provided.');
  }

  return patch;
}
