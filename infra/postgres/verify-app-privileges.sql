-- ==============================================================================
-- GCDIS least-privilege verification (read-only; changes nothing)
--
-- Run AS THE RUNTIME ROLE after migrations + post-migrate-grants.sql, e.g.:
--   docker compose -f docker-compose.prod.yml exec -T \
--     -e PGPASSWORD="$POSTGRES_APP_PASSWORD" postgres \
--     psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U gcdis_app -d "$POSTGRES_DB" \
--     -f - < infra/postgres/verify-app-privileges.sql
--
-- Every check is behavioural (the statement is really executed) but uses
-- WHERE false / a rolled-back sub-transaction, so no row is ever changed.
-- Privilege checks happen at executor start, i.e. even when zero rows match.
-- Exits non-zero (RAISE EXCEPTION) when any expectation is violated.
-- ==============================================================================

DO $verify$
DECLARE
  t        record;
  failures text[] := ARRAY[]::text[];
  checked  int := 0;
BEGIN
  IF current_user <> 'gcdis_app' THEN
    RAISE EXCEPTION 'run this script as gcdis_app (current_user = %)', current_user;
  END IF;

  -- 1. DML must work on every application table (audit_logs: SELECT/INSERT only)
  FOR t IN
    SELECT tablename FROM pg_catalog.pg_tables
     WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
     ORDER BY tablename
  LOOP
    checked := checked + 1;
    BEGIN
      EXECUTE format('SELECT 1 FROM public.%I LIMIT 0', t.tablename);
    EXCEPTION WHEN insufficient_privilege THEN
      failures := failures || format('SELECT denied on %s', t.tablename);
    END;
    BEGIN
      EXECUTE format('INSERT INTO public.%1$I SELECT * FROM public.%1$I WHERE false', t.tablename);
    EXCEPTION WHEN insufficient_privilege THEN
      failures := failures || format('INSERT denied on %s', t.tablename);
    END;

    IF t.tablename = 'audit_logs' THEN
      BEGIN
        EXECUTE 'UPDATE public.audit_logs SET id = id WHERE false';
        failures := failures || 'UPDATE allowed on audit_logs (must be append-only)'::text;
      EXCEPTION WHEN insufficient_privilege THEN NULL;
      END;
      BEGIN
        EXECUTE 'DELETE FROM public.audit_logs WHERE false';
        failures := failures || 'DELETE allowed on audit_logs (must be append-only)'::text;
      EXCEPTION WHEN insufficient_privilege THEN NULL;
      END;
    ELSE
      BEGIN
        -- SET <first column> = <itself>: needs UPDATE privilege, touches nothing
        EXECUTE format('UPDATE public.%1$I SET %2$I = %2$I WHERE false', t.tablename,
          (SELECT attname FROM pg_catalog.pg_attribute
            WHERE attrelid = format('public.%I', t.tablename)::regclass
              AND attnum > 0 AND NOT attisdropped ORDER BY attnum LIMIT 1));
      EXCEPTION WHEN insufficient_privilege THEN
        failures := failures || format('UPDATE denied on %s', t.tablename);
      END;
      BEGIN
        EXECUTE format('DELETE FROM public.%I WHERE false', t.tablename);
      EXCEPTION WHEN insufficient_privilege THEN
        failures := failures || format('DELETE denied on %s', t.tablename);
      END;
    END IF;

    -- TRUNCATE is never granted to the runtime role (wrapped in a sub-transaction
    -- that is always rolled back, in case it were unexpectedly allowed)
    BEGIN
      BEGIN
        EXECUTE format('TRUNCATE public.%I', t.tablename);
        failures := failures || format('TRUNCATE allowed on %s', t.tablename);
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'rollback-truncate';
      EXCEPTION WHEN insufficient_privilege THEN NULL;
      END;
    EXCEPTION WHEN raise_exception THEN NULL;
    END;

    -- DDL on existing tables (ALTER / DROP) requires ownership
    BEGIN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN zz_priv_probe int', t.tablename);
      failures := failures || format('ALTER TABLE allowed on %s', t.tablename);
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      BEGIN
        EXECUTE format('DROP TABLE public.%I', t.tablename);
        failures := failures || format('DROP TABLE allowed on %s', t.tablename);
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'rollback-drop';
      EXCEPTION WHEN insufficient_privilege THEN NULL;
      END;
    EXCEPTION WHEN raise_exception THEN NULL;
    END;
  END LOOP;

  -- 2. Prisma bookkeeping table is owner-only
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT 1 FROM public._prisma_migrations LIMIT 0';
      failures := failures || 'SELECT allowed on _prisma_migrations'::text;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
  END IF;

  -- 3. No CREATE in the schema (tables, views, functions)
  BEGIN
    EXECUTE 'CREATE TABLE public.zz_priv_probe (id int)';
    failures := failures || 'CREATE TABLE allowed in schema public'::text;
    EXECUTE 'DROP TABLE public.zz_priv_probe';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    EXECUTE 'CREATE FUNCTION public.zz_priv_probe() RETURNS int LANGUAGE sql AS ''SELECT 1''';
    failures := failures || 'CREATE FUNCTION allowed in schema public'::text;
    EXECUTE 'DROP FUNCTION public.zz_priv_probe()';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- 4. Role attributes
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles
              WHERE rolname = current_user
                AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)) THEN
    failures := failures || 'gcdis_app has an elevated role attribute'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tableowner = current_user) THEN
    failures := failures || 'gcdis_app owns tables'::text;
  END IF;

  IF array_length(failures, 1) IS NOT NULL THEN
    RAISE EXCEPTION E'least-privilege verification FAILED (% problems):\n  %',
      array_length(failures, 1), array_to_string(failures, E'\n  ');
  END IF;
  RAISE NOTICE 'least-privilege verification PASSED: % tables checked as %', checked, current_user;
END
$verify$;
