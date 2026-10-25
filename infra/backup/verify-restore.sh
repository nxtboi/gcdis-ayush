#!/bin/sh
# ==============================================================================
# GCDIS restore drill: restore the LATEST encrypted backup into a scratch database
# and compare it with the live database. Never writes to the live database.
#
# Usage:
#   verify-restore.sh [--backup-dir DIR] [--file gcdis_db_*.dump.enc]
#                     [--max-drift-pct N] [--exact] [--keep]
#
#   --backup-dir DIR     where gcdis_db_*.dump.enc files live (default $BACKUP_DIR or /backups)
#   --file PATH          verify this archive instead of the newest one
#   --max-drift-pct N    allowed relative row-count difference per table between the
#                        live database and the restored copy (default 10). Rows written
#                        after the backup was taken make some drift normal.
#   --exact              require identical row counts (use when the source is quiet,
#                        e.g. right after a manual backup in a maintenance window)
#   --keep               do not drop the scratch database afterwards
#
# Environment:
#   BACKUP_ENCRYPTION_KEY          passphrase (required)
#   PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE
#                                  LIVE database, read-only access is enough
#                                  (the backup service's gcdis_backup role)
#   RESTORE_PGHOST/RESTORE_PGPORT/RESTORE_PGUSER/RESTORE_PGPASSWORD
#                                  SCRATCH server; the role needs CREATEDB.
#                                  Use a separate throwaway server (the `restore-drill`
#                                  compose profile starts one) - never production.
#   RESTORE_DB                     scratch database name (default gcdis_restore_verify)
#   VERIFY_TABLES                  space-separated key tables to compare (default below)
#
# Exit status: 0 = drill passed; non-zero = drill failed (details on stderr).
# ==============================================================================
set -eu
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
FILE=""
MAX_DRIFT_PCT=10
EXACT=0
KEEP=0
RESTORE_DB="${RESTORE_DB:-gcdis_restore_verify}"
VERIFY_TABLES="${VERIFY_TABLES:-users teams team_members registrations payments events categories certificates documents audit_logs sessions site_settings gallery_images sponsors}"

die() { echo "[Verify] FAIL: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --backup-dir)    BACKUP_DIR="$2"; shift 2 ;;
    --file)          FILE="$2"; shift 2 ;;
    --max-drift-pct) MAX_DRIFT_PCT="$2"; shift 2 ;;
    --exact)         EXACT=1; shift ;;
    --keep)          KEEP=1; shift ;;
    -h|--help)       sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)               die "unknown argument: $1" ;;
  esac
done

: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY is required}"
: "${PGDATABASE:?PGDATABASE (live database) is required}"
: "${RESTORE_PGHOST:?RESTORE_PGHOST (scratch server) is required}"
case "$RESTORE_DB" in
  "$PGDATABASE") [ "${RESTORE_PGHOST}" != "${PGHOST:-localhost}" ] || die "RESTORE_DB must differ from the live database on the same host" ;;
esac
case "$RESTORE_DB" in *[!a-z0-9_]*|"") die "RESTORE_DB must match [a-z0-9_]+" ;; esac

if [ -z "$FILE" ]; then
  # Timestamped names sort chronologically.
  FILE="$(ls -1 "$BACKUP_DIR"/gcdis_db_*.dump.enc 2>/dev/null | sort | tail -n 1 || true)"
  [ -n "$FILE" ] || die "no gcdis_db_*.dump.enc found in $BACKUP_DIR"
fi
[ -f "$FILE" ] || die "archive $FILE not found"

BACKUP_TS="$(basename "$FILE" | sed -n 's/^gcdis_db_\([0-9]\{8\}_[0-9]\{6\}\)\.dump\.enc$/\1/p')"
echo "[Verify] Archive: $(basename "$FILE") (taken ${BACKUP_TS:-unknown})"
if [ -n "$BACKUP_TS" ]; then
  AGE_H=$(( ( $(date +%s) - $(date -d "$(echo "$BACKUP_TS" | sed 's/^\(....\)\(..\)\(..\)_\(..\)\(..\)\(..\)$/\1-\2-\3 \4:\5:\6/')" +%s 2>/dev/null || date +%s) ) / 3600 ))
  echo "[Verify] Backup age: ~${AGE_H}h"
  [ "$AGE_H" -le "${MAX_BACKUP_AGE_HOURS:-26}" ] || echo "[Verify] WARNING: newest backup is older than ${MAX_BACKUP_AGE_HOURS:-26}h (RPO breach?)" >&2
fi

# Run a command against the scratch server.
scratch() {
  PGHOST="$RESTORE_PGHOST" PGPORT="${RESTORE_PGPORT:-5432}" \
  PGUSER="${RESTORE_PGUSER:-postgres}" PGPASSWORD="${RESTORE_PGPASSWORD:-}" \
  PGDATABASE="$RESTORE_DB" "$@"
}

