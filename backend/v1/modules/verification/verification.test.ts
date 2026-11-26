import { afterEach, describe, expect, it } from 'bun:test';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import type { Server } from 'node:http';
import { forbidden, HttpError } from '../../lib/http-error.js';
import { encodeCursor } from '../../lib/keyset.js';
import type { AuthContext } from '../../middlewares/auth.js';
import { createVerificationRouter, type VerificationRouterDeps } from './routes.js';
import {
  parseAddEvidenceBody,
  parseDecisionBody,
  parseQueueQuery,
  parseRevokeBody,
  parseSubmitBody,
} from './schemas.js';
import {
  assertEvidenceTypes,
  EVIDENCE_RULES,
  mapCaseViolation,
  separationConflict,
  type SeparationFacts,
} from './service.js';

const FILE = '019363c8-1234-7000-8000-0000000000f1';
const FILE_2 = '019363c8-1234-7000-8000-0000000000f2';
const ID = '019363c8-1234-7000-8000-000000000001';
const ADMIN = '019363c8-1234-7000-8000-0000000000aa';

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return (err as HttpError).code ?? 'NO_CODE';
  }
  return undefined;
};

describe('parseSubmitBody', () => {
  it('accepts a list of {evidenceType, fileId}', () => {
    expect(parseSubmitBody({ evidence: [{ evidenceType: ' national_id ', fileId: FILE }] })).toEqual({
      evidence: [{ evidenceType: 'national_id', fileId: FILE }],
    });
  });

  it('leaves an absent or empty list for the service to refuse by naming the missing item', () => {
    expect(parseSubmitBody(undefined)).toEqual({ evidence: [] });
    expect(parseSubmitBody({})).toEqual({ evidence: [] });
    expect(parseSubmitBody({ evidence: [] })).toEqual({ evidence: [] });
  });

  it('rejects bad shapes', () => {
    expect(() => parseSubmitBody({ evidence: 'x' })).toThrow(HttpError);
    expect(() => parseSubmitBody({ evidence: [{ evidenceType: 'national_id', fileId: 'nope' }] })).toThrow(HttpError);
    expect(() => parseSubmitBody({ evidence: [{ evidenceType: '', fileId: FILE }] })).toThrow(HttpError);
    expect(() => parseSubmitBody({ evidence: [{ evidenceType: 'a', fileId: FILE, extra: 1 }] })).toThrow(HttpError);
    expect(() => parseSubmitBody({ status: 'approved' })).toThrow(HttpError);
    expect(() => parseSubmitBody({ evidence: Array(6).fill({ evidenceType: 'a', fileId: FILE }) })).toThrow(HttpError);
  });
});

describe('parseDecisionBody', () => {
  it('requires a reason to reject (FR-VER-002) and treats it as optional to approve', () => {
    expect(parseDecisionBody({ decision: 'reject', reason: ' blurry scan ' })).toEqual({
      decision: 'reject',
      reason: 'blurry scan',
    });
    expect(parseDecisionBody({ decision: 'approve' })).toEqual({ decision: 'approve', reason: null });
    expect(parseDecisionBody({ decision: 'approve', reason: 'ok' }).reason).toBe('ok');
    expect(() => parseDecisionBody({ decision: 'reject' })).toThrow(HttpError);
    expect(() => parseDecisionBody({ decision: 'reject', reason: '   ' })).toThrow(HttpError);
    expect(() => parseDecisionBody({ decision: 'maybe', reason: 'x' })).toThrow(HttpError);
    expect(() => parseDecisionBody({ decision: 'approve', status: 'approved' })).toThrow(HttpError);
  });
});

describe('parseRevokeBody', () => {
  it('requires subject, id and a reason (FR-VER-006)', () => {
    expect(parseRevokeBody({ subject: 'building', id: ID, reason: 'fraud' })).toEqual({
      subject: 'building',
      id: ID,
      reason: 'fraud',
    });
    expect(() => parseRevokeBody({ subject: 'building', id: ID })).toThrow(HttpError);
    expect(() => parseRevokeBody({ subject: 'unit', id: ID, reason: 'x' })).toThrow(HttpError);
    expect(() => parseRevokeBody({ subject: 'account', id: 'x', reason: 'x' })).toThrow(HttpError);
  });
});

describe('parseAddEvidenceBody', () => {
  it('needs the evidence type and nothing else', () => {
    expect(parseAddEvidenceBody({ evidenceType: 'phone_confirmation' })).toEqual({ evidenceType: 'phone_confirmation' });
    expect(() => parseAddEvidenceBody({})).toThrow(HttpError);
    expect(() => parseAddEvidenceBody({ evidenceType: 'phone_confirmation', fileId: FILE })).toThrow(HttpError);
  });
});

