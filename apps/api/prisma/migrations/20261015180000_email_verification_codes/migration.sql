-- Email verification by 6-digit code: wrong-attempt counter and the encrypted code (staff reveal)
ALTER TABLE "auth_tokens" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "auth_tokens" ADD COLUMN "codeCipher" TEXT;
