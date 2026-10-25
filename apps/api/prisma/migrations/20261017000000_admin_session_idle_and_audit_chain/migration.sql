-- Staff console hardening (additive only; no existing row is modified).
--
-- 1. Staff session idle timeout and server-side revocation reasons
--    lastSeenAt: last authenticated API activity of a staff session (written at most once a minute).
--    revokedReason: IDLE_TIMEOUT / SESSION_LIMIT when the server revoked the session (null otherwise).
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "lastSeenAt" TIMESTAMP(3);
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "revokedReason" VARCHAR(32);

-- 2. Audit log tamper-evidence hash chain (apps/api/src/audit/audit-chain.ts)
--    Each new row stores its position (chainSeq), the previous row's hash (prevHash) and
--    rowHash = sha256(prevHash + canonical row JSON). Appends are serialised with a transaction-level
--    advisory lock; the unique index on chainSeq is the last line of defence against a forked chain.
--    Rows written before this migration keep NULL values and are reported as "legacy" by the verifier.
--    The append-only triggers (UPDATE / DELETE / TRUNCATE blocked) are unchanged.
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "chainSeq" INTEGER;
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "prevHash" VARCHAR(64);
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "rowHash" VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS "audit_logs_chainSeq_key" ON "audit_logs"("chainSeq");
