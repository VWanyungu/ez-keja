import type { Knex } from 'knex';
import db from '../../db/knex.js';
import { lockBuildingRow, withTx } from '../../db/tx.js';
import { writeAudit } from '../../lib/audit.js';
import { rolesByUser } from '../../lib/catalogue.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/http-error.js';
import { encodeCursor, type KeysetCursor } from '../../lib/keyset.js';
import { loadBuildingAccess } from '../../lib/maintainer.js';
import { adminRecipients, maintainerRecipients, notifyEach } from '../../lib/notify.js';
import type { AuthContext } from '../../middlewares/auth.js';
import type {
  CaseStatus,
  Decision,
  EvidenceInput,
  QueueQuery,
  RevokeInput,
  SubjectType,
} from './schemas.js';

type Conn = Knex | Knex.Transaction;

// ---- rules (OQ-02 is open: change them here, the column is free text, design G-08) ------------

/**
 * Which evidence each kind of case needs. The ONE place to edit when OQ-02 closes.
 *   applicant  types the applicant may attach (each is a file uploaded through POST /files/evidence)
 *   required   types that must be present, or the submission is refused naming the missing item
 *   admin      types only the Admin may add while reviewing (phone is confirmed by hand: no SMS)
 */
export const EVIDENCE_RULES: Record<
  SubjectType,
  { applicant: readonly string[]; required: readonly string[]; admin: readonly string[] }
> = {
  account: { applicant: ['national_id'], required: ['national_id'], admin: ['phone_confirmation'] },
  building: { applicant: ['proof_of_authority'], required: ['proof_of_authority'], admin: [] },
};

/**
 * BR-014, "edited" half (design §8.1). An Admin who did any of these on a building cannot decide
 * that building's verification. They are `audit_log` actions written by the catalogue phases
 * (read through `audit_trail_v`, which also carries availability events). `buildings.created_by`
 * and the lister / maintainer links count too (see `separationConflict`).
 */
export const EDIT_ACTIONS: readonly string[] = [
  'building.create',
  'building.update',
  'building.contact.set',
  'building.publish',
  'building.pending',
  'building.withdraw',
  'building.reopen',
  'maintainer.add',
  'maintainer.remove',
  'space_type.create',
  'space_type.update',
  'space_type.remove',
  'space_type.restore',
  'photo.add',
  'photo.update',
  'photo.remove',
];

/** Notification event codes (SRS §10.2). */
const EVENT_ACCOUNT_DECISION = 'N-01';
const EVENT_BUILDING_DECISION = 'N-02';
const EVENT_REVOKED_OR_REOPENED = 'N-03';
const EVENT_LISTER_VERIFIED = 'N-13';

const refuseSelf = (message: string) => forbidden(message, { code: 'SEPARATION_OF_DUTIES' });

// ---- evidence ----------------------------------------------------------------------------------

/** FR-VER-001 / -003: allowed types only, every required item present, each file once. Pure. */
export function assertEvidenceTypes(subject: SubjectType, evidence: readonly EvidenceInput[]): void {
  const rule = EVIDENCE_RULES[subject];
  for (const item of evidence) {
    if (!rule.applicant.includes(item.evidenceType)) {
      throw badRequest(
        `Evidence type "${item.evidenceType}" is not accepted for a ${subject} verification. Accepted: ${rule.applicant.join(', ')}.`,
        { code: 'EVIDENCE_TYPE_NOT_ALLOWED' },
      );
    }
  }
  const missing = rule.required.filter((type) => !evidence.some((e) => e.evidenceType === type));
  if (missing.length > 0) {
    throw badRequest(`Required evidence is missing: ${missing.join(', ')}.`, {
      code: 'EVIDENCE_MISSING',
      data: { missing },
    });
  }
  if (new Set(evidence.map((e) => e.fileId)).size !== evidence.length) {
    throw badRequest('Each evidence file can be attached only once.', { code: 'EVIDENCE_DUPLICATE_FILE' });
  }
}

/**
 * The files must be restricted evidence uploaded by the caller (`POST /files/evidence`), still
 * stored, and not already attached to another case. The rows are locked so two submissions cannot
 * claim the same file at once (there is no unique index on `verification_evidence.file_id`).
 */
async function assertAttachableFiles(trx: Knex.Transaction, userId: string, evidence: readonly EvidenceInput[]) {
  if (evidence.length === 0) return;
  const ids = evidence.map((e) => e.fileId);
  const files = (await trx('files')
    .whereIn('id', ids)
    .orderBy('id')
    .forUpdate()
    .select('id', 'uploaded_by', 'visibility', 'purged_at')) as Array<{
    id: string;
    uploaded_by: string;
    visibility: string;
    purged_at: Date | null;
  }>;
  const byId = new Map(files.map((f) => [f.id, f]));
  for (const id of ids) {
    const file = byId.get(id);
    if (!file || file.uploaded_by !== userId || file.visibility !== 'restricted' || file.purged_at) {
      throw badRequest(`File ${id} is not one of the evidence files you uploaded.`, {
        code: 'EVIDENCE_FILE_INVALID',
      });
    }
  }
  const used = await trx('verification_evidence').whereIn('file_id', ids).first('file_id');
  if (used) {
    throw conflict(`File ${used.file_id} is already attached to a verification case.`, {
      code: 'EVIDENCE_FILE_IN_USE',
    });
  }
}

