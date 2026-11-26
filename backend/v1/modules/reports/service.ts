import { withTx } from '../../db/tx.js';
import { writeAudit } from '../../lib/audit.js';
import { isMaintainerOf, loadSpaceTypeContext } from '../../lib/engagement.js';
import { conflict, forbidden, notFound } from '../../lib/http-error.js';
import { keysetPage, keysetWhere } from '../../lib/keyset.js';
import { EVENT_REPORT_RECEIVED, maintainerRecipients, notifyEach } from '../../lib/notify.js';
import type { AuthContext } from '../../middlewares/auth.js';
import type { CreateReportInput, ListReportsQuery, ReportReason, ReportStatus, ResolveReportInput } from './schemas.js';

export type ReportTarget = { type: 'building' | 'space_type'; id: string };

export interface ReportReceipt {
  id: string;
  status: ReportStatus;
  reason: ReportReason;
  /** True when this client already had an open report on the target: that one is returned, nothing new is written. */
  duplicate: boolean;
}

type ReportRow = { id: string; status: ReportStatus; reason: ReportReason };

/**
 * FR-AVL-010 / BR-008: a logged-in user reports a building or a space type. A repeat open report by
 * the same client on the same target is counted once: the partial unique index decides
 * (`ON CONFLICT ... DO NOTHING`, the predicate repeated as a literal, design §7.4) and the existing
 * report comes back with `duplicate: true` (HTTP 200), not an error. The reason and comment of the
 * first report stand. N-09 goes to the maintainers with the reason but never the comment (OQ-50:
 * the comment is for the Admin queue only); the Admin queue itself is the Admin's notification.
 */
export async function createReport(auth: AuthContext, target: ReportTarget, input: CreateReportInput): Promise<ReportReceipt> {
  return withTx(async (trx) => {
    let buildingId: string;
    let buildingName: string;
    let spaceType: { id: string; name: string } | null = null;
    if (target.type === 'building') {
      const b = (await trx('buildings').where({ id: target.id }).first('id', 'name', 'status')) as
        | { id: string; name: string; status: string }
        | undefined;
      // Only buildings the public can see are reportable; the rest answer as if they did not exist.
      if (!b || b.status !== 'published') throw notFound('Building not found.', { code: 'BUILDING_NOT_FOUND' });
      buildingId = b.id;
      buildingName = b.name;
    } else {
      const ctx = await loadSpaceTypeContext(trx, target.id);
      if (ctx.removed || ctx.buildingStatus !== 'published') {
        throw notFound('Space type not found.', { code: 'SPACE_TYPE_NOT_FOUND' });
      }
      buildingId = ctx.buildingId;
      buildingName = ctx.buildingName;
      spaceType = { id: ctx.id, name: ctx.name };
    }
    if (await isMaintainerOf(trx, buildingId, auth.user.id)) {
      throw forbidden('You maintain this building, so you cannot report it.', { code: 'OWN_BUILDING' });
    }

    const targetColumn = target.type === 'building' ? 'building_id' : 'space_type_id';
    const inserted = (await trx.raw(
      `INSERT INTO reports (${targetColumn}, client_id, reason, comment)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (client_id, ${targetColumn}) WHERE status = 'open' AND ${targetColumn} IS NOT NULL
       DO NOTHING
       RETURNING id, status, reason`,
      [target.id, auth.user.id, input.reason, input.comment],
    )) as { rows: ReportRow[] };

    if (!inserted.rows[0]) {
      const existing = (await trx('reports')
        .where({ client_id: auth.user.id, [targetColumn]: target.id, status: 'open' })
        .first('id', 'status', 'reason')) as ReportRow | undefined;
      // The earlier report was resolved between our insert and this read: ask the client to resend.
      if (!existing) throw conflict('Your earlier report was just resolved. Please send it again.', { code: 'REPORT_RACE' });
      return { ...existing, duplicate: true };
    }

    const report = inserted.rows[0];
    await notifyEach(trx, await maintainerRecipients(trx, buildingId), EVENT_REPORT_RECEIVED, {
      reportId: report.id,
      targetType: target.type,
      reason: input.reason,
      buildingId,
      buildingName,
      ...(spaceType ? { spaceTypeId: spaceType.id, spaceTypeName: spaceType.name } : {}),
    });
    return { ...report, duplicate: false };
  });
}

export interface ReportItem {
  id: string;
  status: ReportStatus;
  reason: ReportReason;
  /** Admin only (OQ-50). */
  comment: string | null;
  createdAt: Date;
  target: {
    type: 'building' | 'space_type';
    building: { id: string; name: string; status: string };
    spaceType: { id: string; name: string } | null;
  };
  reporter: { id: string; displayName: string };
  resolvedBy: string | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
}

