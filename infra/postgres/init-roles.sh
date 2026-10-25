#!/bin/sh
# ==============================================================================
# GCDIS PostgreSQL first-boot role provisioning
# Runs ONCE (docker-entrypoint-initdb.d) on an empty data directory, i.e. BEFORE
# any table exists. Table-level hardening (audit_logs REVOKE, re-applied grants)
# therefore lives in infra/postgres/post-migrate-grants.sql, executed by the
# one-shot `migrate` service after every `prisma migrate deploy`.
#
# Idempotent: safe to re-run on an existing cluster (e.g. to rotate role passwords
# or to repair default privileges):
#   docker compose -f docker-compose.prod.yml exec postgres \
#     sh /docker-entrypoint-initdb.d/init-roles.sh
#
# Roles:
#   gcdis_admin - migration owner (DDL); owns every table created by migrations
#   gcdis_app   - least-privilege runtime role (DML only)
#   gcdis_backup - read-only role used by pg_dump (member of pg_read_all_data)
# ==============================================================================
set -eu

echo "[PostgreSQL Init] Initializing separate roles: migration owner vs least-privilege runtime role..."

# No fallback passwords: refuse to provision roles with guessable credentials.
: "${POSTGRES_APP_PASSWORD:?POSTGRES_APP_PASSWORD must be set}"
: "${POSTGRES_ADMIN_PASSWORD:?POSTGRES_ADMIN_PASSWORD must be set}"
: "${POSTGRES_BACKUP_PASSWORD:?POSTGRES_BACKUP_PASSWORD must be set}"
: "${POSTGRES_USER:?POSTGRES_USER must be set}"
DB_NAME="${POSTGRES_DB:?POSTGRES_DB must be set}"

# Values are passed as psql variables and expanded with :'var' / :"var" quoting,
# so passwords / db names containing quotes cannot break out of the SQL literal.
# (psql does not interpolate variables inside DO $$ bodies, hence \gexec.)
psql -v ON_ERROR_STOP=1 \
     -v app_pass="$POSTGRES_APP_PASSWORD" \
     -v admin_pass="$POSTGRES_ADMIN_PASSWORD" \
     -v backup_pass="$POSTGRES_BACKUP_PASSWORD" \
     -v db_name="$DB_NAME" \
     --username "$POSTGRES_USER" --dbname "$DB_NAME" <<'EOSQL'
-- 1. Create Migration Owner Role (or rotate its password if it already exists)
SELECT format('CREATE ROLE gcdis_admin WITH LOGIN PASSWORD %L', :'admin_pass')
 WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'gcdis_admin')
\gexec
SELECT format('ALTER ROLE gcdis_admin WITH LOGIN PASSWORD %L', :'admin_pass')
\gexec

-- 2. Create Least-Privilege Runtime Role
SELECT format('CREATE ROLE gcdis_app WITH LOGIN PASSWORD %L', :'app_pass')
 WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'gcdis_app')
\gexec
SELECT format('ALTER ROLE gcdis_app WITH LOGIN PASSWORD %L', :'app_pass')
\gexec

-- 2b. Read-only backup role (pg_dump only needs to read every table)
SELECT format('CREATE ROLE gcdis_backup WITH LOGIN PASSWORD %L', :'backup_pass')
 WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'gcdis_backup')
\gexec
SELECT format('ALTER ROLE gcdis_backup WITH LOGIN PASSWORD %L', :'backup_pass')
\gexec
GRANT CONNECT ON DATABASE :"db_name" TO gcdis_backup;
GRANT pg_read_all_data TO gcdis_backup;

-- 2c. Nobody gets implicit database privileges (PostgreSQL grants CONNECT and
--     TEMPORARY to PUBLIC by default); each role below is granted what it needs.
REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;

-- 3. Migration owner: owns schema public so prisma migrate deploy can run DDL
GRANT CONNECT, CREATE, TEMPORARY ON DATABASE :"db_name" TO gcdis_admin;
ALTER SCHEMA public OWNER TO gcdis_admin;
GRANT USAGE, CREATE ON SCHEMA public TO gcdis_admin;

-- 4. Runtime role: DML only, no DDL
GRANT CONNECT ON DATABASE :"db_name" TO gcdis_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM gcdis_app;
GRANT USAGE ON SCHEMA public TO gcdis_app;

-- 5. Default privileges for objects created BY gcdis_admin (i.e. by migrations).
--    Without FOR ROLE these would only apply to objects created by POSTGRES_USER.
ALTER DEFAULT PRIVILEGES FOR ROLE gcdis_admin IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gcdis_app;
ALTER DEFAULT PRIVILEGES FOR ROLE gcdis_admin IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO gcdis_app;
ALTER DEFAULT PRIVILEGES FOR ROLE gcdis_admin IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO gcdis_app;
EOSQL

echo "[PostgreSQL Init] Roles and default privileges applied. Table-level grants are applied post-migration."