// ---- database error mapping --------------------------------------------------------------------

/** Turns the constraint and trigger errors a decision or submission can hit into clear HTTP errors. */
export function mapCaseViolation(err: unknown): unknown {
  const pg = err as { code?: string; constraint?: string; message?: string } | null;
  if (pg?.code === '23514' && pg.constraint === 'ck_vc_separation') {
    return refuseSelf('You cannot decide a verification case you submitted or that is about your own account.');
  }
  if (pg?.code === '23505' && pg.constraint?.startsWith('ux_vc_one_pending')) {
    return conflict('A verification request is already pending.', { code: 'VERIFICATION_PENDING' });
  }
  if (pg?.code === '23514' && /verification case/.test(pg.message ?? '')) {
    return conflict(pg.message ?? 'The case is not in a state that allows this.', { code: 'CASE_STATE_CONFLICT' });
  }
  return err;
}

// ---- keyset paging -----------------------------------------------------------------------------

interface Paged<T> {
  items: T[];
  nextCursor: string | null;
}

/** `rows` is limit + 1 long when there is another page. Cursor = `submitted_at::text` + id. */
function page<T>(rows: Array<T & { id: string; submitted_at_text: string }>, limit: number): Paged<T> {
  const more = rows.length > limit;
  const kept = more ? rows.slice(0, limit) : rows;
  const last = kept[kept.length - 1];
  return {
    items: kept.map(({ submitted_at_text: _t, ...rest }) => rest as unknown as T),
    nextCursor: more && last ? encodeCursor({ t: last.submitted_at_text, id: last.id }) : null,
  };
}

const keysetWhere = (cursor: KeysetCursor | null, op: '<' | '>') =>
  cursor ? ([`(c.submitted_at, c.id) ${op} (?::timestamptz, ?::uuid)`, [cursor.t, cursor.id]] as const) : null;

// ---- the applicant's own cases -----------------------------------------------------------------

export interface MyCaseItem {
  id: string;
  subjectType: SubjectType;
  building: { id: string; name: string } | null;
  origin: string;
  status: CaseStatus;
  submittedAt: Date;
  decidedAt: Date | null;
  revokedAt: Date | null;
  /** The rejection reason, or the revocation reason, as the applicant is meant to see it. */
  reason: string | null;
  evidenceTypes: string[];
}

interface MyCaseRow {
  id: string;
  subject_type: SubjectType;
  subject_building_id: string | null;
  building_name: string | null;
  origin: string;
  status: CaseStatus;
  submitted_at: Date;
  submitted_at_text: string;
  decided_at: Date | null;
  revoked_at: Date | null;
  decision_reason: string | null;
  revoke_reason: string | null;
}

async function toMyCaseItems(conn: Conn, rows: MyCaseRow[]): Promise<Array<MyCaseItem & { id: string; submitted_at_text: string }>> {
  const evidence = rows.length
    ? ((await conn('verification_evidence')
        .whereIn('case_id', rows.map((r) => r.id))
        .orderBy('created_at')
        .select('case_id', 'evidence_type')) as Array<{ case_id: string; evidence_type: string }>)
    : [];
  return rows.map((r) => ({
    id: r.id,
    submitted_at_text: r.submitted_at_text,
    subjectType: r.subject_type,
    building: r.subject_building_id ? { id: r.subject_building_id, name: r.building_name ?? '' } : null,
    origin: r.origin,
    status: r.status,
    submittedAt: r.submitted_at,
    decidedAt: r.decided_at,
    revokedAt: r.revoked_at,
    reason: r.status === 'revoked' ? r.revoke_reason : r.decision_reason,
    evidenceTypes: evidence.filter((e) => e.case_id === r.id).map((e) => e.evidence_type),
  }));
}

const MY_CASE_COLUMNS = [
  'c.id', 'c.subject_type', 'c.subject_building_id', 'b.name as building_name', 'c.origin', 'c.status',
  'c.submitted_at', 'c.decided_at', 'c.revoked_at', 'c.decision_reason', 'c.revoke_reason',
] as const;

