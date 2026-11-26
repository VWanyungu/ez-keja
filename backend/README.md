# khunt backend

Express 5 + TypeScript API on Bun, PostgreSQL through Knex, Better Auth plus first-party access and
refresh tokens. Source of truth for the schema is `Documentation/architecture/DATABASE_DESIGN.md`; the
engineering standards are in `.claude/skills/synergetic-standards/`.

Owner decisions that differ from the standards' defaults (Cloudinary instead of SharePoint, e-mail-only
notifications, ads on hold, ...) are listed in the root `CLAUDE.md`.

## Setup

```bash
cd backend
bun install
cp .envExample .env      # then fill it in; .env is gitignored, never commit it
bun run migrate          # creates the schema (needs a PostgreSQL user that owns the database)
bun run seed             # reference data (and, in development only, a dev Admin)
bun run seed:dev-catalogue  # development only: sample listers, areas and 8 published buildings, photos uploaded to Cloudinary (needs its credentials; every @khunt.local user has the password "password")
bun run dev              # http://localhost:3000, /health answers without the api-v header
```

All API routes except `/health` and Better Auth's `/api/auth/*` need the header `api-v: v1`.

## Configuration

Every variable the code reads is in `.envExample` with a comment (a test fails if one is missing).

- **Development** is permissive: nothing is required except a database.
- **Staging and production** check the environment at boot (`v1/lib/validate-env.ts`, called from
  `index.ts` before anything connects). If something is missing the process exits with one line that
  lists the variable NAMES, never values:

  | | Staging | Production |
  |---|---|---|
  | Database | `STAGING_DB_HOST/PORT/USER/PASSWORD/NAME` | `PROD_DB_HOST/PORT/USER/PASSWORD/NAME` |
  | Auth secret | `BETTER_AUTH_SECRET` (or `AUTH_SECRET`) | same |
  | URLs | `CORS_ORIGIN`, `FRONTEND_URL`, `BETTER_AUTH_URL` | same |
  | Mail | `GMAIL_USER`, `GMAIL_APP_PASSWORD` | `USESENDY_API_KEY`, `MAIL_FROM` |
  | Cloudinary | `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | same |

  `GOOGLE_MAPS_API_KEY` stays optional: without it the commute endpoint answers "unavailable" and the
  rest of the site is unaffected. Get it from Google Cloud (Geocoding API and Directions API enabled,
  billing on, key restricted to the server's IP). `MAPS_DAILY_LIMIT` (default 1000) caps calls per day.
  Cloudinary values come from the Cloudinary console (Dashboard, "API Keys").
- **CORS.** In staging and production `CORS_ORIGIN` must be an explicit comma-separated list with no `*`
  (credentials are on, so a reflected origin would let any site use a user's cookie). The app refuses to
  start otherwise. Development keeps "unset or `*` allows any origin".
- **Behind a reverse proxy.** Behind DirectAdmin/nginx set `TRUST_PROXY=1` (hops to trust) so `req.ip`
  is the client's address and the rate limiter works per client. Leave it unset when the app is reached
  directly: a trusted `X-Forwarded-For` lets any client choose its own IP. `TRUST_PROXY=true` is refused.
  The proxy must set `X-Forwarded-For` and `X-Forwarded-Proto`.
- **Cookies.** The refresh cookie (`khunt_refresh`, httpOnly, `SameSite=Lax`, `Path=/auth`) gets `Secure`
  when `NODE_ENV=production`. Staging over HTTPS therefore sends it without `Secure` (an existing rule,
  tested in `refresh-cookie.test.ts`); change `lib/refresh-cookie.ts` if staging must be strict too.

## Scripts

| Command | What it does |
|---|---|
| `bun run dev` / `start` | API with watch / without |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run test` | Unit tests (`*.test.ts`), mail keys blanked |
| `bun run test:integration [words]` | Integration tests (`*.integration.ts`) on a throwaway database; optional comma-separated filter such as `search,files` |
| `bun run migrate` | `migrate:latest` |
| `bun run migrate:rollback` | **Do not use on a shared database**, see Migrations |
| `bun run migrate:make name` | New migration |
| `bun run seed` | Seed files |

## Tests

