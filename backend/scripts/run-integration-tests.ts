import 'dotenv/config';
import { Client } from 'pg';
import knex from 'knex';
import knexConfig from '../knexfile.js';
import { testEnv } from './test-env.js';

const testDbName = `khunt_test_${Date.now()}`;
const baseConn = knexConfig.connection as {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
};

async function main(): Promise<void> {
  const adminClient = new Client({
    host: baseConn.host,
    port: baseConn.port,
    user: baseConn.user,
    password: baseConn.password,
    database: 'postgres',
  });

  await adminClient.connect();
  await adminClient.query(`CREATE DATABASE "${testDbName}"`);
  await adminClient.end();

  let exitCode = 0;

  try {
    const testKnex = knex({
      ...knexConfig,
      connection: {
        ...baseConn,
        database: testDbName,
      },
    });

    try {
      await testKnex.migrate.latest();
      await testKnex.seed.run();
    } finally {
      await testKnex.destroy();
    }

    const integrationFiles = [
      './v1/modules/auth/auth.integration.ts',
      './v1/modules/reference/reference.integration.ts',
      './v1/modules/files/files.integration.ts',
      './v1/modules/buildings/buildings.integration.ts',
      './v1/modules/availability/availability.integration.ts',
      './v1/modules/search/search.integration.ts',
      './v1/modules/public-pages/public-pages.integration.ts',
      './v1/modules/verification/verification.integration.ts',
      './v1/modules/enquiries/engagement.integration.ts',
      './v1/modules/notifications/notifications.integration.ts',
      './v1/modules/moderation/moderation.integration.ts',
      './v1/modules/metrics/metrics.integration.ts',
      './v1/modules/data-requests/data-requests.integration.ts',
      // Phase 12: schema and policy guards (read-only), the rate limiter on the real app, and a
      // migrate-down/up round trip on its own throwaway database.
      './v1/db/schema-guards.integration.ts',
      './v1/middlewares/rate-limit.integration.ts',
      './v1/db/migrations-roundtrip.integration.ts',
      // Inserts 12,000 buildings and removes them again, so it runs last.
      './v1/modules/search/search-performance.integration.ts',
    ];

    // Optional filter while iterating: `bun run test:integration search,files` runs the files whose
    // path contains any of the comma-separated words, in the order above, on one shared database.
    const only = process.argv[2]?.split(',');

    for (const file of integrationFiles.filter((f) => !only || only.some((word) => f.includes(word)))) {
      const proc = Bun.spawn(['bun', 'test', file], {
        cwd: process.cwd(),
        // Mail keys blanked (unless INTEGRATION_SEND_MAIL=1) so a real key in .env cannot send mail.
        env: testEnv(process.env, { DB_NAME: testDbName }),
        stdout: 'inherit',
        stderr: 'inherit',
      });

      exitCode = await proc.exited;
      if (exitCode !== 0) break;
    }
  } finally {
    const cleanupClient = new Client({
      host: baseConn.host,
      port: baseConn.port,
      user: baseConn.user,
      password: baseConn.password,
      database: 'postgres',
    });
    await cleanupClient.connect();
    await cleanupClient.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [testDbName],
    );
    await cleanupClient.query(`DROP DATABASE IF EXISTS "${testDbName}"`);
    await cleanupClient.end();
  }

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

await main();
