import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

// Design 10.2: "no deletion of catalogue rows (BR-021) ... the data-access layer exposes no delete for
// catalogue tables, and a test asserts it." This scans the application source for every Knex delete
// (`.del()` / `.delete()` after `trx('table')`), `DELETE FROM` and TRUNCATE, and fails on anything
// that is not named in ALLOWED below. A new delete therefore needs a deliberate, reviewed line here.

/** Tables that are never deleted from application code. Their history must survive (design 12.1). */
export const PROTECTED_TABLES = [
  'buildings', 'space_types', 'photos', 'availability_events', 'audit_log', 'consent_records',
  'enquiries', 'enquiry_messages', 'viewing_requests', 'reports',
  'verification_cases', 'verification_evidence',
] as const;

/** The legitimate deletes: [file relative to backend/, table, why]. */
const ALLOWED: Array<[string, string, string]> = [
  ['v1/lib/tokens.ts', 'auth_sessions', 'logout, logout-all and refresh-token reuse revoke Better Auth sessions'],
  ['v1/modules/data-requests/erasure.ts', 'auth_refresh_tokens', 'erasure removes the credentials (design 10.6)'],
  ['v1/modules/data-requests/erasure.ts', 'auth_sessions', 'erasure removes the credentials (design 10.6)'],
  ['v1/modules/data-requests/erasure.ts', 'auth_accounts', 'erasure removes the credentials (design 10.6)'],
  ['v1/modules/data-requests/erasure.ts', 'auth_verifications', 'erasure removes pending reset tokens'],
  ['v1/modules/data-requests/purge-expired-auth.ts', 'auth_refresh_tokens', 'nightly expired-credential cleanup (design 10.7)'],
  ['v1/modules/data-requests/purge-expired-auth.ts', 'auth_sessions', 'nightly expired-credential cleanup'],
  ['v1/modules/data-requests/purge-expired-auth.ts', 'auth_verifications', 'nightly expired-credential cleanup'],
  ['v1/modules/files/purge.ts', 'files', 'orphan file rows are removed once Cloudinary has dropped the asset'],
  ['v1/modules/buildings/service.ts', 'building_maintainers', 'a maintainer is unassigned (a junction row, not catalogue history)'],
  ['v1/modules/user-admin/service.ts', 'user_roles', 'Admin removes a role from a user (junction row, audited)'],
  ['v1/modules/reference/service.ts', 'settings', 'Admin removes a setting row (reference data, audited)'],
];

export interface DeleteSite {
  table: string;
  kind: 'knex' | 'raw' | 'dynamic';
}

/** Every delete or truncate in `source`. `dynamic` means a delete whose table could not be read. */
export function findDeleteSites(source: string): DeleteSite[] {
  const sites: DeleteSite[] = [];
  // trx('table') ... .del() / .delete()   (empty parentheses: Map#delete always has an argument)
  const knexChain = /\b\w+\(\s*(['"`])(\w+)\1\s*\)[^;]{0,600}?\.(?:del|delete)\(\s*\)/g;
  for (const m of source.matchAll(knexChain)) sites.push({ table: m[2] as string, kind: 'knex' });
  for (const m of source.matchAll(/\bDELETE\s+FROM\s+(?:ONLY\s+)?"?(\w+)"?/gi)) sites.push({ table: m[1] as string, kind: 'raw' });
  for (const m of source.matchAll(/\bTRUNCATE\s+(?!ON\b)(?:TABLE\s+)?(?:ONLY\s+)?"?(\w+)"?/g)) sites.push({ table: m[1] as string, kind: 'raw' });
  for (const m of source.matchAll(/\.truncate\(\s*(['"`])(\w+)\1/g)) sites.push({ table: m[2] as string, kind: 'knex' });

  // A `.del()` / `.delete()` the chain pattern did not account for: the table is not a plain literal.
  const emptyDeletes = [...source.matchAll(/\.(?:del|delete)\(\s*\)/g)].length;
  const accounted = [...source.matchAll(knexChain)].length;
  for (let i = accounted; i < emptyDeletes; i++) sites.push({ table: '?', kind: 'dynamic' });
  return sites;
}

const backendDir = resolve(import.meta.dir, '../..');

function applicationSources(): string[] {
  const glob = new Bun.Glob('**/*.ts');
  const files: string[] = [];
  for (const file of glob.scanSync({ cwd: backendDir })) {
    if (/(^|\/)node_modules\//.test(file)) continue;
    if (/\.(test|integration)\.ts$/.test(file)) continue;
    if (file.startsWith('v1/migrations/')) continue; // schema code, run by the CLI only
    files.push(file);
  }
  return files.sort();
}

describe('delete policy (design 10.2, BR-021)', () => {
  it('no allow-list entry may name a protected table', () => {
    for (const [file, table] of ALLOWED) expect(PROTECTED_TABLES as readonly string[], `${file} ${table}`).not.toContain(table);
  });

  it('application code deletes only from the tables named in the allow-list', () => {
    const allowed = new Set(ALLOWED.map(([file, table]) => `${file}|${table}`));
    const violations: string[] = [];
    const seen = new Set<string>();
    for (const file of applicationSources()) {
      for (const site of findDeleteSites(readFileSync(resolve(backendDir, file), 'utf8'))) {
        const key = `${file}|${site.table}`;
        seen.add(key);
        if (!allowed.has(key)) {
          violations.push(`${relative(backendDir, resolve(backendDir, file))}: ${site.kind} delete of "${site.table}"${(PROTECTED_TABLES as readonly string[]).includes(site.table) ? ' (PROTECTED, never allowed)' : ''}`);
        }
      }
    }
    expect(violations).toEqual([]);
    // A stale allow-list entry hides a future violation: every entry must still match real code.
    expect([...allowed].filter((key) => !seen.has(key))).toEqual([]);
  });

  describe('the scanner itself', () => {
    it('catches Knex chains, raw SQL, truncate and unreadable tables', () => {
      expect(findDeleteSites(`await trx('buildings').where({ id }).del();`)).toEqual([{ table: 'buildings', kind: 'knex' }]);
      expect(findDeleteSites(`await db("photos")\n  .where('id', id)\n  .delete();`)).toEqual([{ table: 'photos', kind: 'knex' }]);
      expect(findDeleteSites('await trx.raw(`DELETE FROM audit_log WHERE true`)')).toEqual([{ table: 'audit_log', kind: 'raw' }]);
      expect(findDeleteSites(`await trx.raw('TRUNCATE availability_events')`)).toEqual([{ table: 'availability_events', kind: 'raw' }]);
      expect(findDeleteSites(`await trx(tableName).where({ id }).del();`)).toEqual([{ table: '?', kind: 'dynamic' }]);
    });

    it('ignores Map deletes, HTTP delete routes and ordinary text', () => {
      expect(findDeleteSites(`cache.delete(key); router.delete('/areas/:id', handler); // soft delete`)).toEqual([]);
    });
  });
});
