import type { Knex } from 'knex';
import db from '../../db/knex.js';
import { withTx } from '../../db/tx.js';
import { writeAudit } from '../../lib/audit.js';
import { conflict, HttpError, notFound } from '../../lib/http-error.js';
import type { AuthContext } from '../../middlewares/auth.js';
import { EXPORT_WINDOW_DAYS } from './schemas.js';

/**
 * Personal data export (FR-PRV-002 access and portability, design §10.8), assembled on demand from
 * the tables below, joined on the user id. It is never stored. NFR-PRV-02: nothing about another
 * person is included, so for threads only the requester's OWN messages are returned.
 *
 * Sections and columns (see also design §10.8):
 *   account       auth_users: id, email, name, email_verified, created_at
 *   profile       profiles: display_name, phone, language, agent_type, photo_file_id, account_status,
 *                 suspended_reason, verification_status, last_login_at, created_at, updated_at
 *   roles         user_roles: role, granted_at
 *   consents      consent_records + privacy_notice_versions: version, effective_at, accepted_at
 *   buildings     building_maintainers + buildings: id, name, status, isLister, isContact, addedAt
 *   enquiries     enquiries the user started or wrote in: id, space_type_id, asClient, status,
 *                 closed_reason, created_at, last_message_at; messages: enquiry_messages written by
 *                 the user only (id, body, created_at)
 *   viewingRequests  viewing_requests where the user is the client: id, space_type_id, requested_for,
 *                 counter_for, status, cancel_reason, created_at
 *   reports       reports the user filed: id, building_id, space_type_id, reason, comment, status,
 *                 created_at, resolved_at (the staff resolution note is not included)
 *   contactEvents contact_events with the user id: id, building_id, space_type_id, created_at
 *   notifications notifications: id, event_code, payload, read_at, created_at
 *   files         files uploaded by the user (metadata only, no bytes or storage path): id,
 *                 original_name, mime_type, size_bytes, width_px, height_px, visibility, created_at,
 *                 purged_at
 *   verificationCases  verification_cases the user submitted or is the subject of: id, subject_type,
 *                 subject_building_id, origin, status, submitted_at, decided_at, and the reason shown
 *                 to them (decision_reason, revoke_reason); evidence: evidence_type, file_id, created_at
 *   dataRequests  data_subject_requests of the user: id, request_type, status, note, requested_at,
 *                 completed_at, outcome
 *
 * Never included: password hashes (`auth_accounts`), sessions, tokens (`auth_sessions`,
 * `auth_refresh_tokens`, `auth_verifications`), other people's messages or profiles, audit rows.
 */
export const EXPORT_SECTIONS = [
  'account',
  'profile',
  'roles',
  'consents',
  'buildings',
  'enquiries',
  'viewingRequests',
  'reports',
  'contactEvents',
  'notifications',
  'files',
  'verificationCases',
  'dataRequests',
] as const;

type Row = Record<string, unknown>;

export interface PersonalDataExport {
  generatedAt: string;
  userId: string;
  sections: Record<(typeof EXPORT_SECTIONS)[number], unknown>;
}

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));

const mapAccount = (a: Row) => ({
  id: a.id, email: a.email, name: a.name, emailVerified: a.email_verified, createdAt: iso(a.created_at),
});
const mapProfile = (p: Row) => ({
  displayName: p.display_name, phone: p.phone, language: p.language, agentType: p.agent_type,
  photoFileId: p.photo_file_id, accountStatus: p.account_status, suspendedReason: p.suspended_reason,
  verificationStatus: p.verification_status, lastLoginAt: iso(p.last_login_at),
  createdAt: iso(p.created_at), updatedAt: iso(p.updated_at),
});
const mapRoles = (rows: Row[]) => rows.map((r) => ({ role: r.role, grantedAt: iso(r.granted_at) }));
const mapConsents = (rows: Row[]) =>
  rows.map((c) => ({ version: c.version, effectiveAt: iso(c.effective_at), acceptedAt: iso(c.accepted_at) }));

/** The four sections `GET /me/data` returns, which the user can already see in the app. */
async function loadIdentity(trx: Knex.Transaction, userId: string) {
  const account = (await trx('auth_users').where({ id: userId }).first('id', 'email', 'name', 'email_verified', 'created_at')) as Row;
  const profile = (await trx('profiles')
    .where({ user_id: userId })
    .first(
      'display_name', 'phone', 'language', 'agent_type', 'photo_file_id', 'account_status', 'suspended_reason',
      'verification_status', 'last_login_at', 'created_at', 'updated_at',
    )) as Row;
  const roles = (await trx('user_roles').where({ user_id: userId }).orderBy('role').select('role', 'granted_at')) as Row[];
  const consents = (await trx('consent_records as c')
    .join('privacy_notice_versions as v', 'v.id', 'c.notice_version_id')
    .where('c.user_id', userId)
    .orderBy('c.accepted_at')
    .select('v.version', 'v.effective_at', 'c.accepted_at')) as Row[];
  return { account, profile, roles, consents };
}

