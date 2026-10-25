#!/bin/sh
# ==============================================================================
# GCDIS encrypted backup restore (database and, optionally, the uploads archive)
#
# Usage:
#   restore.sh [options] <gcdis_db_YYYYmmdd_HHMMSS.dump.enc>
#
# Options:
#   --target-db NAME     database to restore into (default: $PGDATABASE)
#   --create             create the target database first if it does not exist
#                        (the connecting role needs CREATEDB)
#   --clean              allow restoring over a database that already contains
#                        tables: existing objects are DROPPED and replaced
#   --uploads FILE       also restore this gcdis_uploads_*.tar.gz.enc archive
#   --uploads-dir DIR    where to extract the uploads archive (default: $UPLOADS_DIR
#                        or /uploads); must be empty unless --clean is given
#   --key-file PATH      read the passphrase from PATH instead of $BACKUP_ENCRYPTION_KEY
#   --list               verify + decrypt and print the archive table of contents;
#                        changes nothing
#   --yes                do not prompt (required when stdin is not a terminal)
#   -h, --help
#
# Safety:
#   * The HMAC-SHA256 sidecar (<file>.hmac, written by scripts/backup.sh) is verified
#     BEFORE anything is decrypted; tampered, truncated or wrong-key archives are refused.
#   * Decryption is streamed straight into pg_restore; no plaintext dump touches disk.
#   * The restore runs in ONE transaction (--single-transaction --exit-on-error): if
#     anything fails, the target database is left exactly as it was.
#   * A non-empty target database is refused unless --clean is passed, and every
#     destructive run asks the operator to type "RESTORE <db>@<host>" (or --yes).
#
# Connection: standard libpq variables PGHOST, PGPORT, PGUSER, PGPASSWORD.
#   For production, connect as the migration owner (PGUSER=gcdis_admin) so restored
#   objects are owned by it, then re-apply the runtime grants (privileges are NOT
#   restored, by design):
#     docker compose -f docker-compose.prod.yml run --rm migrate
# ==============================================================================
set -eu
set -o pipefail

usage() { sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; }
die() { echo "[Restore] FATAL: $*" >&2; exit 1; }

TARGET_DB="${PGDATABASE:-}"
CREATE_DB=0
CLEAN=0
LIST_ONLY=0
ASSUME_YES=0
UPLOADS_FILE=""
UPLOADS_DIR="${UPLOADS_DIR:-/uploads}"
KEY_FILE=""
ENC_FILE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --target-db)   [ $# -ge 2 ] || die "--target-db needs a value"; TARGET_DB="$2"; shift 2 ;;
    --create)      CREATE_DB=1; shift ;;
    --clean)       CLEAN=1; shift ;;
    --uploads)     [ $# -ge 2 ] || die "--uploads needs a value"; UPLOADS_FILE="$2"; shift 2 ;;
    --uploads-dir) [ $# -ge 2 ] || die "--uploads-dir needs a value"; UPLOADS_DIR="$2"; shift 2 ;;
    --key-file)    [ $# -ge 2 ] || die "--key-file needs a value"; KEY_FILE="$2"; shift 2 ;;
    --list)        LIST_ONLY=1; shift ;;
    --yes|-y)      ASSUME_YES=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    --)            shift; break ;;
    -*)            die "unknown option: $1 (see --help)" ;;
    *)             [ -z "$ENC_FILE" ] || die "unexpected argument: $1"; ENC_FILE="$1"; shift ;;
  esac
