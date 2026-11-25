import knex, { type Knex } from 'knex';
import config from '../../knexfile.js';

const STATEMENT_TIMEOUT_MS = 30_000;
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 30_000;

interface PgPoolConnection {
  query(sql: string, cb: (err?: Error | null) => void): void;
}

const existingAfterCreate = config.pool?.afterCreate;

// Statement and idle-in-transaction timeouts belong on the app pool rather than knexfile.ts
// so long-running migrations via the CLI are not cut short (DATABASE_DESIGN.md §7.4, §10.3).
const poolConfig: Knex.PoolConfig = {
  ...config.pool,
  afterCreate(
    conn: PgPoolConnection,
    done: (err: Error | null | undefined, conn: PgPoolConnection) => void,
  ) {
    conn.query(
      `SET statement_timeout = ${STATEMENT_TIMEOUT_MS}; SET idle_in_transaction_session_timeout = ${IDLE_IN_TRANSACTION_TIMEOUT_MS};`,
      (err) => {
        if (err) {
          done(err, conn);
          return;
        }
        if (existingAfterCreate) {
          existingAfterCreate(conn, done);
          return;
        }
        done(null, conn);
      },
    );
  },
};

const db = knex({
  ...config,
  pool: poolConfig,
});

export async function closeDb(): Promise<void> {
  await db.destroy();
}

export default db;
