#!/bin/sh
# ==============================================================================
# GCDIS Encrypted Backup Script (database + uploads volume)
#
# - pg_dump is streamed straight into openssl: no plaintext dump ever touches disk.
# - Encryption: AES-256-CBC, PBKDF2 (100,000 iterations, random salt).
#   The passphrase is read from the environment (-pass env:...), never argv.
# - Integrity: encrypt-then-MAC. An HMAC-SHA256 tag of each ciphertext is written
#   to a "<file>.hmac" sidecar and verified by scripts/restore.sh BEFORE decryption.
#   The HMAC key is derived from BACKUP_ENCRYPTION_KEY (SHA-256 over a fixed label),
#   so a single secret is managed while the AES passphrase itself is never placed
#   on a command line.
# - Off-host copy to S3 when BACKUP_S3_BUCKET is set; upload failure => exit 1.
#
# Required env: BACKUP_ENCRYPTION_KEY, PGHOST, PGUSER, PGPASSWORD, PGDATABASE
#   PGUSER should be the read-only `gcdis_backup` role (pg_read_all_data),
#   provisioned by infra/postgres/init-roles.sh.
# Optional env: BACKUP_DIR (/backups), UPLOADS_DIR (/uploads; skipped if absent),
#   BACKUP_RETENTION_DAYS (14), BACKUP_S3_BUCKET, AWS_REGION
# ==============================================================================
set -eu
# busybox ash (postgres:*-alpine) and bash both support pipefail; required so a
# failing pg_dump/tar is not masked by a successful openssl at the end of the pipe.
set -o pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
UPLOADS_DIR="${UPLOADS_DIR:-/uploads}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DB_NAME="${PGDATABASE:?PGDATABASE is required}"

DB_BACKUP="${BACKUP_DIR}/gcdis_db_${TIMESTAMP}.dump.enc"
UPLOADS_BACKUP="${BACKUP_DIR}/gcdis_uploads_${TIMESTAMP}.tar.gz.enc"

if [ -z "${BACKUP_ENCRYPTION_KEY:-}" ]; then
  echo "FATAL: BACKUP_ENCRYPTION_KEY environment variable is required." >&2
  exit 1
fi
export BACKUP_ENCRYPTION_KEY

umask 077
mkdir -p "$BACKUP_DIR"

# Derive the HMAC key from the passphrase via stdin (not argv).
mac_key() {
  printf 'gcdis-backup-hmac-v1:%s' "$BACKUP_ENCRYPTION_KEY" | openssl dgst -sha256 -r | cut -d' ' -f1
}

# Writes "<file>.hmac" containing the hex HMAC-SHA256 of the ciphertext.
write_hmac() {
  _file="$1"
  _key="$(mac_key)"
  openssl dgst -sha256 -mac HMAC -macopt "hexkey:${_key}" -r "$_file" | cut -d' ' -f1 > "${_file}.hmac"
}

encrypt_stream() {
  openssl enc -aes-256-cbc -salt -pbkdf2 -iter 100000 -pass env:BACKUP_ENCRYPTION_KEY
}

cleanup_partial() {
  rm -f "${DB_BACKUP}.partial" "${UPLOADS_BACKUP}.partial"
}
trap cleanup_partial EXIT

# ------------------------------------------------------------------------------
# 1. Database
# ------------------------------------------------------------------------------
echo "[Backup] Streaming pg_dump of '${DB_NAME}' through AES-256-CBC (PBKDF2 100,000 iterations)..."
pg_dump -h "${PGHOST:-localhost}" -U "${PGUSER:-gcdis_backup}" -Fc --no-owner "$DB_NAME" \
  | encrypt_stream > "${DB_BACKUP}.partial"
mv "${DB_BACKUP}.partial" "$DB_BACKUP"
write_hmac "$DB_BACKUP"
echo "[Backup] Encrypted database backup created: $DB_BACKUP (+ .hmac)"

# ------------------------------------------------------------------------------
# 2. Uploads volume
# ------------------------------------------------------------------------------
if [ -d "$UPLOADS_DIR" ]; then
  echo "[Backup] Archiving uploads from ${UPLOADS_DIR}..."
  tar -C "$UPLOADS_DIR" -czf - . | encrypt_stream > "${UPLOADS_BACKUP}.partial"
  mv "${UPLOADS_BACKUP}.partial" "$UPLOADS_BACKUP"
  write_hmac "$UPLOADS_BACKUP"
  echo "[Backup] Encrypted uploads backup created: $UPLOADS_BACKUP (+ .hmac)"
else
  echo "[Backup] Uploads directory ${UPLOADS_DIR} not mounted; skipping uploads archive."
  UPLOADS_BACKUP=""
fi

# ------------------------------------------------------------------------------
# 3. Off-host replication (AWS S3 / compatible). Failure is fatal (non-zero exit)
#    so the daemon / monitoring notices; local encrypted copies are kept.
# ------------------------------------------------------------------------------
if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  echo "[Backup] Replicating encrypted backups to s3://${BACKUP_S3_BUCKET}/..."
  S3_FAILED=0
  for f in "$DB_BACKUP" "${DB_BACKUP}.hmac" ${UPLOADS_BACKUP:+"$UPLOADS_BACKUP" "${UPLOADS_BACKUP}.hmac"}; do
    case "$f" in
      *gcdis_db_*) prefix="db-backups" ;;
      *) prefix="uploads-backups" ;;
    esac
    if ! aws s3 cp "$f" "s3://${BACKUP_S3_BUCKET}/${prefix}/$(basename "$f")" \
         --region "${AWS_REGION:-ap-south-1}" --only-show-errors; then
      echo "[Backup ERROR] Off-host upload failed for $(basename "$f")." >&2
      S3_FAILED=1
    fi
  done
  if [ "$S3_FAILED" -ne 0 ]; then
    echo "[Backup ERROR] Off-host replication incomplete. Local encrypted snapshot preserved." >&2
    exit 2
  fi
else
  echo "[Backup WARNING] BACKUP_S3_BUCKET not set: backups exist on this host only."
fi

# ------------------------------------------------------------------------------
# 4. Local retention
# ------------------------------------------------------------------------------
echo "[Backup] Applying retention policy: pruning local backups older than ${RETENTION_DAYS} days..."
find "$BACKUP_DIR" -type f \( -name "*.enc" -o -name "*.enc.hmac" \) -mtime +"$RETENTION_DAYS" -delete

echo "[Backup] Backup process successfully completed at $(date)."
