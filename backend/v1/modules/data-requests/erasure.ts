import type { Knex } from 'knex';
import db from '../../db/knex.js';
import { withTx } from '../../db/tx.js';
import { writeAudit } from '../../lib/audit.js';
import { conflict, forbidden, notFound, serviceUnavailable } from '../../lib/http-error.js';
import { revokeAllUserTokens } from '../../lib/tokens.js';
import { sendEmail } from '../../lib/mailer.js';
import type { AuthContext } from '../../middlewares/auth.js';
import { activeMaintainers, CLEARED_SUSPENSION, lockBuildings } from '../moderation/service.js';
import { hasDeliverableEmail, safeErrorReason, type EmailSender } from '../notifications/deliver.js';
import { renderEmail, renderNotification } from '../notifications/templates.js';

/**
 * Erasure (TX-10, design §10.6): anonymise a user in place when an Admin completes a `deletion`
 * request.
 *
 * Order, and why (design §10.6 step 10, review R-07, re-review N-06):
 *   1. Checks that need no lock (so a refusal never sends the e-mail).
 *   2. The completion e-mail, OUTSIDE any transaction and BEFORE it: step 3 replaces the address, and
 *      a slow mail provider must not hold locks. It is claimed with a lease, sent, then recorded in
 *      `completion_email_sent_at`, so a retry after a failure never sends it twice.
 *   3. One transaction: the request row (compare-and-swap), the user's buildings (ascending id, then
 *      the profile, the same order as TX-09), then the personal data.
 */

export const ERASED_NAME = 'Deleted user';
export const erasedEmail = (userId: string): string => `erased+${userId}@invalid`;
/** A claim older than this is abandoned (the process died between claim and send). */
const EMAIL_LEASE_MINUTES = 10;

let senderOverride: EmailSender | null = null;
/** Tests inject a fake sender here when the call goes through HTTP (same idea as `setCloudinaryClient`). */
export const setCompletionEmailSender = (sender: EmailSender | null): void => {
  senderOverride = sender;
};

export type CompletionEmailOutcome = 'sent' | 'already_sent' | 'skipped';

export interface ErasureResult {
  requestId: string;
  userId: string;
  completionEmail: CompletionEmailOutcome;
  buildings: {
    withdrawn: Array<{ id: string; name: string; from: string }>;
    contactReassigned: Array<{ id: string; name: string; newContactUserId: string }>;
  };
  filesQueuedForPurge: number;
}

export interface EraseOptions {
  /** Inject a fake in tests; defaults to the real mailer. */
  sender?: EmailSender;
}

/** Other Admins that are active and not erased: the last one cannot be erased (as in TX-09). */
async function otherActiveAdmins(conn: Knex | Knex.Transaction, userId: string): Promise<number> {
  const isAdmin = Boolean(await conn('user_roles').where({ user_id: userId, role: 'admin' }).first('id'));
  if (!isAdmin) return Number.POSITIVE_INFINITY;
  const row = (await conn('user_roles as r')
    .join('profiles as p', 'p.user_id', 'r.user_id')
    .where('r.role', 'admin')
    .whereNot('r.user_id', userId)
    .where('p.account_status', 'active')
    .whereNull('p.erased_at')
    .count({ n: 'r.id' })
    .first()) as { n: string | number };
  return Number(row.n);
}

const lastAdmin = () =>
  conflict('This is the last active Admin and cannot be erased.', { code: 'LAST_ADMIN' });