/** Reads every section in one transaction (a consistent snapshot) and returns the document. */
export async function assemblePersonalData(trx: Knex.Transaction, userId: string): Promise<PersonalDataExport> {
  const { account, profile, roles, consents } = await loadIdentity(trx, userId);
  const buildings = (await trx('building_maintainers as m')
    .join('buildings as b', 'b.id', 'm.building_id')
    .where('m.user_id', userId)
    .orderBy('b.name')
    .orderBy('b.id')
    .select(
      'b.id', 'b.name', 'b.status', 'm.added_at',
      trx.raw('(b.lister_id = m.user_id) AS is_lister'),
      trx.raw('(b.contact_user_id = m.user_id) AS is_contact'),
    )) as Row[];

  const threads = (await trx('enquiries as e')
    .where('e.client_id', userId)
    .orWhereExists(trx('enquiry_messages as x').whereRaw('x.enquiry_id = e.id').where('x.sender_id', userId))
    .orderBy('e.created_at')
    .orderBy('e.id')
    .select('e.id', 'e.space_type_id', 'e.client_id', 'e.status', 'e.closed_reason', 'e.created_at', 'e.last_message_at')) as Row[];
  const ownMessages = threads.length
    ? ((await trx('enquiry_messages')
        .whereIn('enquiry_id', threads.map((t) => t.id as string))
        .where({ sender_id: userId })
        .orderBy('created_at')
        .orderBy('id')
        .select('id', 'enquiry_id', 'body', 'created_at')) as Row[])
    : [];

  const viewingRequests = (await trx('viewing_requests')
    .where({ client_id: userId })
    .orderBy('created_at')
    .orderBy('id')
    .select('id', 'space_type_id', 'requested_for', 'counter_for', 'status', 'cancel_reason', 'created_at')) as Row[];
  const reports = (await trx('reports')
    .where({ client_id: userId })
    .orderBy('created_at')
    .orderBy('id')
    .select('id', 'building_id', 'space_type_id', 'reason', 'comment', 'status', 'created_at', 'resolved_at')) as Row[];
  const contactEvents = (await trx('contact_events')
    .where({ user_id: userId })
    .orderBy('created_at')
    .orderBy('id')
    .select('id', 'building_id', 'space_type_id', 'created_at')) as Row[];
  const notifications = (await trx('notifications')
    .where({ user_id: userId })
    .orderBy('created_at')
    .orderBy('id')
    .select('id', 'event_code', 'payload', 'read_at', 'created_at')) as Row[];
  const files = (await trx('files')
    .where({ uploaded_by: userId })
    .orderBy('created_at')
    .orderBy('id')
    .select('id', 'original_name', 'mime_type', 'size_bytes', 'width_px', 'height_px', 'visibility', 'created_at', 'purged_at')) as Row[];

  const cases = (await trx('verification_cases')
    .where({ submitted_by: userId })
    .orWhere({ subject_user_id: userId })
    .orderBy('submitted_at')
    .orderBy('id')
    .select(
      'id', 'subject_type', 'subject_building_id', 'origin', 'status', 'submitted_at', 'decided_at', 'decision_reason', 'revoke_reason',
    )) as Row[];
  const evidence = cases.length
    ? ((await trx('verification_evidence')
        .whereIn('case_id', cases.map((c) => c.id as string))
        .orderBy('created_at')
        .orderBy('id')
        .select('case_id', 'evidence_type', 'file_id', 'created_at')) as Row[])
    : [];
  const dataRequests = (await trx('data_subject_requests')
    .where({ user_id: userId })
    .orderBy('requested_at')
    .orderBy('id')
    .select('id', 'request_type', 'status', 'note', 'requested_at', 'completed_at', 'outcome')) as Row[];

  return {
    generatedAt: new Date().toISOString(),
    userId,
    sections: {
      account: mapAccount(account),
      profile: mapProfile(profile),
      roles: mapRoles(roles),
      consents: mapConsents(consents),
      buildings: buildings.map((b) => ({
        id: b.id, name: b.name, status: b.status, isLister: b.is_lister, isContact: b.is_contact, addedAt: iso(b.added_at),
      })),
      enquiries: threads.map((t) => ({
        id: t.id,
        spaceTypeId: t.space_type_id,
        asClient: t.client_id === userId,
        status: t.status,
        closedReason: t.closed_reason,
        createdAt: iso(t.created_at),
        lastMessageAt: iso(t.last_message_at),
        // Only what this user wrote (NFR-PRV-02): the other side's messages are their personal data.
        messages: ownMessages
          .filter((m) => m.enquiry_id === t.id)
          .map((m) => ({ id: m.id, body: m.body, createdAt: iso(m.created_at) })),
      })),
      viewingRequests: viewingRequests.map((v) => ({
        id: v.id, spaceTypeId: v.space_type_id, requestedFor: iso(v.requested_for), counterFor: iso(v.counter_for),
        status: v.status, cancelReason: v.cancel_reason, createdAt: iso(v.created_at),
      })),
      reports: reports.map((r) => ({
        id: r.id, buildingId: r.building_id, spaceTypeId: r.space_type_id, reason: r.reason, comment: r.comment,
        status: r.status, createdAt: iso(r.created_at), resolvedAt: iso(r.resolved_at),
      })),
      contactEvents: contactEvents.map((c) => ({
        id: c.id, buildingId: c.building_id, spaceTypeId: c.space_type_id, createdAt: iso(c.created_at),
      })),
      notifications: notifications.map((n) => ({
        id: n.id, eventCode: n.event_code, payload: n.payload, readAt: iso(n.read_at), createdAt: iso(n.created_at),
      })),
      files: files.map((f) => ({
        id: f.id, originalName: f.original_name, mimeType: f.mime_type, sizeBytes: Number(f.size_bytes),
        widthPx: f.width_px, heightPx: f.height_px, visibility: f.visibility, createdAt: iso(f.created_at), purgedAt: iso(f.purged_at),
      })),
      verificationCases: cases.map((c) => ({
        id: c.id, subjectType: c.subject_type, subjectBuildingId: c.subject_building_id, origin: c.origin,
        status: c.status, submittedAt: iso(c.submitted_at), decidedAt: iso(c.decided_at),
        decisionReason: c.decision_reason, revokeReason: c.revoke_reason,
        evidence: evidence
          .filter((e) => e.case_id === c.id)
          .map((e) => ({ evidenceType: e.evidence_type, fileId: e.file_id, createdAt: iso(e.created_at) })),
      })),
      dataRequests: dataRequests.map((r) => ({
        id: r.id, type: r.request_type, status: r.status, note: r.note, requestedAt: iso(r.requested_at),
        completedAt: iso(r.completed_at), outcome: r.outcome,
      })),
    },
  };
}