/** FR-VER-002 / SCR-09: the caller's own account cases and those of the buildings they maintain. */
export async function listMyCases(
  auth: AuthContext,
  query: { limit: number; cursor: KeysetCursor | null },
): Promise<Paged<MyCaseItem>> {
  const q = db('verification_cases as c')
    .leftJoin('buildings as b', 'b.id', 'c.subject_building_id')
    .where((w) =>
      w
        .where({ 'c.subject_type': 'account', 'c.subject_user_id': auth.user.id })
        .orWhere((x) =>
          x
            .where('c.subject_type', 'building')
            .whereIn(
              'c.subject_building_id',
              db('building_maintainers').where({ user_id: auth.user.id }).select('building_id'),
            ),
        ),
    )
    .select(...MY_CASE_COLUMNS, db.raw('c.submitted_at::text AS submitted_at_text'))
    .orderBy('c.submitted_at', 'desc')
    .orderBy('c.id', 'desc')
    .limit(query.limit + 1);
  const where = keysetWhere(query.cursor, '<');
  if (where) q.whereRaw(where[0], [...where[1]]);
  const rows = (await q) as MyCaseRow[];
  return page(await toMyCaseItems(db, rows), query.limit);
}

async function loadMyCase(conn: Conn, caseId: string): Promise<MyCaseItem> {
  const rows = (await conn('verification_cases as c')
    .leftJoin('buildings as b', 'b.id', 'c.subject_building_id')
    .where('c.id', caseId)
    .select(...MY_CASE_COLUMNS, conn.raw('c.submitted_at::text AS submitted_at_text'))) as MyCaseRow[];
  const [item] = await toMyCaseItems(conn, rows);
  const { submitted_at_text: _t, ...rest } = item!;
  return rest as MyCaseItem;
}

// ---- submit (FR-VER-001, FR-VER-003) ----------------------------------------------------------

async function insertCase(
  trx: Knex.Transaction,
  auth: AuthContext,
  subject: { type: 'account'; userId: string } | { type: 'building'; buildingId: string },
  evidence: readonly EvidenceInput[],
): Promise<string> {
  // clock_timestamp(): T3 reads the newest case by submitted_at, so a case inserted after waiting
  // on a lock must still sort after one committed in the meantime (now() is the transaction start).
  const [row] = (await trx('verification_cases')
    .insert({
      subject_type: subject.type,
      subject_user_id: subject.type === 'account' ? subject.userId : null,
      subject_building_id: subject.type === 'building' ? subject.buildingId : null,
      origin: 'applicant',
      submitted_by: auth.user.id,
      submitted_at: trx.raw('clock_timestamp()'),
    })
    .returning('id')) as Array<{ id: string }>;
  const caseId = row!.id;
  if (evidence.length > 0) {
    await trx('verification_evidence').insert(
      evidence.map((e) => ({ case_id: caseId, evidence_type: e.evidenceType, file_id: e.fileId })),
    );
  }
  await writeAudit(trx, {
    actorUserId: auth.user.id,
    actorType: 'user',
    action: 'verification.submit',
    objectType: 'verification_case',
    objectId: caseId,
    buildingId: subject.type === 'building' ? subject.buildingId : null,
    changes: { subjectType: subject.type, evidence: evidence.map((e) => e.evidenceType) },
  });
  return caseId;
}

/** A Verified or Pending subject cannot submit again; Unverified, Rejected and Revoked can. */
function assertCanSubmit(status: string, what: string): void {
  if (status === 'verified') {
    throw conflict(`${what} is already verified.`, { code: 'ALREADY_VERIFIED' });
  }
  if (status === 'pending') {
    throw conflict(`A verification request for ${what.toLowerCase()} is already pending.`, {
      code: 'VERIFICATION_PENDING',
    });
  }
}

/**
 * FR-VER-001: the caller submits evidence for their own account. The profile row is locked so a
 * double submit sees the first one as Pending. T3 then sets the cache to `pending`.
 */
export async function submitAccountVerification(
  auth: AuthContext,
  input: { evidence: EvidenceInput[] },
): Promise<MyCaseItem> {
  assertEvidenceTypes('account', input.evidence);
  try {
    return await withTx(async (trx) => {
      const profile = (await trx('profiles')
        .where({ user_id: auth.user.id })
        .forUpdate()
        .first('verification_status')) as { verification_status: string } | undefined;
      if (!profile) throw notFound('Profile not found.', { code: 'PROFILE_NOT_FOUND' });
      assertCanSubmit(profile.verification_status, 'Your account');
      await assertAttachableFiles(trx, auth.user.id, input.evidence);
      const caseId = await insertCase(trx, auth, { type: 'account', userId: auth.user.id }, input.evidence);
      return loadMyCase(trx, caseId);
    });
  } catch (err) {
    throw mapCaseViolation(err);
  }
}

/**
 * FR-VER-003: a maintainer of the building (an Admin who only acts on behalf cannot apply for it)
 * submits evidence. The building row is locked first (design §9.3), T3 sets its cache to `pending`.
 */
