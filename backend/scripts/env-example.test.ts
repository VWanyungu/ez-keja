import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Every environment variable the application reads must be documented in .envExample, so a new
// server can be configured from that file alone. Shell scripts under deploy/ document their own
// variables in their headers; this test covers backend/ (everything except tests).

const backendDir = resolve(import.meta.dir, '..');

/** Names read by one source file: process.env.X, a parameter called env (env.X), destructuring, and knexfile's prefixed DB_ names. */
export function envNamesRead(source: string): Set<string> {
  const names = new Set<string>();
  for (const m of source.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)) names.add(m[1] as string);
  for (const m of source.matchAll(/\bconst\s*\{([^}]*)\}\s*=\s*process\.env\b/g)) {
    for (const part of (m[1] as string).split(',')) {
      const name = part.split(':')[0]?.trim();
      if (name) names.add(name);
    }
  }
  // knexfile.ts: process.env[`${prefix}DB_HOST`] with prefix '', 'STAGING_' or 'PROD_'
  for (const m of source.matchAll(/process\.env\[`\$\{prefix\}([A-Z_]+)`\]/g)) {
    for (const prefix of ['', 'STAGING_', 'PROD_']) names.add(`${prefix}${m[1]}`);
  }
  return names;
}

export function documentedNames(envExample: string): Set<string> {
  return new Set([...envExample.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1] as string));
}

function sourceFiles(): string[] {
  const files: string[] = [];
  for (const file of new Bun.Glob('**/*.ts').scanSync({ cwd: backendDir })) {
    if (/(^|\/)node_modules\//.test(file) || /\.(test|integration)\.ts$/.test(file)) continue;
    files.push(file);
  }
  return files.sort();
}

describe('.envExample', () => {
  it('documents every environment variable the backend code reads', () => {
    const documented = documentedNames(readFileSync(resolve(backendDir, '.envExample'), 'utf8'));
    const missing: string[] = [];
    for (const file of sourceFiles()) {
      for (const name of envNamesRead(readFileSync(resolve(backendDir, file), 'utf8'))) {
        if (!documented.has(name)) missing.push(`${name} (read in ${file})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('the scanner reads the four forms of access', () => {
    expect([...envNamesRead('process.env.A_ONE; env.B_TWO; const { C_THREE, D_FOUR: x } = process.env;')].sort()).toEqual(['A_ONE', 'B_TWO', 'C_THREE', 'D_FOUR']);
    expect([...envNamesRead('process.env[`${prefix}DB_HOST`]')].sort()).toEqual(['DB_HOST', 'PROD_DB_HOST', 'STAGING_DB_HOST']);
    expect([...documentedNames('A=\n# B=1\n  C=x\nnot_a_var=\n')].sort()).toEqual(['A', 'B', 'C']);
  });
});