/** Step 2. Returns `already_sent` when an earlier attempt got the mail out. */
async function sendCompletionEmail(
  requestId: string,
  userId: string,
  send: EmailSender,
): Promise<CompletionEmailOutcome> {
  const claimed = await db('data_subject_requests')
    .where({ id: requestId, status: 'in_progress' })
    .whereNull('completion_email_sent_at')
    .where((q) =>
      q
        .whereNull('completion_email_claimed_at')
        .orWhereRaw(`completion_email_claimed_at < now() - make_interval(mins => ${EMAIL_LEASE_MINUTES})`),
    )
    .update({ completion_email_claimed_at: db.fn.now() })
    .returning('id');
  if (claimed.length === 0) {
    const current = (await db('data_subject_requests')
      .where({ id: requestId })
      .first('completion_email_sent_at')) as { completion_email_sent_at: Date | null } | undefined;
    if (current?.completion_email_sent_at) return 'already_sent';
    throw conflict('The completion e-mail for this request is being sent. Try again shortly.', {
      code: 'EMAIL_IN_PROGRESS',
    });
  }

  const release = () =>
    db('data_subject_requests').where({ id: requestId }).update({ completion_email_claimed_at: null });

  const recipient = (await db('auth_users as u')
    .join('profiles as p', 'p.user_id', 'u.id')
    .where('u.id', userId)
    .first('u.email', 'p.language', 'p.erased_at')) as
    | { email: string; language: string; erased_at: Date | null }
    | undefined;
  if (!recipient || !hasDeliverableEmail(recipient.email, recipient.erased_at)) {
    await release();
    return 'skipped';
  }

  try {
    const mail = renderEmail(
      renderNotification('N-12', { kind: 'deletion_completed', requestType: 'deletion' }, recipient.language),
    );
    const outcome = await send({ to: recipient.email, ...mail, idempotencyKey: `data-request-${requestId}-completed` });
    if (!outcome.sent) {
      await release(); // no mail provider is configured (development only)
      return 'skipped';
    }
  } catch (err) {
    await release();
    console.error(`data-request ${requestId}: completion e-mail failed (${safeErrorReason(err)})`);
    throw serviceUnavailable('The completion e-mail could not be sent, so nothing was erased. Try again.', {
      code: 'COMPLETION_EMAIL_FAILED',
    });
  }
  await db('data_subject_requests').where({ id: requestId }).update({ completion_email_sent_at: db.fn.now() });
  await writeAudit(db, {
    actorUserId: null,
    actorType: 'system',
    action: 'data_request.completion_email',
    objectType: 'data_subject_request',
    objectId: requestId,
    changes: { kind: 'deletion_completed' },
  });
  return 'sent';
}

/**
 * FR-PRV-002 + TX-10: the Admin completes a `deletion` request, which erases the requester.
 * Refuses: not a deletion request, not `in_progress`, the Admin's own account, an already erased
 * user (409 `ALREADY_ERASED`, nothing is redone), and the last active Admin.
 */
