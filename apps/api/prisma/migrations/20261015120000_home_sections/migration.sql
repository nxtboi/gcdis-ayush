-- Home page sections managed from the staff console (enable flag, order and JSON content per section).
-- Rows are created by prisma/seed.ts (create-only) or on the first save; the API falls back to the
-- bundled defaults for any section without a row.

-- CreateTable
CREATE TABLE IF NOT EXISTS "home_sections" (
    "key" VARCHAR(64) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "content" JSONB NOT NULL,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "home_sections_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "home_sections_enabled_sortOrder_idx" ON "home_sections"("enabled", "sortOrder");