- **Unit tests** need no database. **Integration tests** create `khunt_test_<timestamp>` on the server in
  `.env`, migrate and seed it, run the files listed in `scripts/run-integration-tests.ts` against it, and
  drop it. The user therefore needs `CREATEDB`. Only the files in that list run; add new `*.integration.ts`
  files there.
- **The mail keys are blanked.** `bun run test` and `bun run test:integration` start the tests with
  `GMAIL_USER`, `GMAIL_APP_PASSWORD` and `USESENDY_API_KEY` set to empty (`scripts/test-env.ts`), because a
  real key in `.env` would otherwise make a test send real e-mail or hang on the network. Do not run a bare
  `bun test` when `.env` holds real keys: `scripts/test-env.test.ts` fails on purpose if it sees them.
  The rate limiter is off in tests too (`RATE_LIMIT_ENABLED=0`).
- **Testing real mail on purpose.** Set `INTEGRATION_SEND_MAIL=1` and send only to a valid, deliverable
  address from `v1/lib/mail-test-address.ts` (`MAIL_TEST_ADDRESS` or `mailTestAddress('tag')`). A made-up
  address bounces and gets the sending Gmail account flagged. Cloudinary is never real in tests: the suites
  use `modules/files/fake-cloudinary.ts`.
- **Guards worth knowing.** `v1/db/schema-guards.integration.ts` (append-only and verification triggers are
  enabled, unindexed foreign keys are exactly the nine known partial-index-only ones),
  `v1/db/delete-policy.test.ts` (no new `DELETE`/`.del()` outside an allow-list, never on catalogue tables),
  `v1/db/migrations-roundtrip.integration.ts` (every `down` works, on its own throwaway database),
  `scripts/env-example.test.ts` (`.envExample` is complete).
- **CI** (`.github/workflows/ci.yml`) runs typecheck, unit and integration tests against a Postgres 16
  service container with no mail or Cloudinary secrets, plus commitlint and a branch-name check on pull requests.

## Migrations

- Every migration has a working `down`; the round-trip test proves it.
- **NEVER run `bun run migrate:rollback` against a shared database** (dev, staging, production): it reverts
  a whole batch and once dropped `auth_refresh_tokens`. To undo one migration on a throwaway database:
  `bun run node_modules/knex/bin/cli.js migrate:down --knexfile knexfile.ts`, then `migrate:up` to check.
- Staging and production take `bun run migrate` with `NODE_ENV` set, before the new code starts.

## Jobs and schedule

Jobs are thin runners in `jobs/*.ts`, run by cron (never from request handlers) through `deploy/run-job.sh`.
Schedules are in `deploy/crontab.example` (Africa/Nairobi time). Each is idempotent and safe on two instances.

| Job | When | Safe to repeat because |
|---|---|---|
| `deliver-notifications` | every minute | rows claimed with `SKIP LOCKED` and a lease |
| `send-reminders` | daily 08:00 | unique `reminder_log` key, `SKIP LOCKED`, `ON CONFLICT DO NOTHING` |
| `expire-viewings` | daily 00:30 | one compare-and-swap update |
| `purge-files` | nightly 02:00 | Cloudinary "not found" is success; each step re-checks its row |
| `purge-expired-auth` | nightly 02:30 | deletes only rows already expired |
| `snapshot-metrics` | Monday 03:30 | unique weekly key plus an advisory lock |

`deploy/run-job.sh` adds a per-host `flock` so runs of one job never overlap, and logs one line per run.

## Per-process state and PM2

Some state lives in the API process and is not shared:

- the commute caches and the daily Google Maps call counter with its N-11 threshold flags
  (`modules/commute`; the counter resets at 00:00 UTC),
- the rate limiter's counters (`v1/middlewares/rate-limit.ts`).

Each process also holds two connection pools: Knex (max 10) and Better Auth's own (max 10).

So `deploy/ecosystem.config.cjs` runs **one instance in fork mode**. With N instances the Maps budget and
every rate limit become "limit x N", counters reset on every restart, and the connections used are
`(10 + 10) x N`, which must stay below PostgreSQL `max_connections` (default 100) with room for migrations,
the cron jobs and monitoring (design 10.3). To scale out first move those states to a shared store
(Redis or a Postgres table); the rate limiter is a single middleware, so that is a contained change.
Bun does not run under PM2 cluster mode, so "more instances" means separate processes behind the proxy.