describe('parseQueueQuery', () => {
  it('defaults to the pending queue of both kinds', () => {
    expect(parseQueueQuery({})).toMatchObject({ subject: null, status: 'pending', limit: 25, cursor: null });
  });

  it('accepts filters and a cursor, and refuses unknown values', () => {
    const cursor = encodeCursor({ t: '2026-11-26 08:00:00.123456+00', id: ID });
    expect(parseQueueQuery({ subject: 'account', status: 'rejected', limit: '5', cursor })).toMatchObject({
      subject: 'account',
      status: 'rejected',
      limit: 5,
      cursor: { id: ID },
    });
    expect(() => parseQueueQuery({ subject: 'unit' })).toThrow(HttpError);
    expect(() => parseQueueQuery({ status: 'all' })).toThrow(HttpError);
    expect(() => parseQueueQuery({ limit: '0' })).toThrow(HttpError);
    expect(() => parseQueueQuery({ cursor: 'garbage' })).toThrow(HttpError);
  });
});

describe('evidence rules (OQ-02, one constant)', () => {
  it('an account needs a national ID; the Admin adds phone confirmation', () => {
    expect(EVIDENCE_RULES.account).toEqual({
      applicant: ['national_id'],
      required: ['national_id'],
      admin: ['phone_confirmation'],
    });
    expect(EVIDENCE_RULES.building.required).toEqual(['proof_of_authority']);
  });

  it('accepts the required item', () => {
    expect(() => assertEvidenceTypes('account', [{ evidenceType: 'national_id', fileId: FILE }])).not.toThrow();
    expect(() => assertEvidenceTypes('building', [{ evidenceType: 'proof_of_authority', fileId: FILE }])).not.toThrow();
  });

  it('names the missing item', () => {
    let message = '';
    try {
      assertEvidenceTypes('account', []);
    } catch (err) {
      message = (err as HttpError).message;
      expect((err as HttpError).status).toBe(400);
      expect((err as HttpError).code).toBe('EVIDENCE_MISSING');
    }
    expect(message).toContain('national_id');
    expect(() => assertEvidenceTypes('building', [])).toThrow(/proof_of_authority/);
  });

  it('refuses a type that does not belong to the kind of case, including an applicant-supplied phone confirmation', () => {
    expect(code(() => assertEvidenceTypes('account', [{ evidenceType: 'proof_of_authority', fileId: FILE }]))).toBe(
      'EVIDENCE_TYPE_NOT_ALLOWED',
    );
    expect(code(() => assertEvidenceTypes('account', [{ evidenceType: 'phone_confirmation', fileId: FILE }]))).toBe(
      'EVIDENCE_TYPE_NOT_ALLOWED',
    );
  });

  it('refuses the same file twice', () => {
    expect(
      code(() =>
        assertEvidenceTypes('account', [
          { evidenceType: 'national_id', fileId: FILE },
          { evidenceType: 'national_id', fileId: FILE },
        ]),
      ),
    ).toBe('EVIDENCE_DUPLICATE_FILE');
    expect(
      code(() =>
        assertEvidenceTypes('account', [
          { evidenceType: 'national_id', fileId: FILE },
          { evidenceType: 'national_id', fileId: FILE_2 },
        ]),
      ),
    ).toBeUndefined();
  });
});

describe('separationConflict (BR-014)', () => {
  const base: SeparationFacts = {
    adminId: ADMIN,
    submittedBy: ID,
    subjectUserId: ID,
    building: null,
    editedBuilding: false,
  };
  const building = (over: Partial<NonNullable<SeparationFacts['building']>> = {}) => ({
    listerId: ID,
    createdBy: ID,
    maintainerIds: [ID],
    ...over,
  });

  it('lets an uninvolved Admin decide', () => {
    expect(separationConflict(base)).toBeNull();
    expect(separationConflict({ ...base, subjectUserId: null, building: building() })).toBeNull();
  });

  it('refuses the submitter and the account holder', () => {
    expect(separationConflict({ ...base, submittedBy: ADMIN })).toMatch(/submitted/);
    expect(separationConflict({ ...base, submittedBy: null, subjectUserId: ADMIN })).toMatch(/own account/);
  });

  it('refuses an Admin who created, lists or maintains the building', () => {
    const facts = { ...base, subjectUserId: null, submittedBy: null };
    expect(separationConflict({ ...facts, building: building({ createdBy: ADMIN }) })).toMatch(/create/);
    expect(separationConflict({ ...facts, building: building({ listerId: ADMIN }) })).toMatch(/create/);
    expect(separationConflict({ ...facts, building: building({ maintainerIds: [ID, ADMIN] }) })).toMatch(/maintain/);
  });

  it('refuses an Admin who edited the building', () => {
    expect(
      separationConflict({ ...base, subjectUserId: null, submittedBy: null, building: building(), editedBuilding: true }),
    ).toMatch(/edited/);
  });
});

