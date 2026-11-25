import { badRequest } from '../../lib/http-error.js';
import {
  asRecord,
  parseNumberInRange,
  parseOptionalText,
  parseOptionalUuid,
  parseRequiredUuid,
  parseText,
  parseVersion,
  rejectUnknownFields,
} from '../../lib/validation.js';

export const MANAGEMENT_TYPES = ['agent', 'landlord'] as const;
export type ManagementType = (typeof MANAGEMENT_TYPES)[number];

export type BuildingStatus = 'draft' | 'pending' | 'published' | 'suspended' | 'withdrawn';

/**
 * SRS §5.3, building status. Suspend, reinstate and the Pending-to-Published step that follows a
 * verification decision belong to Admin and verification phases, so only the maintainer moves are
 * here. Validated in the service, not in a trigger (design §12.2); T5 still guards `published`.
 */
const TRANSITIONS: Record<BuildingStatus, readonly BuildingStatus[]> = {
  draft: ['published', 'pending', 'withdrawn'],
  pending: ['published', 'withdrawn'],
  published: ['withdrawn'],
  withdrawn: ['draft'],
  suspended: [],
};

export function canTransition(from: string, to: BuildingStatus): boolean {
  return (TRANSITIONS[from as BuildingStatus] ?? []).includes(to);
}

export interface Management {
  managementType: ManagementType;
  managingAgentId: string | null;
  landlordUserId: string | null;
  landlordName: string | null;
}

/** BR-012 / FR-UNT-005, mirroring `ck_buildings_management` so the caller gets a message, not a 500. */
export function assertManagement(m: Management): void {
  if (m.managementType === 'agent') {
    if (!m.managingAgentId) {
      throw badRequest('A building managed by an agent needs "managingAgentId".', { code: 'MANAGEMENT_INVALID' });
    }
    return;
  }
  if (m.managingAgentId) {
    throw badRequest('A building managed by its landlord cannot have "managingAgentId".', {
      code: 'MANAGEMENT_INVALID',
    });
  }
  if (!m.landlordUserId && !m.landlordName) {
    throw badRequest('A building managed by its landlord needs "landlordUserId" or "landlordName".', {
      code: 'MANAGEMENT_INVALID',
    });
  }
}

function parseManagementType(value: unknown): ManagementType {
  if (typeof value === 'string' && (MANAGEMENT_TYPES as readonly string[]).includes(value)) {
    return value as ManagementType;
  }
  throw badRequest('Field "managementType" must be "agent" or "landlord".');
}

export interface CreateBuildingInput {
  name: string;
  areaId: string;
  latitude: number;
  longitude: number;
  description: string | null;
  managementType: ManagementType;
  managingAgentId: string | null;
  landlordUserId: string | null;
  landlordName: string | null;
  /** Admin only: create on behalf of this lister (G-15). */
  listerId: string | null;
}

const CREATE_FIELDS = [
  'name', 'areaId', 'latitude', 'longitude', 'description', 'managementType',
  'managingAgentId', 'landlordUserId', 'landlordName', 'listerId',
] as const;

export function parseCreateBuildingBody(raw: unknown): CreateBuildingInput {
  const obj = asRecord(raw);
  rejectUnknownFields(obj, CREATE_FIELDS);
  if (obj.latitude === undefined || obj.longitude === undefined) {
    throw badRequest('A map pin is required: send "latitude" and "longitude".', { code: 'MAP_PIN_REQUIRED' });
  }
  return {
    name: parseText(obj.name, 'name', 1, 150),
    areaId: parseRequiredUuid(obj.areaId, 'areaId'),
    latitude: parseNumberInRange(obj.latitude, 'latitude', -90, 90),
    longitude: parseNumberInRange(obj.longitude, 'longitude', -180, 180),
    description: parseOptionalText(obj.description, 'description', 5000) ?? null,
    managementType: parseManagementType(obj.managementType),
    managingAgentId: parseOptionalUuid(obj.managingAgentId, 'managingAgentId') ?? null,
    landlordUserId: parseOptionalUuid(obj.landlordUserId, 'landlordUserId') ?? null,
    landlordName: parseOptionalText(obj.landlordName, 'landlordName', 150) ?? null,
    listerId: parseOptionalUuid(obj.listerId, 'listerId') ?? null,
  };
}

export interface PatchBuildingInput {
  version: number;
  name?: string;
  areaId?: string;
  latitude?: number;
  longitude?: number;
  description?: string | null;
  managementType?: ManagementType;
  managingAgentId?: string | null;
  landlordUserId?: string | null;
  landlordName?: string | null;
}

const PATCH_FIELDS = ['version', ...CREATE_FIELDS.filter((f) => f !== 'listerId')] as const;

export function parsePatchBuildingBody(raw: unknown): PatchBuildingInput {
  const obj = asRecord(raw);
  rejectUnknownFields(obj, PATCH_FIELDS);
  const patch: PatchBuildingInput = { version: parseVersion(obj.version) };

  if (obj.name !== undefined) patch.name = parseText(obj.name, 'name', 1, 150);
  if (obj.areaId !== undefined) patch.areaId = parseRequiredUuid(obj.areaId, 'areaId');
  if (obj.latitude !== undefined) patch.latitude = parseNumberInRange(obj.latitude, 'latitude', -90, 90);
  if (obj.longitude !== undefined) patch.longitude = parseNumberInRange(obj.longitude, 'longitude', -180, 180);
  if (obj.description !== undefined) patch.description = parseOptionalText(obj.description, 'description', 5000)!;
  if (obj.managementType !== undefined) patch.managementType = parseManagementType(obj.managementType);
  if (obj.managingAgentId !== undefined) patch.managingAgentId = parseOptionalUuid(obj.managingAgentId, 'managingAgentId')!;
  if (obj.landlordUserId !== undefined) patch.landlordUserId = parseOptionalUuid(obj.landlordUserId, 'landlordUserId')!;
  if (obj.landlordName !== undefined) patch.landlordName = parseOptionalText(obj.landlordName, 'landlordName', 150)!;

  if (Object.keys(patch).length === 1) throw badRequest('Provide at least one field to change.');
  return patch;
}

/** Body of "add maintainer" and "set contact": the user concerned. */
export function parseUserBody(raw: unknown): { userId: string } {
  const obj = asRecord(raw);
  rejectUnknownFields(obj, ['userId']);
  return { userId: parseRequiredUuid(obj.userId, 'userId') };
}