**Reloading.** On SIGTERM/SIGINT `index.ts` stops accepting connections, lets in-flight requests finish
(`SHUTDOWN_TIMEOUT_MS`, default 10 s; PM2 `kill_timeout` is 15 s), closes both pools and exits. In fork mode
`pm2 reload` is a stop then start, so accepted requests complete but new connections are refused for the
second or two the process takes to boot. That is not zero-downtime.

## Rate limiting

In-process fixed window per client IP and route group, answering `429` with `Retry-After` and the usual
envelope. On in staging and production, off elsewhere (`RATE_LIMIT_ENABLED=1|0` overrides). Defaults
(assumptions, tune from real traffic): strict 20 per 15 min (login, register, forgot/reset password, refresh,
admin-invite lookup and accept), moderate 60 per minute (contact events, commute, uploads), generous 300 per
minute (search, public building / space-type / lister pages). Variables: `RATE_LIMIT_<STRICT|MODERATE|GENEROUS>_MAX`
and `_WINDOW_SECONDS`. The route table is `v1/rate-limit-routes.ts`. Better Auth's own `/api/auth/*` routes use
Better Auth's limiter, not this one.

## Backups

`deploy/backup.sh` runs a daily `pg_dump` in custom format, pipes it into `gpg` when `GPG_RECIPIENT` is set
(so no plaintext copy touches the disk), checks the file, and then prunes backups older than
`BACKUP_RETENTION_DAYS` (default 14). Credentials never go on the command line: set `PGHOST`, `PGUSER`,
`PGDATABASE` and `PGPASSFILE` (a `chmod 600` `.pgpass`) in the cron environment or in a file named by
`BACKUP_ENV_FILE`.

**Not done by the script, needs the owner (design 10.3, NFR-BKP-01):**

1. the **off-host copy** (for example `rclone` or `rsync` to storage the VPS cannot also lose), and
2. a **restore test before launch** (below), repeated now and then.

**Restore procedure** (onto a new, empty database; never over a live one):

```bash
gpg --decrypt khunt-20260101T010000Z.dump.gpg > khunt.dump      # skip for an unencrypted dump
createdb khunt_restore
pg_restore --no-owner --dbname khunt_restore khunt.dump
psql -d khunt_restore -c "select count(*) from profiles"          # spot-check real data
```

Then point a copy of the app at `khunt_restore` (or rename databases during a real recovery) and run the
smoke checks. Keep the private key somewhere other than the server that holds the backups.

## Deploying

CI only checks; there is no deploy job yet because the server details are not known. A deploy job needs:

- the SSH host and port, the deploy user, and an SSH private key stored as a GitHub secret,
- the path of the checkout on the server (the repo root that holds `deploy/` and `backend/`),
- the commands to run there: `git pull`, `cd backend && bun install --frozen-lockfile`,
  `NODE_ENV=<env> bun run migrate`, then `pm2 reload khunt-api && pm2 save`,
- a GitHub Environment per target (`staging`, `production`) holding those secrets, with required reviewers
  for production,
- the server-side `backend/.env` (never in CI) and a crontab installed from `deploy/crontab.example`.

First-time server setup: install Bun, PM2 (`pm2 install pm2-logrotate`), PostgreSQL access, copy the repo,
create `.env`, run `pm2 start deploy/ecosystem.config.cjs --env <staging|production>`, `pm2 save`, install the
crontab, and point an Uptime Kuma monitor at `https://<api-host>/health`.

## Monitoring

`GET /health` (no `api-v` header) returns 200 with the database check, or 503; `?check=live` skips the
database. Uptime Kuma watches it; `deploy/pm2-healthcheck.sh` uses the `live` form so a database outage
never restarts the API. There is **no `/metrics` endpoint**: Prometheus would need one exposing request
counts and latencies, the two connection pools' sizes, the rate limiter's rejections and the Maps counter,
in the Prometheus text format, plus a scrape job and Grafana dashboards. Not built.
