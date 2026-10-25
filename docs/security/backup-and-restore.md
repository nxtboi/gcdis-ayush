# Backup and restore

This document describes how GCDIS production data is backed up, how to restore it,
the recovery objectives, and the monthly restore drill that proves the backups work.

## What is backed up

| Data | Where it lives | Backup file |
| --- | --- | --- |
| PostgreSQL database (all tables, functions, triggers) | `postgres_prod_data` volume | `gcdis_db_<YYYYmmdd_HHMMSS>.dump.enc` (+ `.hmac`) |
| Uploaded files (documents, CMS media) | `uploads_prod_data` volume | `gcdis_uploads_<YYYYmmdd_HHMMSS>.tar.gz.enc` (+ `.hmac`) |

Redis holds only short-lived data (rate-limit counters, socket state) and is not
backed up. Secrets live in `.env` on the host and in the password manager, never in
backups.

## How backups are made

The `backup` service (`docker-compose.prod.yml`, image `infra/backup/Dockerfile`)
runs `scripts/backup.sh` once every `BACKUP_INTERVAL_SECONDS` (default 24 h):

1. `pg_dump -Fc` runs as the read-only `gcdis_backup` role (member of
   `pg_read_all_data`; it cannot change any data).
2. The dump is streamed straight into `openssl enc -aes-256-cbc -pbkdf2 -iter 100000`
   with a random salt. No plaintext dump is written to disk. The passphrase
   (`BACKUP_ENCRYPTION_KEY`) is passed through the environment, never on a command line.
3. An HMAC-SHA256 tag of the ciphertext is written to `<file>.hmac`
   (encrypt-then-MAC). Restores refuse any archive whose tag does not match, so a
   truncated, corrupted or tampered file, or a wrong key, is detected before
   decryption.
4. The uploads volume is archived with `tar` and encrypted the same way.
5. When `BACKUP_S3_BUCKET` is set, both files and their tags are copied off-host.
   An upload failure makes the run fail.
6. Local copies older than `BACKUP_RETENTION_DAYS` (default 14) are deleted from
   `infra/backups/` on the host.

A failed run writes `/backups/.last_failure`, which marks the container unhealthy.
A successful run writes `/backups/.last_success`.

### Retention and storage requirements

- **Local:** 14 daily copies in `infra/backups/` (host directory, mode 0700, owned
  by root). This protects against application mistakes but not against loss of the
  host.
- **Off-host (required in production):** set `BACKUP_S3_BUCKET`. On the bucket:
  - turn on versioning and **Object Lock** (governance mode, 35 days) or an
    equivalent write-once setting, so a compromised host cannot delete the backups;
  - add a lifecycle rule: keep daily objects 35 days, then move to an archive storage
    class and expire after 400 days;
  - block all public access and enable default server-side encryption;
  - give the backup IAM user `s3:PutObject` only (no `s3:DeleteObject`, no `s3:GetObject`);
    restores use a separate, normally disabled, read credential.
- **Encryption key:** `BACKUP_ENCRYPTION_KEY` must be a random 32-byte value
  (`openssl rand -hex 32`). Store it in the password manager **and** in a sealed
  offline copy held by a second person. Without it the backups cannot be read. A
  short or memorable passphrase is not acceptable: the HMAC key is derived from it
  with a single SHA-256, so a weak passphrase could be guessed offline.

## Recovery objectives

| Objective | Target | Basis |
| --- | --- | --- |
| **RPO** (maximum data loss) | **24 hours** | one backup per day (`BACKUP_INTERVAL_SECONDS=86400`). During registration and payment windows set `BACKUP_INTERVAL_SECONDS=21600` (6 h RPO). Razorpay holds an independent record of every payment, so payments made after the last backup can be reconciled from the Razorpay dashboard. |
| **RTO** (time to restore service) | **2 hours** | restoring the database takes seconds to minutes at the current data size (the drill prints the measured time); most of the RTO is provisioning a host, fetching the archive and re-deploying. |

Review both targets after every drill: if `verify-restore.sh` reports a restore time
above 15 minutes or the newest backup is older than 26 hours, raise it with the
owner.

## Restoring

Two tools are baked into the backup image:

- `restore.sh`: verifies the HMAC, decrypts and restores one archive into a target
  database (and optionally extracts the uploads archive).
- `verify-restore.sh`: restores the newest archive into a scratch database and
  compares it with the live database (used by the drill).

### restore.sh safety features

- The HMAC is verified before anything is decrypted.
- The restore runs in a single transaction (`--single-transaction --exit-on-error`):
  if any step fails, the target database is left exactly as it was.
- A target that already contains tables is refused unless `--clean` is given.
- A missing target database is refused unless `--create` is given.
- Every destructive run asks the operator to type `RESTORE <db>@<host>:<port>`; in
  scripts, `--yes` is required, and without a terminal the script refuses to run.
- `--list` only verifies and prints the table of contents; it changes nothing.

Run `restore.sh --help` for all options.

### Full production restore (disaster recovery)

1. Declare an incident (see the production checklist) and stop writes:
   ```sh
   docker compose -f docker-compose.prod.yml stop proxy api
   ```