export async function completeDeletionRequest(
  auth: AuthContext,
  requestId: string,
  outcome: string,
  options: EraseOptions = {},
): Promise<ErasureResult> {
  const request = (await db('data_subject_requests')
    .where({ id: requestId })
    .first('id', 'user_id', 'request_type', 'status')) as
    | { id: string; user_id: string; request_type: string; status: string }
    | undefined;
  if (!request) throw notFound('Data request not found.', { code: 'REQUEST_NOT_FOUND' });
  const userId = request.user_id;
  if (userId === auth.user.id) {
    throw forbidden('You cannot action a request for your own account.', { code: 'CANNOT_ACTION_OWN_REQUEST' });
  }
  if (request.request_type !== 'deletion') {
    throw conflict('Only a deletion request erases an account.', { code: 'NOT_A_DELETION_REQUEST' });
  }
  if (request.status !== 'in_progress') {
    throw conflict(`This request is ${request.status}; it must be in progress.`, { code: 'INVALID_STATE' });
  }
  const profile = (await db('profiles').where({ user_id: userId }).first('erased_at')) as
    | { erased_at: Date | null }
    | undefined;
  if (!profile) throw notFound('User not found.', { code: 'USER_NOT_FOUND' });
  if (profile.erased_at) throw conflict('This account has already been erased.', { code: 'ALREADY_ERASED' });
  if ((await otherActiveAdmins(db, userId)) === 0) throw lastAdmin();

  const send: EmailSender = options.sender ?? senderOverride ?? ((message) => sendEmail(message));
  const completionEmail = await sendCompletionEmail(requestId, userId, send);

  const result = await withTx(async (trx) => {
    const closed = await trx('data_subject_requests')
      .where({ id: requestId, status: 'in_progress', request_type: 'deletion' })
      .update({ status: 'completed', completed_at: trx.fn.now(), outcome, handled_by: auth.user.id })
      .returning('id');
    if (closed.length === 0) throw conflict('This request is no longer in progress.', { code: 'INVALID_STATE' });

    const maintained = (await trx('building_maintainers').where({ user_id: userId }).pluck('building_id')) as string[];
    const listed = (await trx('buildings').where({ lister_id: userId }).pluck('id')) as string[];
    const buildings = await lockBuildings(trx, [...new Set([...maintained, ...listed])]);

    const locked = (await trx('profiles').where({ user_id: userId }).forUpdate().first('erased_at')) as
      | { erased_at: Date | null }
      | undefined;
    if (!locked) throw notFound('User not found.', { code: 'USER_NOT_FOUND' });
    if (locked.erased_at) throw conflict('This account has already been erased.', { code: 'ALREADY_ERASED' });
    if (Number.isFinite(await otherActiveAdmins(trx, userId))) {
      // Two Admins erasing each other at once must not both pass the check below.
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', ['admin-set']);
      if ((await otherActiveAdmins(trx, userId)) === 0) throw lastAdmin();
    }

    // Step 5 first: T8 blocks clearing the phone of a published building's contact.
    const summary: ErasureResult['buildings'] = { withdrawn: [], contactReassigned: [] };
    const maintainedSet = new Set(maintained);
    const soleMaintained: string[] = [];
    for (const b of buildings) {
      if (!maintainedSet.has(b.id)) continue; // listed only: just the landlord name below
      const others = await activeMaintainers(trx, b.id, userId);
      if (others.length === 0) soleMaintained.push(b.id);
      if (b.status === 'withdrawn') continue;

      const publishedLike =
        b.status === 'published' || (b.status === 'suspended' && b.status_before_suspension === 'published');
      let withdraw = others.length === 0; // Draft and Pending too (assumption: nobody is left to finish them)
      if (!withdraw && publishedLike && b.contact_user_id === userId) {
        const replacement = others.find((m) => m.phone);
        if (replacement) {
          await trx('buildings').where({ id: b.id }).update({ contact_user_id: replacement.user_id });
          await writeAudit(trx, {
            actorUserId: auth.user.id,
            actorType: 'staff',
            action: 'building.contact.set',
            objectType: 'building',
            objectId: b.id,
            buildingId: b.id,
            changes: { before: { contactUserId: userId }, after: { contactUserId: replacement.user_id }, cause: 'account_erased' },
          });
          summary.contactReassigned.push({ id: b.id, name: b.name, newContactUserId: replacement.user_id });
        } else {
          withdraw = true; // co-maintained, but nobody else can be the contact
        }
      }
      if (withdraw) {
        await trx('buildings').where({ id: b.id }).update({ status: 'withdrawn', ...CLEARED_SUSPENSION });
        await writeAudit(trx, {
          actorUserId: auth.user.id,
          actorType: 'staff',
          action: 'building.withdraw',
          objectType: 'building',
          objectId: b.id,
          buildingId: b.id,
          changes: { from: b.status, to: 'withdrawn', cause: 'account_erased' },
        });
        summary.withdrawn.push({ id: b.id, name: b.name, from: b.status });
      }
    }

    // ck_buildings_management needs a name or a landlord account, so never NULL.
    // shortcut: replaces the free-text landlord name wherever the user listed the building or was
    // its only maintainer, even if that text named a third party; refine if that ever happens.
    const listedIds = listed.filter((id) => !soleMaintained.includes(id));
    const nameScope = [...new Set([...soleMaintained, ...listedIds])];
    if (nameScope.length > 0) {
      await trx('buildings')
        .whereIn('id', nameScope)
        .where('management_type', 'landlord')
        .where((q) => q.whereNull('landlord_user_id').orWhere('landlord_user_id', userId))
        .update({ landlord_name: ERASED_NAME, version: trx.raw('version + 1') });
    }

    const realAddress = (await trx('auth_users').where({ id: userId }).first('email')) as { email: string };
    await trx('profiles')
      .where({ user_id: userId })
      .update({ display_name: ERASED_NAME, phone: null, photo_file_id: null, erased_at: trx.fn.now() });
    await trx('auth_users')
      .where({ id: userId })
      .update({ email: erasedEmail(userId), name: ERASED_NAME, image: null, email_verified: false });

    // Bumps token_version and drops every session (reuse of the TX-09 helper), then the rest of the credentials.
    await revokeAllUserTokens(userId, 'account_erased', trx);
    await trx('auth_refresh_tokens').where({ user_id: userId }).del();
    await trx('auth_sessions').where({ user_id: userId }).del();
    await trx('auth_accounts').where({ user_id: userId }).del();
    // Better Auth keys these by e-mail (e-mail verification) or by user id in `value` (password reset).
    await trx('auth_verifications').where((q) => q.where('value', userId).orWhere('identifier', realAddress.email)).del();

    await trx('contact_events').where({ user_id: userId }).update({ user_id: null });
    await trx('notification_deliveries')
      .whereIn('notification_id', trx('notifications').where({ user_id: userId }).select('id'))
      .whereNotNull('last_error')
      .update({ last_error: null });

    // Requests: free-text notes go, rows stay; any other open request of this user is closed.
    await trx('data_subject_requests').where({ user_id: userId }).update({ note: null });
    await trx('data_subject_requests')
      .where({ user_id: userId })
      .whereIn('status', ['open', 'in_progress'])
      .update({
        status: 'rejected',
        completed_at: trx.fn.now(),
        outcome: 'Closed because the account was erased.',
        handled_by: auth.user.id,
      });

    // Files: names are blanked for all uploads; the objects of evidence, the profile photo and other
    // unattached uploads are queued for the purge job (it destroys them, then sets `purged_at`).
    // Public catalogue photos stay: they belong to the building.
    await trx('files').where({ uploaded_by: userId }).update({ original_name: '' });
    const queued = await trx('files as f')
      .where('f.uploaded_by', userId)
      .whereNull('f.purged_at')
      .whereNull('f.purge_requested_at')
      .where((q) =>
        q
          .where('f.visibility', 'restricted')
          .orWhere((p) =>
            p
              .whereRaw('NOT EXISTS (SELECT 1 FROM photos x WHERE x.file_id = f.id)')
              .whereRaw('NOT EXISTS (SELECT 1 FROM ad_campaigns x WHERE x.image_file_id = f.id)'),
          ),
      )
      .update({ purge_requested_at: trx.fn.now() });

    await writeAudit(trx, {
      actorUserId: auth.user.id,
      actorType: 'staff',
      action: 'user.erase',
      objectType: 'user',
      objectId: userId,
      changes: {
        requestId,
        completionEmail,
        buildingsWithdrawn: summary.withdrawn.length,
        contactsReassigned: summary.contactReassigned.length,
        filesQueuedForPurge: queued,
      },
    });
    await writeAudit(trx, {
      actorUserId: auth.user.id,
      actorType: 'staff',
      action: 'data_request.complete',
      objectType: 'data_subject_request',
      objectId: requestId,
      changes: { type: 'deletion', userId },
    });
    // No notification row: the requester is about to have no address, and was e-mailed in step 2.
    return { buildings: summary, filesQueuedForPurge: queued };
  });

  return { requestId, userId, completionEmail, ...result };
}