export async function submitBuildingVerification(
  auth: AuthContext,
  buildingId: string,
  input: { evidence: EvidenceInput[] },
): Promise<MyCaseItem> {
  await loadBuildingAccess(auth, buildingId);
  assertEvidenceTypes('building', input.evidence);
  try {
    return await withTx(async (trx) => {
      const building = await lockBuildingRow(trx, buildingId);
      const access = await loadBuildingAccess(auth, buildingId, trx);
      if (!access.isMaintainer) {
        throw forbidden('Only a maintainer of this building can request its verification.', {
          code: 'NOT_A_MAINTAINER',
        });
      }
      if (building.status === 'withdrawn') {
        throw conflict('This building is withdrawn. Reopen it before requesting verification.', {
          code: 'BUILDING_WITHDRAWN',
        });
      }
      const { verification_status } = (await trx('buildings')
        .where({ id: buildingId })
        .first('verification_status')) as { verification_status: string };
      assertCanSubmit(verification_status, 'This building');
      await assertAttachableFiles(trx, auth.user.id, input.evidence);
      const caseId = await insertCase(trx, auth, { type: 'building', buildingId }, input.evidence);
      return loadMyCase(trx, caseId);
    });
  } catch (err) {
    throw mapCaseViolation(err);
  }
}

// ---- Admin queue and detail (FR-VER-002 / -004) -----------------------------------------------

export interface QueueItem {
  id: string;
  subjectType: SubjectType;
  origin: string;
  status: CaseStatus;
  submittedAt: Date;
  submittedBy: { id: string; displayName: string } | null;
  decidedAt: Date | null;
  evidenceCount: number;
  subject:
    | { type: 'account'; userId: string; displayName: string; verificationStatus: string }
    | {
        type: 'building';
        buildingId: string;
        name: string;
        listerId: string;
        listerName: string;
        status: string;
        verificationStatus: string;
      };
}

/** Oldest first for the pending queue (FR-VER-002); newest first when browsing decided cases. */
export async function listCases(query: QueueQuery): Promise<Paged<QueueItem>> {
  const ascending = query.status === 'pending';
  const q = db('verification_cases as c')
    .leftJoin('profiles as sp', 'sp.user_id', 'c.subject_user_id')
    .leftJoin('buildings as b', 'b.id', 'c.subject_building_id')
    .leftJoin('profiles as lp', 'lp.user_id', 'b.lister_id')
    .leftJoin('profiles as up', 'up.user_id', 'c.submitted_by')
    .where('c.status', query.status)
    .select(
      'c.id', 'c.subject_type', 'c.subject_user_id', 'c.subject_building_id', 'c.origin', 'c.status',
      'c.submitted_at', 'c.submitted_by', 'c.decided_at',
      'sp.display_name as subject_name', 'sp.verification_status as subject_verification',
      'b.name as building_name', 'b.lister_id', 'b.status as building_status',
      'b.verification_status as building_verification', 'lp.display_name as lister_name',
      'up.display_name as submitter_name',
      db.raw('c.submitted_at::text AS submitted_at_text'),
      db.raw('(SELECT count(*) FROM verification_evidence e WHERE e.case_id = c.id)::int AS evidence_count'),
    )
    .orderBy('c.submitted_at', ascending ? 'asc' : 'desc')
    .orderBy('c.id', ascending ? 'asc' : 'desc')
    .limit(query.limit + 1);
  if (query.subject) q.where('c.subject_type', query.subject);
  const where = keysetWhere(query.cursor, ascending ? '>' : '<');
  if (where) q.whereRaw(where[0], [...where[1]]);

  const rows = (await q) as Array<Record<string, any>>;
  const items = rows.map((r) => ({
    id: r.id as string,
    submitted_at_text: r.submitted_at_text as string,
    subjectType: r.subject_type as SubjectType,
    origin: r.origin as string,
    status: r.status as CaseStatus,
    submittedAt: r.submitted_at as Date,
    submittedBy: r.submitted_by ? { id: r.submitted_by as string, displayName: r.submitter_name as string } : null,
    decidedAt: r.decided_at as Date | null,
    evidenceCount: r.evidence_count as number,
    subject:
      r.subject_type === 'account'
        ? {
            type: 'account' as const,
            userId: r.subject_user_id as string,
            displayName: r.subject_name as string,
            verificationStatus: r.subject_verification as string,
          }
        : {
            type: 'building' as const,
            buildingId: r.subject_building_id as string,
            name: r.building_name as string,
            listerId: r.lister_id as string,
            listerName: r.lister_name as string,
            status: r.building_status as string,
            verificationStatus: r.building_verification as string,
          },
  }));
  return page<QueueItem>(items, query.limit);
}

interface CaseRow {
  id: string;
  subject_type: SubjectType;
  subject_user_id: string | null;
  subject_building_id: string | null;
  origin: string;
  status: CaseStatus;
  submitted_by: string | null;
  submitted_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
  revoked_by: string | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
}

export interface CaseDetail {
  case: {
    id: string;
    subjectType: SubjectType;
    origin: string;
    status: CaseStatus;
    submittedAt: Date;
    submittedBy: { id: string; displayName: string } | null;
    decidedAt: Date | null;
    decidedBy: { id: string; displayName: string } | null;
    decisionReason: string | null;
    revokedAt: Date | null;
    revokedBy: { id: string; displayName: string } | null;
    revokeReason: string | null;
  };
  subject: Record<string, unknown>;
  /** Files are fetched through the Admin-only GET /files/:id/download, which audits `pii.view`. */
  evidence: Array<{
    id: string;
    evidenceType: string;
    fileId: string | null;
    file: { originalName: string; mimeType: string; sizeBytes: number } | null;
    phoneConfirmedAt: Date | null;
    createdAt: Date;
  }>;
  /** Whether the viewing Admin may decide this case now, and if not, why (BR-014). */
  review: { canDecide: boolean; reason: string | null };
}

