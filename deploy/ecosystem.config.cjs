// PM2 process file for the khunt API.
//   pm2 start deploy/ecosystem.config.cjs --env staging      (or --env production)
//   pm2 reload khunt-api        then   pm2 save
//
// Secrets are NOT here: the app reads backend/.env (dotenv) from its working directory. Only NODE_ENV
// is set below, because dotenv never overrides a variable that is already set.
//
// ONE instance in FORK mode, on purpose:
//  * Some state lives in the process: the commute cache and the daily Google Maps call counter
//    (modules/commute), the N-11 day flag and the rate limiter. With several instances every one keeps
//    its own copy, so the Maps budget and the rate limits become "limit x instances".
//  * Every instance holds two connection pools: Knex (max 10) and Better Auth's own pool (max 10).
//    Connections used = (10 + 10) x instances, and it must stay below PostgreSQL `max_connections`
//    (default 100) with room for migrations, the cron jobs and monitoring (design section 10.3).
//  * `pm2 reload` in fork mode is a stop-then-start, not a zero-downtime swap (that needs cluster
//    mode, which Bun does not support under PM2). The graceful shutdown in index.ts lets in-flight
//    requests finish first, so a reload drops no accepted request, but new connections are refused
//    for the second or two it takes to boot.
// Raise `instances` only after reading the "Per-process state" section of backend/README.md.

const path = require('node:path');

const logDir = process.env.KHUNT_LOG_DIR || path.join(__dirname, '..', 'logs');

module.exports = {
  apps: [
    {
      name: 'khunt-api',
      cwd: path.join(__dirname, '..', 'backend'),
      script: 'index.ts',
      interpreter: 'bun', // must be on the PATH of the user that runs PM2
      exec_mode: 'fork',
      instances: 1,

      autorestart: true,
      max_memory_restart: '512M', // restart (gracefully, via SIGTERM) if the process grows past this
      min_uptime: '10s', // a start that dies sooner than this counts as a crash...
      max_restarts: 10, // ...and after this many in a row PM2 stops and shows "errored"
      exp_backoff_restart_delay: 200,

      // PM2 sends SIGTERM, waits kill_timeout, then SIGKILL. Keep it above SHUTDOWN_TIMEOUT_MS (default 10 s).
      kill_timeout: 15000,

      time: true, // prefix every log line with a timestamp
      merge_logs: true,
      out_file: path.join(logDir, 'khunt-api.out.log'),
      error_file: path.join(logDir, 'khunt-api.err.log'),
      // Rotate with `pm2 install pm2-logrotate`; PM2 does not rotate by itself.

      env: { NODE_ENV: 'production' },
      env_staging: { NODE_ENV: 'staging' },
      env_production: { NODE_ENV: 'production' },
    },
  ],
};
