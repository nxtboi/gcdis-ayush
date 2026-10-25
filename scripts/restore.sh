#!/bin/sh
# ==============================================================================
# GCDIS Encrypted Restore Script
#
# Usage:
#   scripts/restore.sh [--yes] <gcdis_db_*.dump.enc> [gcdis_uploads_*.tar.gz.enc]
#
# - Verifies the HMAC-SHA256 sidecar (<file>.hmac, written by backup.sh) BEFORE
#   decrypting; refuses tampered/truncated archives.
# - Streams decryption straight into pg_restore (no plaintext dump on disk).
# - DESTRUCTIVE: pg_restore --clean drops existing objects. Requires --yes or an
#   interactive "RESTORE <dbname>" confirmation.
#
# Env: BACKUP_ENCRYPTION_KEY (required), PGHOST, PGUSER, PGPASSWORD, PGDATABASE,
#      UPLOADS_DIR (target for the uploads archive, default /uploads).
#   Run as the migration owner (PGUSER=gcdis_admin) so restored objects are owned
#   by it; then re-apply runtime grants (privileges are not restored):
#     docker compose -f docker-compose.prod.yml run --rm migrate
# ==============================================================================
set -eu
set -o pipefail

ASSUME_YES=0
if [ "${1:-}" = "--yes" ] || [ "${1:-}" = "-y" ]; then
  ASSUME_YES=1
  shift
fi

ENC_FILE="${1:-}"
UPLOADS_FILE="${2:-}"
UPLOADS_DIR="${UPLOADS_DIR:-/uploads}"
DB_NAME="${PGDATABASE:-gcdis}"

if [ -z "$ENC_FILE" ] || [ ! -f "$ENC_FILE" ]; then
  echo "Usage: $0 [--yes] <path_to_encrypted_dump.enc> [path_to_uploads.tar.gz.enc]" >&2
  exit 1
fi
if [ -n "$UPLOADS_FILE" ] && [ ! -f "$UPLOADS_FILE" ]; then
  echo "FATAL: uploads archive '$UPLOADS_FILE' not found." >&2
  exit 1
fi

if [ -z "${BACKUP_ENCRYPTION_KEY:-}" ]; then
  echo "FATAL: BACKUP_ENCRYPTION_KEY environment variable is required." >&2
  exit 1
fi
export BACKUP_ENCRYPTION_KEY

mac_key() {
  printf 'gcdis-backup-hmac-v1:%s' "$BACKUP_ENCRYPTION_KEY" | openssl dgst -sha256 -r | cut -d' ' -f1
}

verify_hmac() {
  _file="$1"
  if [ ! -f "${_file}.hmac" ]; then
    echo "FATAL: integrity tag ${_file}.hmac is missing; refusing to restore unauthenticated data." >&2
    exit 1
  fi
  _key="$(mac_key)"
  _expected="$(tr -d ' \r\n' < "${_file}.hmac")"
  _actual="$(openssl dgst -sha256 -mac HMAC -macopt "hexkey:${_key}" -r "$_file" | cut -d' ' -f1)"
  if [ "$_expected" != "$_actual" ]; then
    echo "FATAL: HMAC verification FAILED for $_file (wrong key, corrupted or tampered archive)." >&2
    exit 1
  fi
  echo "[Restore] Integrity verified: $(basename "$_file")"
}

decrypt_stream() {
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -pass env:BACKUP_ENCRYPTION_KEY -in "$1"
}

verify_hmac "$ENC_FILE"
[ -n "$UPLOADS_FILE" ] && verify_hmac "$UPLOADS_FILE"

if [ "$ASSUME_YES" -ne 1 ]; then
  if [ ! -t 0 ]; then
    echo "FATAL: restore drops and recreates all objects in '${DB_NAME}'. Re-run with --yes to confirm non-interactively." >&2
    exit 1
  fi
  echo "WARNING: this will DROP and replace all objects in database '${DB_NAME}' on ${PGHOST:-localhost}."
  [ -n "$UPLOADS_FILE" ] && echo "WARNING: files in ${UPLOADS_DIR} will be overwritten from the archive."
  printf 'Type "RESTORE %s" to continue: ' "$DB_NAME"
  read -r answer
  if [ "$answer" != "RESTORE ${DB_NAME}" ]; then
    echo "Aborted." >&2
    exit 1
  fi
fi

echo "[Restore] Decrypting and restoring database ${DB_NAME}..."
decrypt_stream "$ENC_FILE" | pg_restore -h "${PGHOST:-localhost}" -U "${PGUSER:-postgres}" \
  --clean --if-exists --no-owner --no-privileges \
  -d "$DB_NAME"
echo "[Restore] Database successfully restored from encrypted archive."

if [ -n "$UPLOADS_FILE" ]; then
  echo "[Restore] Restoring uploads into ${UPLOADS_DIR}..."
  mkdir -p "$UPLOADS_DIR"
  decrypt_stream "$UPLOADS_FILE" | tar -C "$UPLOADS_DIR" -xzf -
  echo "[Restore] Uploads restored."
fi

echo "[Restore] NOTE: privileges were not restored. Re-apply runtime grants with:"
echo "          docker compose -f docker-compose.prod.yml run --rm migrate"