const CASE_COLUMNS = [
  'id', 'subject_type', 'subject_user_id', 'subject_building_id', 'origin', 'status', 'submitted_by',
  'submitted_at', 'decided_by', 'decided_at', 'decision_reason', 'revoked_by', 'revoked_at', 'revoke_reason',
] as const;

async function loadCaseRow(conn: Conn, caseId: string): Promise<CaseRow> {
  const row = (await conn('verification_cases').where({ id: caseId }).first(...CASE_COLUMNS)) as CaseRow | undefined;
  if (!row) throw notFound('Verification case not found.', { code: 'CASE_NOT_FOUND' });
  return row;
}

async function loadSubjectSummary(conn: Conn, c: CaseRow): Promise<Record<string, unknown>> {
  if (c.subject_type === 'account') {
    const u = (await conn('auth_users as u')
      .join('profiles as p', 'p.user_id', 'u.id')
      .where('u.id', c.subject_user_id)
      .first('u.id', 'u.email', 'p.display_name', 'p.phone', 'p.account_status', 'p.verification_status')) as
      | Record<string, string | null>
      | undefined;
    const roles = [...((await rolesByUser(conn, [c.subject_user_id!])).get(c.subject_user_id!) ?? [])].sort();
    return {
      type: 'account',
      userId: u?.id ?? c.subject_user_id,
      email: u?.email ?? null,
      displayName: u?.display_name ?? null,
      phone: u?.phone ?? null,
      accountStatus: u?.account_status ?? null,
      verificationStatus: u?.verification_status ?? null,
      roles,
    };
  }
  const b = (await conn('buildings as b')
    .join('profiles as lp', 'lp.user_id', 'b.lister_id')
    .where('b.id', c.subject_building_id)
    .first(
      'b.id', 'b.name', 'b.area_id', 'b.status', 'b.verification_status', 'b.lister_id', 'b.created_by',
      'lp.display_name as lister_name',
    )) as Record<string, string> | undefined;
  const maintainers = (await conn('building_maintainers as m')
    .join('profiles as p', 'p.user_id', 'm.user_id')
    .where('m.building_id', c.subject_building_id)
    .orderBy('m.added_at')
    .orderBy('m.id')
    .select('m.user_id', 'p.display_name')) as Array<{ user_id: string; display_name: string }>;
  return {
    type: 'building',
    buildingId: b?.id ?? c.subject_building_id,
    name: b?.name ?? null,
    areaId: b?.area_id ?? null,
    status: b?.status ?? null,
    verificationStatus: b?.verification_status ?? null,
    listerId: b?.lister_id ?? null,
    listerName: b?.lister_name ?? null,
    createdBy: b?.created_by ?? null,
    maintainers: maintainers.map((m) => ({ userId: m.user_id, displayName: m.display_name })),
  };
}

async function namesOf(conn: Conn, ids: Array<string | null>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const rows = (await conn('profiles').whereIn('user_id', wanted).select('user_id', 'display_name')) as Array<{
    user_id: string;
    display_name: string;
  }>;
  return new Map(rows.map((r) => [r.user_id, r.display_name]));
}

/** FR-VER-002 / -004: the case, its subject, the evidence list and whether this Admin may decide it. */
export async function getCase(auth: AuthContext, caseId: string, conn: Conn = db): Promise<CaseDetail> {
  const c = await loadCaseRow(conn, caseId);
  const [subject, names, evidenceRows, facts] = await Promise.all([
    loadSubjectSummary(conn, c),
    namesOf(conn, [c.submitted_by, c.decided_by, c.revoked_by]),
    conn('verification_evidence as e')
      .leftJoin('files as f', 'f.id', 'e.file_id')
      .where('e.case_id', caseId)
      .orderBy('e.created_at')
      .orderBy('e.id')
      .select('e.id', 'e.evidence_type', 'e.file_id', 'e.phone_confirmed_at', 'e.created_at',
        'f.original_name', 'f.mime_type', 'f.size_bytes') as Promise<Array<Record<string, any>>>,
    loadSeparationFacts(conn, auth.user.id, c),
  ]);
  const person = (id: string | null) => (id ? { id, displayName: names.get(id) ?? '' } : null);
  const refusal = separationConflict(facts);
  return {
    case: {
      id: c.id,
      subjectType: c.subject_type,
      origin: c.origin,
      status: c.status,
      submittedAt: c.submitted_at,
      submittedBy: person(c.submitted_by),
      decidedAt: c.decided_at,
      decidedBy: person(c.decided_by),
      decisionReason: c.decision_reason,
      revokedAt: c.revoked_at,
      revokedBy: person(c.revoked_by),
      revokeReason: c.revoke_reason,
    },
    subject,
    evidence: evidenceRows.map((e) => ({
      id: e.id as string,
      evidenceType: e.evidence_type as string,
      fileId: e.file_id as string | null,
      file: e.file_id
        ? { originalName: e.original_name as string, mimeType: e.mime_type as string, sizeBytes: Number(e.size_bytes) }
        : null,
      phoneConfirmedAt: e.phone_confirmed_at as Date | null,
      createdAt: e.created_at as Date,
    })),
    review: { canDecide: c.status === 'pending' && refusal === null, reason: refusal },
  };
}

