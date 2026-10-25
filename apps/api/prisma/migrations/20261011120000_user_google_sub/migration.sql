-- Sign in with Google (Google Identity Services ID-token flow):
--  * users.googleSub stores the verified Google "sub" claim; unique so one Google account maps
--    to exactly one GCDIS user. Only TEAM_CAPTAIN accounts are ever linked (staff keep 2FA).
--  * users.authProvider records how the account was first created ("password" | "google").

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "authProvider" TEXT NOT NULL DEFAULT 'password',
ADD COLUMN     "googleSub" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "users_googleSub_key" ON "users"("googleSub");
