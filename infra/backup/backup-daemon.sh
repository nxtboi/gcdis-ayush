#!/bin/sh
# Runs scripts/backup.sh (mounted at /scripts/backup.sh) every BACKUP_INTERVAL_SECONDS.
# A failed run is logged loudly and the marker file /backups/.last_failure is written so
# host monitoring can alert on it; the daemon keeps running for the next attempt.
set -u

INTERVAL="${BACKUP_INTERVAL_SECONDS:-86400}"
trap 'exit 0' TERM INT

while :; do
  echo "[Backup Daemon] Initiating encrypted backup run at $(date)..."
  if sh /scripts/backup.sh; then
    date > /backups/.last_success
    rm -f /backups/.last_failure
    echo "[Backup Daemon] Run succeeded."
  else
    rc=$?
    echo "[Backup Daemon] ERROR: backup run failed with exit code $rc" >&2
    echo "$(date) exit=$rc" > /backups/.last_failure
  fi
  echo "[Backup Daemon] Sleeping for ${INTERVAL}s..."
  sleep "$INTERVAL" &
  wait $!
done