// ---- separation of duties (BR-014, design §8.1) -----------------------------------------------

export interface SeparationFacts {
  adminId: string;
  submittedBy: string | null;
  subjectUserId: string | null;
  building: { listerId: string; createdBy: string; maintainerIds: string[] } | null;
  /** The Admin has a row in `EDIT_ACTIONS` (or a staff availability event) for this building. */
  editedBuilding: boolean;
}

/**
 * Returns why this Admin must not decide the case, or null. The database already refuses
 * `decided_by = submitted_by` or `= subject_user_id` (`ck_vc_separation`); the rest is here:
 * an Admin cannot decide their own account's case, nor a building they created, listed, maintain
 * or edited (design §8.1, review R-32). Applies to approve and reject alike; revoking is allowed.
 */
export function separationConflict(f: SeparationFacts): string | null {
  if (f.submittedBy === f.adminId) {
    return 'You submitted this case, so you cannot decide it (separation of duties).';
  }
  if (f.subjectUserId === f.adminId) {
    return 'This case is about your own account, so you cannot decide it (separation of duties).';
  }
  if (f.building) {
    if (f.building.listerId === f.adminId || f.building.createdBy === f.adminId || f.building.maintainerIds.includes(f.adminId)) {
      return 'You created, list or maintain this building, so you cannot decide its verification (separation of duties).';
    }
    if (f.editedBuilding) {
      return 'You edited this building, so you cannot decide its verification. Another Admin must (separation of duties).';
    }
  }
  return null;
}

export async function loadSeparationFacts(
  conn: Conn,
  adminId: string,
  c: Pick<CaseRow, 'submitted_by' | 'subject_user_id' | 'subject_building_id'>,
): Promise<SeparationFacts> {
  const base = { adminId, submittedBy: c.submitted_by, subjectUserId: c.subject_user_id };
  if (!c.subject_building_id) return { ...base, building: null, editedBuilding: false };

  const buildingId = c.subject_building_id;
  const [building, maintainers, edited] = await Promise.all([
    conn('buildings').where({ id: buildingId }).first('lister_id', 'created_by') as Promise<
      { lister_id: string; created_by: string } | undefined
    >,
    conn('building_maintainers').where({ building_id: buildingId }).select('user_id') as Promise<
      Array<{ user_id: string }>
    >,
    conn('audit_trail_v')
      .where({ actor_user_id: adminId, building_id: buildingId })
      .where((w) =>
        w
          .whereIn('action', EDIT_ACTIONS as string[])
          .orWhere((x) => x.whereRaw("action LIKE 'availability.%'").whereRaw("changes->>'acted_as_staff' = 'true'")),
      )
      .first('action'),
  ]);
  return {
    ...base,
    building: building
      ? { listerId: building.lister_id, createdBy: building.created_by, maintainerIds: maintainers.map((m) => m.user_id) }
      : null,
    editedBuilding: Boolean(edited),
  };
}

// ---- decide (TX-05), revoke, Admin evidence ---------------------------------------------------

/** Subject row first, case second: the same order as a submit, so the two can never wait on each other. */
async function lockSubject(trx: Knex.Transaction, c: Pick<CaseRow, 'subject_type' | 'subject_user_id' | 'subject_building_id'>) {
  if (c.subject_type === 'building') {
    await lockBuildingRow(trx, c.subject_building_id!);
  } else {
    await trx('profiles').where({ user_id: c.subject_user_id }).forUpdate().first('user_id');
  }
}

async function lockCase(trx: Knex.Transaction, caseId: string): Promise<CaseRow> {
  const head = await loadCaseRow(trx, caseId);
  await lockSubject(trx, head);
  const row = (await trx('verification_cases').where({ id: caseId }).forUpdate().first(...CASE_COLUMNS)) as CaseRow;
  return row;
}

const buildingName = async (trx: Knex.Transaction, id: string) =>
  ((await trx('buildings').where({ id }).first('name')) as { name: string }).name;

/**
 * TX-05: lock the subject row and then the case, refuse anything not pending (the loser of a race
 * between two Admins gets a 409), check separation of duties, update the case (T3 moves the
 * cache), then write the audit and notification rows in the same transaction.
 * N-01 account decision to the applicant, N-02 building decision to the maintainers, and N-13 when
 * a lister becomes Verified and has buildings Pending on that account (FR-VER-008). Buildings are
 * not published here: a maintainer does that next (Phase 5 `POST /buildings/:id/publish`).
 */