done
[ -z "$ENC_FILE" ] && [ $# -gt 0 ] && ENC_FILE="$1"

[ -n "$ENC_FILE" ] || { usage >&2; exit 1; }
[ -f "$ENC_FILE" ] || die "database archive '$ENC_FILE' not found"
[ -z "$UPLOADS_FILE" ] || [ -f "$UPLOADS_FILE" ] || die "uploads archive '$UPLOADS_FILE' not found"

if [ -n "$KEY_FILE" ]; then
  [ -r "$KEY_FILE" ] || die "key file '$KEY_FILE' is not readable"
  BACKUP_ENCRYPTION_KEY="$(tr -d '\r\n' < "$KEY_FILE")"
fi
[ -n "${BACKUP_ENCRYPTION_KEY:-}" ] || die "BACKUP_ENCRYPTION_KEY (or --key-file) is required"
export BACKUP_ENCRYPTION_KEY

for bin in openssl pg_restore psql; do
  command -v "$bin" >/dev/null 2>&1 || die "'$bin' is not installed"
done

# --- integrity (encrypt-then-MAC, same derivation as scripts/backup.sh) ---------
mac_key() {
  printf 'gcdis-backup-hmac-v1:%s' "$BACKUP_ENCRYPTION_KEY" | openssl dgst -sha256 -r | cut -d' ' -f1
}
verify_hmac() {
  _file="$1"
  [ -f "${_file}.hmac" ] || die "integrity tag ${_file}.hmac is missing; refusing unauthenticated data"
  _expected="$(tr -d ' \r\n' < "${_file}.hmac")"
  _actual="$(openssl dgst -sha256 -mac HMAC -macopt "hexkey:$(mac_key)" -r "$_file" | cut -d' ' -f1)"
  [ "$_expected" = "$_actual" ] || die "HMAC verification FAILED for $_file (wrong key, corrupted or tampered)"
  echo "[Restore] Integrity verified: $(basename "$_file")"
}
decrypt_stream() {
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -pass env:BACKUP_ENCRYPTION_KEY -in "$1"
}

verify_hmac "$ENC_FILE"
[ -z "$UPLOADS_FILE" ] || verify_hmac "$UPLOADS_FILE"

if [ "$LIST_ONLY" -eq 1 ]; then
  # pg_restore -l stops reading after the TOC; drain the rest so openssl is not
  # cut off mid-stream (which it reports as "bad decrypt" and pipefail turns fatal).
  decrypt_stream "$ENC_FILE" | { pg_restore -l; cat >/dev/null; }
  if [ -n "$UPLOADS_FILE" ]; then
    echo "[Restore] Uploads archive contains $(decrypt_stream "$UPLOADS_FILE" | { tar -tzf -; cat >/dev/null; } | wc -l) entries."
  fi
  exit 0
fi

[ -n "$TARGET_DB" ] || die "no target database: pass --target-db or set PGDATABASE"
HOST_LABEL="${PGHOST:-localhost}:${PGPORT:-5432}"

# Connect to the maintenance DB to check / create the target.
# psql does not interpolate :variables inside -c strings, so variable-bearing
# statements are piped through stdin.
psql_admin() { psql -X -v ON_ERROR_STOP=1 -At -d postgres "$@"; }
psql_target() { psql -X -v ON_ERROR_STOP=1 -At -d "$TARGET_DB" "$@"; }

DB_EXISTS="$(echo "SELECT 1 FROM pg_database WHERE datname = :'db'" | psql_admin -v db="$TARGET_DB" 2>/dev/null || true)"
if [ "$DB_EXISTS" != "1" ]; then
  # Fall back to connecting directly (role may lack CONNECT on "postgres").
  if psql_target -c 'SELECT 1' >/dev/null 2>&1; then
    DB_EXISTS=1
  fi
fi

TABLE_COUNT=0
if [ "$DB_EXISTS" = "1" ]; then
  TABLE_COUNT="$(psql_target -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
  if [ "$TABLE_COUNT" -gt 0 ] && [ "$CLEAN" -ne 1 ]; then
    die "target '$TARGET_DB' on $HOST_LABEL already contains $TABLE_COUNT tables; pass --clean to replace them"
  fi
elif [ "$CREATE_DB" -ne 1 ]; then
  die "target database '$TARGET_DB' does not exist on $HOST_LABEL (pass --create)"
fi

if [ -n "$UPLOADS_FILE" ] && [ -d "$UPLOADS_DIR" ] && [ -n "$(ls -A "$UPLOADS_DIR" 2>/dev/null)" ] && [ "$CLEAN" -ne 1 ]; then
  die "uploads directory '$UPLOADS_DIR' is not empty; pass --clean to overwrite files"
fi

echo "[Restore] Source : $(basename "$ENC_FILE")"
echo "[Restore] Target : database '$TARGET_DB' on $HOST_LABEL as ${PGUSER:-$(id -un)} (existing tables: $TABLE_COUNT)"
[ -z "$UPLOADS_FILE" ] || echo "[Restore] Uploads: $(basename "$UPLOADS_FILE") -> $UPLOADS_DIR"

if [ "$ASSUME_YES" -ne 1 ]; then
  [ -t 0 ] || die "refusing to run non-interactively without --yes"
  [ "$TABLE_COUNT" -gt 0 ] && echo "WARNING: all existing objects in '$TARGET_DB' will be DROPPED and replaced."
  printf 'Type "RESTORE %s@%s" to continue: ' "$TARGET_DB" "$HOST_LABEL"
  read -r answer
  [ "$answer" = "RESTORE ${TARGET_DB}@${HOST_LABEL}" ] || die "confirmation did not match; aborted"
fi

if [ "$DB_EXISTS" != "1" ]; then
  echo "[Restore] Creating database '$TARGET_DB'..."
  echo 'CREATE DATABASE :"db"' | psql_admin -v db="$TARGET_DB"
fi

START_TS=$(date +%s)
CLEAN_FLAGS=""
[ "$TABLE_COUNT" -gt 0 ] && CLEAN_FLAGS="--clean --if-exists"

echo "[Restore] Decrypting and restoring (single transaction)..."
# shellcheck disable=SC2086
decrypt_stream "$ENC_FILE" | pg_restore $CLEAN_FLAGS \
  --no-owner --no-privileges --single-transaction --exit-on-error \
  -d "$TARGET_DB"
echo "[Restore] Database restored in $(( $(date +%s) - START_TS ))s."

if [ -n "$UPLOADS_FILE" ]; then
  mkdir -p "$UPLOADS_DIR"
  echo "[Restore] Extracting uploads into $UPLOADS_DIR..."
  decrypt_stream "$UPLOADS_FILE" | tar -C "$UPLOADS_DIR" -xzf -
  echo "[Restore] Uploads restored ($(find "$UPLOADS_DIR" -type f | wc -l) files)."
fi

echo "[Restore] Done. Privileges were not restored; re-apply runtime grants with:"
echo "          docker compose -f docker-compose.prod.yml run --rm migrate"
