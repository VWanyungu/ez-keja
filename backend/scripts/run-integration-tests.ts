import 'dotenv/config';
import { Client } from 'pg';
import knex from 'knex';
import knexConfig from '../knexfile.js';

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
    ];

    for (const file of integrationFiles) {
      const proc = Bun.spawn(['bun', 'test', file], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: 'development',
          DB_NAME: testDbName,
        },
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