export async function decideCase(
  auth: AuthContext,
  caseId: string,
  input: { decision: Decision; reason: string | null },
): Promise<CaseDetail> {
  try {
    await withTx(async (trx) => {
      const c = await lockCase(trx, caseId);
      if (c.status !== 'pending') {
        throw conflict(`This case was already ${c.status}.`, { code: 'CASE_NOT_PENDING', data: { status: c.status } });
      }
      const refusal = separationConflict(await loadSeparationFacts(trx, auth.user.id, c));
      if (refusal) throw refuseSelf(refusal);

      const approved = input.decision === 'approve';
      await trx('verification_cases')
        .where({ id: caseId })
        .update({
          status: approved ? 'approved' : 'rejected',
          decided_by: auth.user.id,
          decided_at: trx.fn.now(),
          decision_reason: input.reason,
        });
      await writeAudit(trx, {
        actorUserId: auth.user.id,
        actorType: 'staff',
        action: approved ? 'verification.approve' : 'verification.reject',
        objectType: 'verification_case',
        objectId: caseId,
        buildingId: c.subject_building_id,
        changes: { subjectType: c.subject_type, origin: c.origin, reason: input.reason },
      });

      const outcome = approved ? 'approved' : 'rejected';
      if (c.subject_type === 'account') {
        await notifyEach(trx, [c.subject_user_id!], EVENT_ACCOUNT_DECISION, {
          caseId, subjectType: 'account', decision: outcome, reason: input.reason, origin: c.origin,
        });
        if (approved) await notifyListerVerified(trx, c.subject_user_id!);
      } else {
        await notifyEach(trx, await maintainerRecipients(trx, c.subject_building_id!), EVENT_BUILDING_DECISION, {
          caseId,
          subjectType: 'building',
          buildingId: c.subject_building_id,
          buildingName: await buildingName(trx, c.subject_building_id!),
          decision: outcome,
          reason: input.reason,
          origin: c.origin,
        });
      }
    });
  } catch (err) {
    throw mapCaseViolation(err);
  }
  return getCase(auth, caseId);
}

/** N-13: tell the maintainers of the new lister's Pending buildings they can confirm and publish now. */
async function notifyListerVerified(trx: Knex.Transaction, listerId: string): Promise<void> {
  const pending = (await trx('buildings')
    .where({ lister_id: listerId, status: 'pending' })
    .orderBy('id')
    .select('id', 'name')) as Array<{ id: string; name: string }>;
  for (const building of pending) {
    await notifyEach(trx, await maintainerRecipients(trx, building.id), EVENT_LISTER_VERIFIED, {
      listerId, buildingId: building.id, buildingName: building.name,
    });
  }
}

/** FR-VER-006: approved -> revoked with a mandatory reason; the applicant or maintainers are told (N-03). */
export async function revokeVerification(auth: AuthContext, input: RevokeInput): Promise<CaseDetail> {
  const caseId = await withTx(async (trx) => {
    if (input.subject === 'building') {
      await lockBuildingRow(trx, input.id);
    } else {
      const profile = await trx('profiles').where({ user_id: input.id }).forUpdate().first('user_id');
      if (!profile) throw notFound('Account not found.', { code: 'ACCOUNT_NOT_FOUND' });
    }
    const subjectFilter =
      input.subject === 'building'
        ? { subject_type: 'building', subject_building_id: input.id }
        : { subject_type: 'account', subject_user_id: input.id };
    const c = (await trx('verification_cases')
      .where({ ...subjectFilter, status: 'approved' })
      .forUpdate()
      .first(...CASE_COLUMNS)) as CaseRow | undefined;
    if (!c) {
      throw conflict(`This ${input.subject} is not currently verified, so there is nothing to revoke.`, {
        code: 'NOT_VERIFIED',
      });
    }
    await trx('verification_cases')
      .where({ id: c.id })
      .update({ status: 'revoked', revoked_by: auth.user.id, revoked_at: trx.fn.now(), revoke_reason: input.reason });
    await writeAudit(trx, {
      actorUserId: auth.user.id,
      actorType: 'staff',
      action: 'verification.revoke',
      objectType: 'verification_case',
      objectId: c.id,
      buildingId: c.subject_building_id,
      changes: { subjectType: input.subject, reason: input.reason },
    });
    const payload = { caseId: c.id, subjectType: input.subject, kind: 'revoked', reason: input.reason };
    if (input.subject === 'account') {
      await notifyEach(trx, [input.id], EVENT_REVOKED_OR_REOPENED, payload);
    } else {
      await notifyEach(trx, await maintainerRecipients(trx, input.id), EVENT_REVOKED_OR_REOPENED, {
        ...payload, buildingId: input.id, buildingName: await buildingName(trx, input.id),
      });
    }
    return c.id;
  });
  return getCase(auth, caseId);
}

