-- ==============================================================================
-- GCDIS Platform: AuditLog TRUNCATE guard (QA L13)
-- ==============================================================================
-- Row-level UPDATE/DELETE triggers do not fire for TRUNCATE, so the append-only
-- guarantee needs a statement-level BEFORE TRUNCATE trigger as well. The existing
-- prevent_audit_log_modification() function raises unconditionally (it does not
-- branch on TG_OP), so it is reused here.

CREATE OR REPLACE FUNCTION prevent_audit_log_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'AuditLog is append-only. UPDATE, DELETE and TRUNCATE operations are strictly forbidden. (operation: %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_audit_log_truncate ON audit_logs;

CREATE TRIGGER trg_prevent_audit_log_truncate
BEFORE TRUNCATE ON audit_logs
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_audit_log_modification();
