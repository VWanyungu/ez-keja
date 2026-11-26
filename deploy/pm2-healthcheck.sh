#!/usr/bin/env bash
# Cron health check for the API (tech-stack: "a cron job runs a shell script that checks whether the
# PM2 process is up and restarts it if not"). Run every few minutes as the user that owns the PM2 daemon.
#
# 1. `pm2 jlist`: is khunt-api known to PM2 and "online"? If not, start or restart it.
# 2. GET /health?check=live (process only, no database): 2xx within a timeout, three tries. If the
#    process is online but not answering, restart it.
#    A database outage does not restart the API: restarting cannot fix it and would only drop requests.
#    The full /health (database included) is for Uptime Kuma to alert on, not for this script.
# 3. At most one restart per RESTART_COOLDOWN_SECONDS, so a crash loop cannot become a restart storm.
#
# Output is one log line per run and never contains environment values.
# Environment (all optional): PM2_APP_NAME (khunt-api), HEALTH_URL (http://127.0.0.1:$PORT/health?check=live),
# PORT (3000), HEALTH_TIMEOUT_SECONDS (5), RESTART_COOLDOWN_SECONDS (300), KHUNT_DIR, KHUNT_STATE_DIR (/tmp).
set -uo pipefail

app="${PM2_APP_NAME:-khunt-api}"
root="${KHUNT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
url="${HEALTH_URL:-http://127.0.0.1:${PORT:-3000}/health?check=live}"
timeout_s="${HEALTH_TIMEOUT_SECONDS:-5}"
cooldown="${RESTART_COOLDOWN_SECONDS:-300}"
state_dir="${KHUNT_STATE_DIR:-/tmp}"
marker="$state_dir/khunt-healthcheck-last-restart"

log() { printf '%s healthcheck %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

exec 9>"$state_dir/khunt-healthcheck.lock"
flock -n 9 || { log "skipped: previous check still running"; exit 0; }

# Echoes online, stopped, errored, ... or "missing" (not in PM2's list) or "error" (pm2 unusable).
pm2_status() {
  pm2 jlist 2>/dev/null | node -e '
    let raw = "";
    process.stdin.on("data", (d) => (raw += d)).on("end", () => {
      try {
        const list = JSON.parse(raw.slice(raw.indexOf("[")));
        const proc = list.find((p) => p.name === process.argv[1]);
        console.log(proc ? proc.pm2_env.status : "missing");
      } catch {
        console.log("error");
      }
    });' "$app"
}

healthy() {
  local try
  for try in 1 2 3; do
    curl -fsS -o /dev/null --max-time "$timeout_s" -H 'api-v: v1' "$url" 2>/dev/null && return 0
    sleep 3
  done
  return 1
}

restart_allowed() {
  [[ -f "$marker" ]] || return 0
  local last now
  last="$(stat -c %Y "$marker" 2>/dev/null || echo 0)"
  now="$(date +%s)"
  (( now - last >= cooldown ))
}

act() { # act <reason> <pm2 command...>
  local reason="$1"
  shift
  if ! restart_allowed; then
    log "$reason, but a restart already happened in the last ${cooldown}s: not restarting"
    return 0
  fi
  log "$reason: running $*"
  touch "$marker"
  if "$@" >/dev/null 2>&1; then log "$2 ok"; else log "$2 FAILED"; return 1; fi
}

status="$(pm2_status)"
case "$status" in
  online)
    if healthy; then
      log "ok (status=online, health ok)"
    else
      act "process is online but $url is not answering" pm2 restart "$app"
    fi
    ;;
  missing)
    act "$app is not registered in PM2" pm2 start "$root/deploy/ecosystem.config.cjs" --only "$app"
    ;;
  error)
    log "cannot read pm2 jlist (pm2 or node missing, or the PM2 daemon is not running for this user)"
    exit 1
    ;;
  *)
    act "status is '$status'" pm2 restart "$app"
    ;;
esac