interface ListRow {
  id: string;
  status: ReportStatus;
  reason: ReportReason;
  comment: string | null;
  created_at: Date;
  cursor_t: string;
  space_type_id: string | null;
  space_type_name: string | null;
  building_id: string;
  building_name: string;
  building_status: string;
  client_id: string;
  client_display_name: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  resolution_note: string | null;
}

/**
 * FR-ADM-005: the Admin queue, oldest first, keyset-paged on `(created_at, id)`. No filter on the
 * building's status, so a report on a Suspended or Withdrawn building is still listed. The page
 * carries personal data (reporter, comment), so each read writes one `pii.view` audit row.
 */
export async function listReports(
  auth: AuthContext,
  { limit, cursor, status }: ListReportsQuery,
): Promise<{ items: ReportItem[]; nextCursor: string | null }> {
  const conditions = ['r.status = ?'];
  const bindings: Array<string | number> = [status];
  const where = keysetWhere('r.created_at', 'r.id', cursor, 'asc');
  if (where) {
    conditions.push(where[0]);
    bindings.push(...where[1]);
  }
  return withTx(async (trx) => {
    const { rows } = (await trx.raw(
      `SELECT r.id, r.status, r.reason, r.comment, r.created_at, r.created_at::text AS cursor_t,
              r.space_type_id, st.name AS space_type_name, b.id AS building_id, b.name AS building_name,
              b.status AS building_status, r.client_id, cp.display_name AS client_display_name,
              r.resolved_by, r.resolved_at, r.resolution_note
         FROM reports r
         LEFT JOIN space_types st ON st.id = r.space_type_id
         JOIN buildings b ON b.id = COALESCE(r.building_id, st.building_id)
         LEFT JOIN profiles cp ON cp.user_id = r.client_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY r.created_at, r.id
        LIMIT ?`,
      [...bindings, limit + 1],
    )) as { rows: ListRow[] };
    const page = keysetPage(rows, limit);
    if (page.items.length > 0) {
      await writeAudit(trx, {
        actorUserId: auth.user.id,
        actorType: 'staff',
        action: 'pii.view',
        objectType: 'report',
        changes: { fields: ['reports.comment', 'reporter'], count: page.items.length },
      });
    }
    return {
      nextCursor: page.nextCursor,
      items: page.items.map((r) => ({
        id: r.id,
        status: r.status,
        reason: r.reason,
        comment: r.comment,
        createdAt: r.created_at,
        target: {
          type: r.space_type_id ? 'space_type' : 'building',
          building: { id: r.building_id, name: r.building_name, status: r.building_status },
          spaceType: r.space_type_id ? { id: r.space_type_id, name: r.space_type_name ?? '' } : null,
        },
        reporter: { id: r.client_id, displayName: r.client_display_name ?? 'Deleted user' },
        resolvedBy: r.resolved_by,
        resolvedAt: r.resolved_at,
        resolutionNote: r.resolution_note,
      })),
    };
  });
}

/** FR-ADM-005: record who resolved a report and how. Compare-and-swap on `status = 'open'`. */
export async function resolveReport(
  auth: AuthContext,
  reportId: string,
  input: ResolveReportInput,
): Promise<{ id: string; status: ReportStatus; resolvedAt: Date; resolutionNote: string | null }> {
  return withTx(async (trx) => {
    const rows = (await trx('reports')
      .where({ id: reportId, status: 'open' })
      .update({
        status: input.resolution,
        resolved_by: auth.user.id,
        resolved_at: trx.fn.now(),
        resolution_note: input.note,
      })
      .returning(['id', 'status', 'resolved_at', 'resolution_note', 'building_id', 'space_type_id'])) as Array<{
      id: string;
      status: ReportStatus;
      resolved_at: Date;
      resolution_note: string | null;
      building_id: string | null;
      space_type_id: string | null;
    }>;
    const row = rows[0];
    if (!row) {
      const exists = await trx('reports').where({ id: reportId }).first('id');
      if (!exists) throw notFound('Report not found.', { code: 'REPORT_NOT_FOUND' });
      throw conflict('This report has already been resolved.', { code: 'REPORT_ALREADY_RESOLVED' });
    }
    const buildingId =
      row.building_id ??
      ((await trx('space_types').where({ id: row.space_type_id! }).first('building_id')) as { building_id: string }).building_id;
    await writeAudit(trx, {
      actorUserId: auth.user.id,
      actorType: 'staff',
      action: 'report.resolve',
      objectType: 'report',
      objectId: reportId,
      buildingId,
      changes: { resolution: input.resolution },
    });
    return { id: row.id, status: row.status, resolvedAt: row.resolved_at, resolutionNote: row.resolution_note };
  });
}
