-- ==============================================================================
-- GCDIS Platform: PostgreSQL AuditLog Append-Only Hardening Migration
-- ==============================================================================

-- 1. Create Trigger Function to block any UPDATE or DELETE operations on audit_logs
CREATE OR REPLACE FUNCTION prevent_audit_log_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'AuditLog is append-only. UPDATE, DELETE and TRUNCATE operations are strictly forbidden.';
END;
$$ LANGUAGE plpgsql;

-- 2. Drop existing trigger if already present (idempotent migration)
DROP TRIGGER IF EXISTS trg_prevent_audit_log_modification ON audit_logs;

-- 3. Create BEFORE UPDATE OR DELETE trigger on audit_logs table
CREATE TRIGGER trg_prevent_audit_log_modification
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW
EXECUTE FUNCTION prevent_audit_log_modification();

-- 4. Revoke UPDATE, DELETE, and TRUNCATE permissions on audit_logs from PUBLIC
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM PUBLIC;
