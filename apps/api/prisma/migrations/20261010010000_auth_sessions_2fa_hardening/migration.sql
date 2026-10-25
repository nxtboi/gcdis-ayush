-- Phase 2 Security Hardening: Sessions familyId, user/session isActive flags, and 2FA replay protection step

-- AlterTable users
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable two_factors
ALTER TABLE "two_factors" ADD COLUMN IF NOT EXISTS "lastUsedStep" INTEGER;

-- AlterTable sessions
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "familyId" TEXT;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sessions_familyId_idx" ON "sessions"("familyId");
