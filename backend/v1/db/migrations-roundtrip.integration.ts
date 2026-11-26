import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import knex, { type Knex } from 'knex';
import { Client } from 'pg';
import knexConfig from '../../knexfile.js';

// Proves every migration's `down` works: migrate all the way up, all the way down, up again, and
// compare the schema. It creates and drops ITS OWN database (`khunt_roundtrip_<timestamp>`) on the same
// server as the runner's throwaway database; it never touches the database in DB_NAME, so it cannot hurt
// dev data. NEVER point `migrate.rollback({}, true)` at a shared database: it reverts every batch.

const base = knexConfig.connection as { host?: string; port?: number; user?: string; password?: string };
const roundtripDb = `khunt_roundtrip_${Date.now()}`;
const admin = () => new Client({ ...base, database: 'postgres' });

let k: Knex;

beforeAll(async () => {
  const client = admin();
  await client.connect();
  await client.query(`CREATE DATABASE "${roundtripDb}"`);
  await client.end();
  k = knex({ ...knexConfig, connection: { ...base, database: roundtripDb }, pool: { min: 0, max: 2 } });
});

afterAll(async () => {
  await k.destroy();
  const client = admin();
  await client.connect();
  await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [roundtripDb]);
  await client.query(`DROP DATABASE IF EXISTS "${roundtripDb}"`);
  await client.end();
});

/** Everything the migrations create in `public`, as sorted comparable strings. */
async function fingerprint(): Promise<Record<string, string[]>> {
  const list = async (sql: string) => ((await k.raw(sql)).rows as Array<{ v: string }>).map((r) => r.v).sort();
  return {
    columns: await list(`SELECT table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '') AS v
                           FROM information_schema.columns WHERE table_schema = 'public' AND table_name NOT LIKE 'knex_migrations%'`),
    indexes: await list(`SELECT indexdef AS v FROM pg_indexes WHERE schemaname = 'public' AND tablename NOT LIKE 'knex_migrations%'`),
    constraints: await list(`SELECT conrelid::regclass::text || '.' || conname || ' ' || pg_get_constraintdef(oid) AS v
                               FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conrelid::regclass::text NOT LIKE 'knex_migrations%'`),
    triggers: await list(`SELECT c.relname || '.' || t.tgname || ' ' || t.tgenabled AS v
                            FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace`),
    functions: await list(`SELECT proname || '(' || pg_get_function_identity_arguments(oid) || ')' AS v FROM pg_proc WHERE pronamespace = 'public'::regnamespace`),
    views: await list(`SELECT viewname AS v FROM pg_views WHERE schemaname = 'public'`),
  };
}

describe('migrations: every down works', () => {
  it('goes up, all the way down to an empty schema, and up again to the identical schema', async () => {
    await k.migrate.latest();
    const [, applied] = await k.migrate.list();
    expect(applied).toEqual([]); // nothing pending
    const first = await fingerprint();
    expect(first.columns?.length).toBeGreaterThan(100);
    expect(first.triggers?.length).toBeGreaterThan(10);

    await k.migrate.rollback({}, true);
    const leftovers = await k.raw(
      `SELECT table_name AS v FROM information_schema.tables WHERE table_schema = 'public' AND table_name NOT LIKE 'knex_migrations%'`,
    );
    expect(leftovers.rows).toEqual([]);
    const empty = await fingerprint();
    expect(empty).toEqual({ columns: [], indexes: [], constraints: [], triggers: [], functions: [], views: [] });

    await k.migrate.latest();
    expect(await fingerprint()).toEqual(first);
  }, 120_000);
});
