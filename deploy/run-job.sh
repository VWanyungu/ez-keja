#!/usr/bin/env bash
# Run one of the scheduled jobs in backend/jobs/ from cron: `run-job.sh <job-name>`
# (for example `run-job.sh deliver-notifications`).
#
# - flock -n: if the previous run of the SAME job is still going on this host, skip instead of piling
#   up (matters for the every-minute job). The jobs are also safe to overlap in the database; this just
#   saves the work.
# - Output goes to one log file with a timestamp and the exit code. Nothing from the environment is printed.
#
# Environment (all optional): KHUNT_DIR (repo root, default: the parent of this script's folder),
# KHUNT_LOG_DIR (default: $KHUNT_DIR/logs), KHUNT_LOCK_DIR (default: /tmp), NODE_ENV (cron should set it).
set -euo pipefail

job="${1:-}"
if [[ ! "$job" =~ ^[a-z][a-z-]*$ ]]; then
  echo "usage: run-job.sh <job-name>   (a file name in backend/jobs/, without .ts)" >&2
  exit 2
fi

root="${KHUNT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
log_dir="${KHUNT_LOG_DIR:-$root/logs}"
lock_dir="${KHUNT_LOCK_DIR:-/tmp}"
script="$root/backend/jobs/$job.ts"

if [[ ! -f "$script" ]]; then
  echo "no such job: $job" >&2
  exit 2
fi

mkdir -p "$log_dir"
stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

exec 9>"$lock_dir/khunt-job-$job.lock"
if ! flock -n 9; then
  echo "$(stamp) $job skipped: previous run still going" >>"$log_dir/jobs.log"
  exit 0
fi

cd "$root/backend"
set +e
output="$(bun "jobs/$job.ts" 2>&1)"
code=$?
set -e
printf '%s %s exit=%s %s\n' "$(stamp)" "$job" "$code" "$output" >>"$log_dir/jobs.log"
exit "$code"
