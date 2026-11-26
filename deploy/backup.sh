#!/usr/bin/env bash
# Daily PostgreSQL backup: `pg_dump` in custom format, optionally encrypted with gpg, old files pruned.
#
# NOT done by this script (it needs the owner, see backend/README.md "Backups"):
#   - copying the file OFF this host (design section 10.3 says backups must be off-host), and
#   - TESTING a restore (the design requires a tested restore before launch).
#
# No credential is ever put on a command line or printed. Use libpq's own mechanisms:
#   PGHOST, PGPORT, PGUSER, PGDATABASE   connection (names only; not secret)
#   PGPASSFILE                           path to a chmod 600 .pgpass file holding the password
# Either export those in the cron environment or put them in a file and point BACKUP_ENV_FILE at it
# (the file is sourced, so keep it chmod 600 and owned by the app user).
#
# Other settings:
#   BACKUP_DIR              where files go (default: $HOME/backups/khunt)
#   BACKUP_RETENTION_DAYS   delete backups older than this many days after a successful run (default 14)
#   GPG_RECIPIENT           key id or e-mail of the PUBLIC key in this user's keyring. Set => the dump is
#                           piped straight into gpg, so no unencrypted copy is written to disk.
#                           Unset => the backup is NOT encrypted at rest and the script says so.
set -euo pipefail
umask 077

if [[ -n "${BACKUP_ENV_FILE:-}" ]]; then
  # shellcheck disable=SC1090
  source "$BACKUP_ENV_FILE"
fi

for var in PGHOST PGUSER PGDATABASE; do
  if [[ -z "${!var:-}" ]]; then
    echo "backup: $var is not set" >&2
    exit 2
  fi
done

backup_dir="${BACKUP_DIR:-$HOME/backups/khunt}"
retention_days="${BACKUP_RETENTION_DAYS:-14}"
if [[ ! "$retention_days" =~ ^[0-9]+$ ]] || (( retention_days < 1 )); then
  echo "backup: BACKUP_RETENTION_DAYS must be a whole number of days, 1 or more" >&2
  exit 2
fi

mkdir -p "$backup_dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
final="$backup_dir/khunt-$stamp.dump"
[[ -n "${GPG_RECIPIENT:-}" ]] && final="$final.gpg"
partial="$final.partial"
trap 'rm -f "$partial"' EXIT

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) backup: dumping database '$PGDATABASE' on '$PGHOST'"
if [[ -n "${GPG_RECIPIENT:-}" ]]; then
  pg_dump --format=custom --no-password | gpg --batch --yes --trust-model always --encrypt --recipient "$GPG_RECIPIENT" --output "$partial"
else
  echo "backup: WARNING GPG_RECIPIENT is not set; this backup is NOT encrypted at rest" >&2
  pg_dump --format=custom --no-password --file "$partial"
fi

if [[ ! -s "$partial" ]]; then
  echo "backup: the dump is empty, keeping older backups and failing" >&2
  exit 1
fi
# An unencrypted dump can be checked for readability right away; an encrypted one needs the private key.
if [[ -z "${GPG_RECIPIENT:-}" ]]; then
  pg_restore --list "$partial" >/dev/null
fi

mv "$partial" "$final"
trap - EXIT
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) backup: wrote $(basename "$final") ($(stat -c %s "$final") bytes)"

# Prune only after a new backup exists, so a failing dump never eats the older ones.
find "$backup_dir" -maxdepth 1 -type f -name 'khunt-*.dump*' -mtime +"$retention_days" -print -delete |
  sed 's/^/backup: pruned /'
