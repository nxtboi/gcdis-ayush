-- ==============================================================================
-- GCDIS post-migration privilege hardening (idempotent)
-- Executed by the one-shot `migrate` service (docker-compose.prod.yml) as the
-- migration owner (gcdis_admin) immediately after `prisma migrate deploy`:
--   npx prisma db execute --schema prisma/schema.prisma --file /infra/post-migrate-grants.sql
-- Safe to run any number of times.
-- ==============================================================================

-- 0. Default privileges for every object the migration owner creates FROM NOW ON
--    (no FOR ROLE clause => applies to the executing role, i.e. gcdis_admin).
--    init-roles.sh sets the same defaults on a fresh cluster; repeating them here
--    makes databases created before that change (or restored from a dump) correct
--    as well. A new table added by a future migration is therefore usable by
--    gcdis_app immediately, even before this script re-runs.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gcdis_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO gcdis_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO gcdis_app;

-- 1. Runtime role: DML on every existing table/sequence (covers objects created
--    before default privileges were in place, e.g. legacy databases).
--    The runtime role may never create objects in the schema.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM gcdis_app;
GRANT USAGE ON SCHEMA public TO gcdis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gcdis_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gcdis_app;
-- Repair drift: privileges beyond DML are never needed at runtime.
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM gcdis_app;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM PUBLIC;

-- Prisma bookkeeping table is migration-owner only
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename = '_prisma_migrations') THEN
    REVOKE ALL ON TABLE public._prisma_migrations FROM gcdis_app;
    REVOKE ALL ON TABLE public._prisma_migrations FROM PUBLIC;
  END IF;
END
$$;

-- 2. audit_logs is append-only for the runtime role
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename = 'audit_logs') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.audit_logs FROM PUBLIC;
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.audit_logs FROM gcdis_app;
    GRANT SELECT, INSERT ON TABLE public.audit_logs TO gcdis_app;
  ELSE
    RAISE NOTICE 'audit_logs table not found; skipping append-only grants';
  END IF;
END
$$;

-- 3. Defence in depth: block mutation even for privileged roles.
--    Row-level UPDATE/DELETE trigger is created by the Prisma migration
--    20261010000000_audit_log_append_only; add a statement-level TRUNCATE guard.
CREATE OR REPLACE FUNCTION public.block_audit_log_truncate()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog is append-only: TRUNCATE is forbidden.';
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename = 'audit_logs') THEN
    DROP TRIGGER IF EXISTS trg_block_audit_log_truncate ON public.audit_logs;
    CREATE TRIGGER trg_block_audit_log_truncate
      BEFORE TRUNCATE ON public.audit_logs
      FOR EACH STATEMENT
      EXECUTE FUNCTION public.block_audit_log_truncate();
  END IF;
END
$$;
