-- Site content (sponsors, gallery) and admin step-up re-authentication

-- AlterTable sessions: step-up window and last refresh time
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "stepUpAt" TIMESTAMP(3);
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "lastUsedAt" TIMESTAMP(3);

-- AlterTable sponsors: description, placements, active flag and timestamps
ALTER TABLE "sponsors" ADD COLUMN IF NOT EXISTS "description" TEXT;
ALTER TABLE "sponsors" ADD COLUMN IF NOT EXISTS "placements" TEXT[] NOT NULL DEFAULT ARRAY['HOME', 'EVENT', 'FOOTER']::TEXT[];
ALTER TABLE "sponsors" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "sponsors" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
-- updatedAt is maintained by Prisma (@updatedAt): backfill existing rows, then drop the default
ALTER TABLE "sponsors" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "sponsors" ALTER COLUMN "updatedAt" DROP DEFAULT;

CREATE INDEX IF NOT EXISTS "sponsors_isActive_displayOrder_idx" ON "sponsors"("isActive", "displayOrder");

-- CreateTable gallery_images
CREATE TABLE IF NOT EXISTS "gallery_images" (
    "id" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "caption" TEXT,
    "altText" TEXT NOT NULL,
    "category" TEXT,
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "width" INTEGER,
    "height" INTEGER,
    "uploadedBy" TEXT,
    "mediaAssetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gallery_images_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "gallery_images_isPublished_displayOrder_idx" ON "gallery_images"("isPublished", "displayOrder");
CREATE INDEX IF NOT EXISTS "gallery_images_imageUrl_idx" ON "gallery_images"("imageUrl");
