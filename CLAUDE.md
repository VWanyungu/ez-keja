---
title: "Synergetic Project Instructions"
description: "Entry point for Claude in Synergetic repositories. Points to the synergetic-standards skill, which holds the stack, git workflow and React frontend rules."
---

# CLAUDE.md: Synergetic Project Instructions

This repository follows Synergetic's engineering standards. They live in the **`synergetic-standards`** skill:

```
.claude/skills/synergetic-standards/
├── SKILL.md                     # Start here: which reference to read, and the core rules
└── references/
    ├── tech-stack.md            # Stack selection
    ├── git-workflow.md          # Branches, commits, PRs
    └── react-guidelines.md      # React frontend patterns
```

**Before any code change, branch, commit or dependency addition, read `.claude/skills/synergetic-standards/SKILL.md`** and the reference files it points to.

## Quick reference

- **Frontend:** React + TypeScript + Vite, Tailwind + shadcn/ui, TanStack Query (`useQuery` / `useMutation`), React Router with `ProtectedRoute`, react-hook-form + zod, Sonner, Bun
- **Backend:** Node + Express + TypeScript, Knex migrations
- **Auth:** Better Auth · **Files:** SharePoint · **DB:** PostgreSQL (or MySQL)
- **Hosting:** VPS / DirectAdmin (HostPinnacle), PM2 · **CI/CD:** GitHub Actions
- **Monitoring:** Uptime Kuma, Prometheus, Grafana → Discord / MS Teams · **DNS:** Cloudflare
- **Branches:** `feature/123-short-description` · **Commits:** `feat(scope): description`

## Project-specific notes

khunt is a vacant-space search platform. The backend is in `backend/`; setup, configuration, scripts, jobs,
backups and deployment are in [`backend/README.md`](backend/README.md). The schema's source of truth is
`Documentation/architecture/DATABASE_DESIGN.md`.

**Owner decisions that override the standards' defaults** (do not re-propose the defaults):

- **Files: Cloudinary, not SharePoint.** Uploads go server-side as the raw request body (no multipart): type
  from Content-Type, checked against magic bytes, then a signed request to Cloudinary. Keys are
  `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`. Tests use a fake client, never the real service.
- **Auth: Better Auth is kept, plus first-party access and refresh tokens.** The refresh token is delivered only
  as an httpOnly `khunt_refresh` cookie (`Path=/auth`, `SameSite=Lax`, `Secure` in production), never in a JSON body.
- **Notifications: e-mail only** (Gmail in staging, Usesendy in production), plus the in-app list. No SMS.
- **Advertising is on hold** (Release 2). Write no ad endpoints.
- **Phone numbers are shown to logged-in users only** (BR-009).

**Working notes**

- Never run `migrate:rollback` against a shared database (it reverts a whole batch). The development database is the
  test database; integration tests run on a throwaway `khunt_test_<timestamp>` database created by `scripts/run-integration-tests.ts`.
- Run tests with `bun run test` and `bun run test:integration`, not a bare `bun test`: the scripts blank the mail
  provider keys so no test can send real e-mail. See `backend/README.md`.
- Per-process state (commute cache, Maps counter, rate limiter) and the two connection pools per process are why
  the API runs as one PM2 instance; read "Per-process state and PM2" in `backend/README.md` before changing that.