/**
 * `GET /me/data-requests/:id/export`: only for the requester's own `export` or `access` request,
 * only while it is `completed` and its completion is at most `EXPORT_WINDOW_DAYS` old. Every
 * generation writes one `export.run` audit row in the same transaction (section names and counts,
 * no personal values).
 */
export async function runExport(auth: AuthContext, requestId: string, now: Date = new Date()): Promise<PersonalDataExport> {
  return withTx(async (trx) => {
    await trx.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'); // one snapshot for every section
    const request = (await trx('data_subject_requests')
      .where({ id: requestId, user_id: auth.user.id })
      .first('id', 'request_type', 'status', 'completed_at')) as
      | { id: string; request_type: string; status: string; completed_at: Date | null }
      | undefined;
    // Someone else's request looks exactly like a missing one.
    if (!request) throw notFound('Data request not found.', { code: 'REQUEST_NOT_FOUND' });
    if (request.request_type !== 'export' && request.request_type !== 'access') {
      throw conflict('Only an access or export request has a download.', { code: 'NOT_AN_EXPORT_REQUEST' });
    }
    if (request.status !== 'completed' || !request.completed_at) {
      throw conflict('This request has not been completed yet.', { code: 'REQUEST_NOT_COMPLETED' });
    }
    if (now.getTime() - request.completed_at.getTime() > EXPORT_WINDOW_DAYS * 86_400_000) {
      throw new HttpError(410, `The download expired ${EXPORT_WINDOW_DAYS} days after completion. Make a new request.`, {
        code: 'EXPORT_EXPIRED',
      });
    }
    const data = await assemblePersonalData(trx, auth.user.id);
    await writeAudit(trx, {
      actorUserId: auth.user.id,
      actorType: 'user',
      action: 'export.run',
      objectType: 'data_subject_request',
      objectId: requestId,
      changes: {
        requestType: request.request_type,
        sections: [...EXPORT_SECTIONS],
        counts: Object.fromEntries(
          Object.entries(data.sections).map(([k, v]) => [k, Array.isArray(v) ? v.length : 1]),
        ),
      },
    });
    return data;
  });
}

/** `GET /me/data`: what the user can already view in the app: account, profile, roles, consents, verification. */
export async function getOwnData(auth: AuthContext) {
  const { account, profile, roles, consents } = await withTx((trx) => loadIdentity(trx, auth.user.id));
  const { verificationStatus, ...rest } = mapProfile(profile);
  return {
    account: mapAccount(account),
    profile: rest,
    roles: mapRoles(roles),
    consents: mapConsents(consents),
    verification: { status: verificationStatus },
  };
}