2. Fetch the archive (and its `.hmac`) to `infra/backups/` on the host if it is not
   already there (from S3 with the restore credential).
3. Check the archive without touching the database:
   ```sh
   docker compose -f docker-compose.prod.yml run --rm --entrypoint restore.sh backup \
     --list /backups/gcdis_db_YYYYmmdd_HHMMSS.dump.enc | head
   ```
4. Restore as the migration owner (so restored objects are owned by `gcdis_admin`):
   ```sh
   docker compose -f docker-compose.prod.yml run --rm \
     -e PGUSER=gcdis_admin -e PGPASSWORD="$POSTGRES_ADMIN_PASSWORD" \
     --entrypoint restore.sh backup \
     --clean --target-db "$POSTGRES_DB" \
     /backups/gcdis_db_YYYYmmdd_HHMMSS.dump.enc
   ```
   Add `--uploads /backups/gcdis_uploads_YYYYmmdd_HHMMSS.tar.gz.enc --uploads-dir /restore-uploads`
   with a writable mount of the uploads volume (for example
   `-v <project>_uploads_prod_data:/restore-uploads`, name from `docker volume ls`;
   the backup service mounts it read-only) and `--cap-add CHOWN --cap-add DAC_OVERRIDE`
   (tar restores the original `node` ownership) to restore files as well.
5. Re-apply the runtime grants and default privileges (privileges are deliberately
   not restored from the dump) and any newer migrations:
   ```sh
   docker compose -f docker-compose.prod.yml run --rm migrate
   ```
6. Confirm least privilege still holds:
   ```sh
   docker compose -f docker-compose.prod.yml exec -T -e PGPASSWORD="$POSTGRES_APP_PASSWORD" postgres \
     psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U gcdis_app -d "$POSTGRES_DB" -f - \
     < infra/postgres/verify-app-privileges.sql
   ```
7. Start the stack (`docker compose -f docker-compose.prod.yml up -d`), check
   `https://api.gcdis.in/api/health`, sign in to the console, and reconcile payments
   made after the backup with the Razorpay dashboard.
8. Revoke all sessions if the incident involved a compromise (rotate `JWT_*` and
   `COOKIE_SECRET`, see the production checklist).

## Monthly restore drill

Run on the first working day of every month, and after any change to the backup
scripts, the database version or the schema. The drill never writes to production:
it restores into a throwaway PostgreSQL server (data on tmpfs) started by the
`restore-drill` compose profile.

1. Take a fresh backup so the comparison is meaningful (optional but recommended):
   ```sh
   docker compose -f docker-compose.prod.yml exec backup sh /scripts/backup.sh
   ```
2. Run the drill:
   ```sh
   docker compose -f docker-compose.prod.yml --profile restore-drill run --rm restore-verify
   ```
   Options (appended to the command): `--exact` to require identical row counts
   (use right after step 1 in a quiet period), `--file /backups/<name>` to test a
   specific archive, `--max-drift-pct N` (default 10).
3. Remove the scratch server:
   ```sh
   docker compose -f docker-compose.prod.yml --profile restore-drill rm -sf restore-scratch
   ```
4. Once a quarter, also test an **off-host** copy: download the newest objects from
   S3 into `infra/backups/` on a different machine and run the drill there.
5. Record the result in the drill log (date, archive name, backup age, restore time,
   PASS/FAIL, who ran it). A failed drill is a high-severity incident.

`verify-restore.sh` checks that:

- the HMAC verifies and the archive decrypts and restores in one transaction;
- every key table (`users`, `teams`, `team_members`, `registrations`, `payments`,
  `events`, `categories`, `certificates`, `documents`, `audit_logs`, `sessions`,
  `site_settings`, `gallery_images`, `sponsors`) exists and its row count is within
  the allowed drift of the live database (and is not empty when the live table has rows);
- the restored Prisma migration history is a prefix of the live history;
- the append-only triggers on `audit_logs` were restored;
- the matching uploads archive verifies, decrypts and lists;
- the newest backup is not older than `MAX_BACKUP_AGE_HOURS` (default 26).

It exits non-zero on any failure and drops the scratch database afterwards
(`--keep` keeps it for inspection).

## Verification record

The procedure above was exercised end to end on 2026-10-12 in throwaway containers
(PostgreSQL 16, all Prisma migrations, seeded data):

- `backup.sh` ran in the hardened backup container (read-only root, all capabilities
  dropped except `DAC_READ_SEARCH`) as `gcdis_backup` and produced encrypted database
  and uploads archives;
- `verify-restore.sh --exact` passed (26 tables, 7/7 migrations, identical counts,
  3 audit triggers, uploads archive listed), also through the `restore-drill` profile;
- with 3 rows added after the backup the default drift check passed and `--exact`
  failed, as intended;
- a tampered archive and a wrong key were refused by the HMAC check; a non-empty
  target without `--clean`, a missing database without `--create` and a
  non-interactive run without `--yes` were all refused;
- a `--clean` restore over the live database as `gcdis_admin`, followed by
  `post-migrate-grants.sql`, returned the data to the backup state and
  `verify-app-privileges.sql` passed.