cleanup() {
  if [ "$KEEP" -ne 1 ]; then
    scratch psql -X -q -d postgres -c "DROP DATABASE IF EXISTS \"$RESTORE_DB\"" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# Start from an empty scratch database every time.
scratch psql -X -q -v ON_ERROR_STOP=1 -d postgres -c "DROP DATABASE IF EXISTS \"$RESTORE_DB\"" >/dev/null

START=$(date +%s)
scratch sh "$SCRIPT_DIR/restore.sh" --target-db "$RESTORE_DB" --create --yes "$FILE"
ELAPSED=$(( $(date +%s) - START ))
echo "[Verify] Restore duration: ${ELAPSED}s"

live_q() { psql -X -At -v ON_ERROR_STOP=1 -c "$1"; }
scr_q() { scratch psql -X -At -v ON_ERROR_STOP=1 -c "$1"; }

FAILED=0

# 1. Schema: every live table must exist in the restored copy.
LIVE_TABLES="$(live_q "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1")"
SCR_TABLES="$(scr_q "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1")"
for t in $LIVE_TABLES; do
  if ! echo "$SCR_TABLES" | grep -qx "$t"; then
    # A table created by a migration applied after the backup is acceptable.
    echo "[Verify] note: live table '$t' is not in the backup (created after it was taken?)"
  fi
done
echo "[Verify] Restored tables: $(echo "$SCR_TABLES" | grep -c . || true)"

# 2. Migrations: the restored migration history must be a prefix of the live one.
#    (gcdis_backup reads _prisma_migrations through pg_read_all_data.)
SCR_MIG="$(scr_q "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name" 2>/dev/null || true)"
LIVE_MIG="$(live_q "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name" 2>/dev/null || true)"
if [ -n "$LIVE_MIG" ]; then
  N=$(echo "$SCR_MIG" | grep -c . || true)
  if [ "$(echo "$LIVE_MIG" | head -n "$N")" != "$SCR_MIG" ] || [ "$N" -eq 0 ]; then
    echo "[Verify] FAIL: restored migration history is not a prefix of the live history" >&2
    FAILED=1
  else
    echo "[Verify] Migrations: $N restored / $(echo "$LIVE_MIG" | grep -c .) live - OK"
  fi
fi

# 3. Row counts of key tables.
printf '[Verify] %-26s %10s %10s  %s\n' table live restored status
for t in $VERIFY_TABLES; do
  echo "$SCR_TABLES" | grep -qx "$t" || { echo "$LIVE_TABLES" | grep -qx "$t" && { echo "[Verify] FAIL: key table $t missing from restore" >&2; FAILED=1; }; continue; }
  L="$(live_q "SELECT count(*) FROM public.\"$t\"")"
  R="$(scr_q "SELECT count(*) FROM public.\"$t\"")"
  STATUS=OK
  if [ "$EXACT" -eq 1 ]; then
    [ "$L" -eq "$R" ] || STATUS=MISMATCH
  else
    DIFF=$(( L > R ? L - R : R - L ))
    BASE=$(( L > 0 ? L : 1 ))
    if [ "$L" -gt 0 ] && [ "$R" -eq 0 ]; then STATUS=EMPTY
    elif [ $(( DIFF * 100 / BASE )) -gt "$MAX_DRIFT_PCT" ]; then STATUS=DRIFT
    fi
  fi
  printf '[Verify] %-26s %10s %10s  %s\n' "$t" "$L" "$R" "$STATUS"
  [ "$STATUS" = OK ] || FAILED=1
done

# 4. Append-only guard survived the restore (triggers are part of the dump).
TRG="$(scr_q "SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.audit_logs'::regclass AND NOT tgisinternal" 2>/dev/null || echo 0)"
if [ "$TRG" -ge 1 ]; then
  echo "[Verify] audit_logs append-only triggers restored: $TRG"
else
  echo "[Verify] FAIL: audit_logs triggers missing in restored copy" >&2; FAILED=1
fi

# 5. Matching uploads archive (same timestamp) decrypts and lists.
UP="$(dirname "$FILE")/gcdis_uploads_${BACKUP_TS}.tar.gz.enc"
if [ -n "$BACKUP_TS" ] && [ -f "$UP" ]; then
  ENTRIES="$(sh "$SCRIPT_DIR/restore.sh" --list --uploads "$UP" "$FILE" | sed -n 's/.*contains \([0-9]*\) entries.*/\1/p')"
  echo "[Verify] Uploads archive $(basename "$UP"): ${ENTRIES:-?} entries, integrity OK"
fi

if [ "$FAILED" -ne 0 ]; then
  echo "[Verify] RESTORE DRILL FAILED" >&2
  exit 1
fi
echo "[Verify] RESTORE DRILL PASSED (restore took ${ELAPSED}s)"
