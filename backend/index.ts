import 'dotenv/config';
import { createShutdown, DEFAULT_SHUTDOWN_TIMEOUT_MS } from './shutdown.js';
import { validateEnv } from './v1/lib/validate-env.js';

// Before anything else loads: v1/lib/auth.ts opens a database pool and throws on a missing secret
// when it is imported, so the app modules are imported only once the environment checks out.
try {
  validateEnv();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const { createApp } = await import('./app.js');
const { closeDb } = await import('./v1/db/knex.js');
const { closeAuthPool } = await import('./v1/lib/auth.js');

const app = createApp();

const port = Number(process.env.PORT) || 3000;
const server = app.listen(port, () => {
  console.log(`App live on port ${port}`);
});

const shutdown = createShutdown({
  server,
  closers: [closeDb, closeAuthPool],
  timeoutMs: Number(process.env.SHUTDOWN_TIMEOUT_MS) || DEFAULT_SHUTDOWN_TIMEOUT_MS,
});
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