describe('mapCaseViolation', () => {
  it('maps the separation CHECK to a 403', () => {
    const mapped = mapCaseViolation({ code: '23514', constraint: 'ck_vc_separation' }) as HttpError;
    expect(mapped.status).toBe(403);
    expect(mapped.code).toBe('SEPARATION_OF_DUTIES');
  });

  it('maps the one-pending index to a 409', () => {
    const mapped = mapCaseViolation({ code: '23505', constraint: 'ux_vc_one_pending_account' }) as HttpError;
    expect(mapped.status).toBe(409);
    expect(mapped.code).toBe('VERIFICATION_PENDING');
  });

  it('maps a T3 transition refusal to a 409 and leaves other errors alone', () => {
    const t3 = mapCaseViolation({ code: '23514', message: 'verification case cannot move from rejected to approved' }) as HttpError;
    expect(t3.status).toBe(409);
    const other = new Error('boom');
    expect(mapCaseViolation(other)).toBe(other);
  });
});

// ---- router wiring with fake services ---------------------------------------------------------

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const status = typeof err?.status === 'number' ? err.status : 500;
  res.status(status).json({ status: 'fail', data: null, message: err.expose ? err.message : 'Internal server error', code: err.code });
};

const asRole = (...roles: string[]): RequestHandler => (req, _res, next) => {
  req.auth = { user: { id: ADMIN }, roles } as unknown as AuthContext;
  next();
};
const adminOnly: RequestHandler = (req, _res, next) =>
  next(req.auth?.roles.includes('admin') ? undefined : forbidden('Insufficient permissions', { code: 'FORBIDDEN_ROLE' }));
const listerOnly: RequestHandler = (req, _res, next) =>
  next(
    req.auth?.roles.some((r) => r === 'landlord' || r === 'agent')
      ? undefined
      : forbidden('Insufficient permissions', { code: 'FORBIDDEN_ROLE' }),
  );

let active: Server | null = null;
afterEach(async () => {
  if (active) await new Promise<void>((resolve) => active!.close(() => resolve()));
  active = null;
});

async function start(role: string, deps: VerificationRouterDeps = {}): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use(createVerificationRouter({ requireAuth: asRole(role), requireAdmin: adminOnly, requireLister: listerOnly, ...deps }));
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    active = app.listen(0, '127.0.0.1', () => resolve());
  });
  return `http://127.0.0.1:${(active!.address() as { port: number }).port}`;
}

const send = (url: string, method: string, body?: unknown) =>
  fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('verification router', () => {
  const adminRoutes: Array<[string, string, unknown?]> = [
    ['GET', `/admin/verification/cases`],
    ['GET', `/admin/verification/cases/${ID}`],
    ['POST', `/admin/verification/cases/${ID}/evidence`, { evidenceType: 'phone_confirmation' }],
    ['POST', `/admin/verification/cases/${ID}/decision`, { decision: 'approve' }],
    ['POST', `/admin/verification/revoke`, { subject: 'account', id: ID, reason: 'x' }],
  ];

  it('keeps every Admin route behind the Admin role (403 for a landlord)', async () => {
    const base = await start('landlord');
    for (const [method, path, body] of adminRoutes) {
      const res = await send(`${base}${path}`, method, body);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it('lets a client read their cases but not submit an account verification', async () => {
    const base = await start('client', {
      listMine: async () => ({ items: [], nextCursor: null }),
    });
    expect((await send(`${base}/verification/mine`, 'GET')).status).toBe(200);
    expect((await send(`${base}/verification/account`, 'POST', { evidence: [] })).status).toBe(403);
  });

  it('wraps results in the {status,data,message} envelope and passes parsed input to the service', async () => {
    let seen: unknown;
    const base = await start('landlord', {
      submitAccount: async (_auth, input) => {
        seen = input;
        return { id: ID } as never;
      },
    });
    const res = await send(`${base}/verification/account`, 'POST', {
      evidence: [{ evidenceType: 'national_id', fileId: FILE }],
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ status: 'success', data: { id: ID } });
    expect(seen).toEqual({ evidence: [{ evidenceType: 'national_id', fileId: FILE }] });
  });

  it('validates input before the service runs (400, service never called)', async () => {
    let called = 0;
    const base = await start('admin', {
      decide: async () => {
        called += 1;
        return {} as never;
      },
    });
    expect((await send(`${base}/admin/verification/cases/${ID}/decision`, 'POST', { decision: 'reject' })).status).toBe(400);
    expect((await send(`${base}/admin/verification/cases/not-a-uuid/decision`, 'POST', { decision: 'approve' })).status).toBe(400);
    expect(called).toBe(0);
    expect((await send(`${base}/admin/verification/cases/${ID}/decision`, 'POST', { decision: 'approve' })).status).toBe(200);
    expect(called).toBe(1);
  });

  it('passes the queue filters through', async () => {
    let seen: unknown;
    const base = await start('admin', {
      listCases: async (query) => {
        seen = query;
        return { items: [], nextCursor: null };
      },
    });
    const res = await send(`${base}/admin/verification/cases?subject=building&status=pending&limit=10`, 'GET');
    expect(res.status).toBe(200);
    expect(seen).toMatchObject({ subject: 'building', status: 'pending', limit: 10 });
    expect((await send(`${base}/admin/verification/cases?subject=nope`, 'GET')).status).toBe(400);
  });
});
