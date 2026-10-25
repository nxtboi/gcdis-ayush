-- Data / performance hardening:
--  * upload ownership & visibility (media_assets.purpose / isPublic) so unlinked private uploads
--    (e.g. ID proofs) are never served publicly;
--  * indexes for exact-equality file lookups and FK / hot-path columns;
--  * one registration per (team, category).

-- AlterTable
ALTER TABLE "media_assets" ADD COLUMN     "isPublic" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "purpose" TEXT;

-- Backfill: keep legacy public site media public so existing pages do not break. A legacy asset
-- is public only if it is an image/video, is NOT linked to a registration document or a team
-- member ID proof, and was either uploaded by an administrator or is referenced as a team /
-- sponsor logo. Everything else (documents, ID proofs, unknown) becomes private.
UPDATE "media_assets" ma
SET "isPublic" = true
WHERE (ma."mimeType" LIKE 'image/%' OR ma."mimeType" LIKE 'video/%')
  AND NOT EXISTS (SELECT 1 FROM "documents" d WHERE d."fileUrl" = ma."fileUrl")
  AND NOT EXISTS (SELECT 1 FROM "team_members" tm WHERE tm."idProofUrl" = ma."fileUrl")
  AND (
    EXISTS (SELECT 1 FROM "users" u WHERE u."id" = ma."uploadedBy" AND u."role" IN ('SUPER_ADMIN', 'EVENT_ADMIN'))
    OR EXISTS (SELECT 1 FROM "teams" t WHERE t."logoUrl" = ma."fileUrl")
    OR EXISTS (SELECT 1 FROM "sponsors" s WHERE s."logoUrl" = ma."fileUrl")
  );

-- CreateIndex
CREATE INDEX "media_assets_fileUrl_idx" ON "media_assets"("fileUrl");

-- CreateIndex
CREATE INDEX "media_assets_uploadedBy_idx" ON "media_assets"("uploadedBy");

-- CreateIndex
CREATE INDEX "team_members_teamId_idx" ON "team_members"("teamId");

-- CreateIndex
CREATE INDEX "team_members_userId_idx" ON "team_members"("userId");

-- CreateIndex
CREATE INDEX "team_members_idProofUrl_idx" ON "team_members"("idProofUrl");

-- CreateIndex
-- NOTE: fails if duplicate (teamId, categoryId) registrations already exist; de-duplicate first.
CREATE UNIQUE INDEX "registrations_teamId_categoryId_key" ON "registrations"("teamId", "categoryId");

-- CreateIndex
CREATE INDEX "documents_fileUrl_idx" ON "documents"("fileUrl");

-- CreateIndex
CREATE INDEX "technical_inspections_registrationId_idx" ON "technical_inspections"("registrationId");

-- CreateIndex
CREATE INDEX "match_events_fixtureId_timestamp_idx" ON "match_events"("fixtureId", "timestamp");

-- CreateIndex
CREATE INDEX "certificates_registrationId_idx" ON "certificates"("registrationId");

-- Previously created at runtime by the payments / registrations services (runtime DDL removed).
-- IF NOT EXISTS keeps this safe on databases where the services already created them.
-- At most one PENDING payment per registration (fails if duplicates exist; resolve them first).
CREATE UNIQUE INDEX IF NOT EXISTS "idx_payments_one_pending_per_registration" ON "payments" ("registrationId") WHERE "status" = 'PENDING';

-- Sequence backing human-readable registration codes.
CREATE SEQUENCE IF NOT EXISTS "registration_code_seq" START WITH 1 INCREMENT BY 1;