export interface AddedEvidence {
  id: string;
  evidenceType: string;
  phoneConfirmedAt: Date | null;
  createdAt: Date;
}

/**
 * The Admin records `phone_confirmation` while reviewing an account case (there is no SMS channel).
 * Only on a pending case, once per type, and not by the Admin the case is about or who submitted it.
 */
export async function addAdminEvidence(auth: AuthContext, caseId: string, evidenceType: string): Promise<AddedEvidence> {
  return withTx(async (trx) => {
    const c = await lockCase(trx, caseId);
    if (!EVIDENCE_RULES[c.subject_type].admin.includes(evidenceType)) {
      const accepted = EVIDENCE_RULES[c.subject_type].admin;
      throw badRequest(
        `An Admin cannot add "${evidenceType}" to a ${c.subject_type} case.${accepted.length ? ` Accepted: ${accepted.join(', ')}.` : ''}`,
        { code: 'EVIDENCE_TYPE_NOT_ALLOWED' },
      );
    }
    if (c.status !== 'pending') {
      throw conflict(`This case was already ${c.status}; evidence can only be added while it is pending.`, {
        code: 'CASE_NOT_PENDING',
      });
    }
    const refusal = separationConflict(await loadSeparationFacts(trx, auth.user.id, c));
    if (refusal) throw refuseSelf(refusal);
    const existing = await trx('verification_evidence').where({ case_id: caseId, evidence_type: evidenceType }).first('id');
    if (existing) throw conflict(`"${evidenceType}" is already recorded on this case.`, { code: 'EVIDENCE_EXISTS' });

    const [row] = (await trx('verification_evidence')
      .insert({ case_id: caseId, evidence_type: evidenceType, phone_confirmed_at: trx.fn.now() })
      .returning(['id', 'evidence_type', 'phone_confirmed_at', 'created_at'])) as Array<{
      id: string;
      evidence_type: string;
      phone_confirmed_at: Date;
      created_at: Date;
    }>;
    await writeAudit(trx, {
      actorUserId: auth.user.id,
      actorType: 'staff',
      action: 'verification.evidence.add',
      objectType: 'verification_case',
      objectId: caseId,
      buildingId: c.subject_building_id,
      changes: { evidenceType },
    });
    return {
      id: row!.id,
      evidenceType: row!.evidence_type,
      phoneConfirmedAt: row!.phone_confirmed_at,
      createdAt: row!.created_at,
    };
  });
}

// ---- re-verification after a material change (FR-VER-007) --------------------------------------

/**
 * Service half of FR-VER-007 for BUILDINGS. T6 has already superseded the approved case and opened
 * the `material_change` one when the area or pin of a Verified building changed; this finds that
 * case, tells the maintainers and every Admin (N-03, "reopened") and writes the audit row that
 * names the editor (T6 cannot know who it was). Call inside the editing transaction, after the
 * UPDATE, and only when the building was `verified` beforehand. Space type edits never get here.
 */
export async function recordBuildingReopened(
  trx: Knex.Transaction,
  args: { buildingId: string; actorUserId: string; actorType: 'user' | 'staff'; changed: string[] },
): Promise<string | null> {
  const c = (await trx('verification_cases')
    .where({ subject_type: 'building', subject_building_id: args.buildingId, origin: 'material_change', status: 'pending' })
    .first('id')) as { id: string } | undefined;
  if (!c) return null;
  const name = await buildingName(trx, args.buildingId);
  await notifyEach(
    trx,
    [...(await maintainerRecipients(trx, args.buildingId)), ...(await adminRecipients(trx))],
    EVENT_REVOKED_OR_REOPENED,
    {
      caseId: c.id, subjectType: 'building', kind: 'reopened', cause: 'material_change',
      buildingId: args.buildingId, buildingName: name, changed: args.changed,
    },
  );
  await writeAudit(trx, {
    actorUserId: args.actorUserId,
    actorType: args.actorType,
    action: 'verification.reopen',
    objectType: 'verification_case',
    objectId: c.id,
    buildingId: args.buildingId,
    changes: { subjectType: 'building', cause: 'material_change', changed: args.changed },
  });
  return c.id;
}

/** Account half (ASM-16): `PATCH /me` opened the case; tell every Admin and record it (N-03). */
export async function recordAccountReopened(
  trx: Knex.Transaction,
  args: { userId: string; caseId: string; changed: string[] },
): Promise<void> {
  await notifyEach(trx, await adminRecipients(trx), EVENT_REVOKED_OR_REOPENED, {
    caseId: args.caseId, subjectType: 'account', kind: 'reopened', cause: 'material_change',
    userId: args.userId, changed: args.changed,
  });
  await writeAudit(trx, {
    actorUserId: args.userId,
    actorType: 'user',
    action: 'verification.reopen',
    objectType: 'verification_case',
    objectId: args.caseId,
    changes: { subjectType: 'account', cause: 'material_change', changed: args.changed },
  });
}
