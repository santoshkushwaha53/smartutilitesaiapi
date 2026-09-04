-- AlterTable BlogPost — Explore / IndiaPublicHolidays CMS fields
ALTER TABLE "BlogPost" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'published';
ALTER TABLE "BlogPost" ADD COLUMN IF NOT EXISTS "trending" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "BlogPost" ADD COLUMN IF NOT EXISTS "contentType" TEXT NOT NULL DEFAULT 'article';
ALTER TABLE "BlogPost" ADD COLUMN IF NOT EXISTS "featuredImage" TEXT;
ALTER TABLE "BlogPost" ADD COLUMN IF NOT EXISTS "thumbnailImage" TEXT;
ALTER TABLE "BlogPost" ADD COLUMN IF NOT EXISTS "ogTitle" TEXT NOT NULL DEFAULT '';
ALTER TABLE "BlogPost" ADD COLUMN IF NOT EXISTS "ogDescription" TEXT NOT NULL DEFAULT '';
ALTER TABLE "BlogPost" ADD COLUMN IF NOT EXISTS "ogImage" TEXT;
ALTER TABLE "BlogPost" ADD COLUMN IF NOT EXISTS "canonicalUrl" TEXT;
ALTER TABLE "BlogPost" ADD COLUMN IF NOT EXISTS "viewCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BlogPost" ADD COLUMN IF NOT EXISTS "holidayIds" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "BlogPost" ADD COLUMN IF NOT EXISTS "festivalIds" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "BlogPost" ADD COLUMN IF NOT EXISTS "stateCodes" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "BlogPost" ADD COLUMN IF NOT EXISTS "relatedPostIds" JSONB NOT NULL DEFAULT '[]';

-- Align status with legacy published flag for existing rows
UPDATE "BlogPost"
SET "status" = CASE WHEN "published" = true THEN 'published' ELSE 'draft' END;

CREATE INDEX IF NOT EXISTS "BlogPost_siteId_status_idx" ON "BlogPost"("siteId", "status");
CREATE INDEX IF NOT EXISTS "BlogPost_siteId_trending_idx" ON "BlogPost"("siteId", "trending");
CREATE INDEX IF NOT EXISTS "BlogPost_siteId_contentType_idx" ON "BlogPost"("siteId", "contentType");
