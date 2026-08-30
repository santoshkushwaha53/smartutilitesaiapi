-- Additive migration for the holiday auto-ingestion pipeline.
-- Uses CREATE TABLE IF NOT EXISTS only — this Postgres database is shared with
-- other services (metal_price_snapshots, api_provider_call_log, etc.) that are
-- NOT modeled in this repo's prisma/schema.prisma, so `prisma db push` cannot
-- be used here (it would try to drop those unrelated tables). Run this file
-- directly with psql/pg instead.

CREATE TABLE IF NOT EXISTS "HolidaySource" (
  "id"            TEXT NOT NULL PRIMARY KEY,
  "name"          TEXT NOT NULL,
  "scope"         TEXT NOT NULL,
  "stateCode"     TEXT,
  "url"           TEXT NOT NULL,
  "kind"          TEXT NOT NULL DEFAULT 'html',
  "parserKey"     TEXT NOT NULL DEFAULT 'generic',
  "isOfficial"    BOOLEAN NOT NULL DEFAULT true,
  "isActive"      BOOLEAN NOT NULL DEFAULT true,
  "lastCheckedAt" TIMESTAMP(3),
  "lastSuccessAt" TIMESTAMP(3),
  "lastError"     TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL
);

CREATE INDEX IF NOT EXISTS "HolidaySource_scope_idx" ON "HolidaySource" ("scope");
CREATE INDEX IF NOT EXISTS "HolidaySource_stateCode_idx" ON "HolidaySource" ("stateCode");
CREATE INDEX IF NOT EXISTS "HolidaySource_isActive_idx" ON "HolidaySource" ("isActive");

CREATE TABLE IF NOT EXISTS "HolidayCandidate" (
  "id"              TEXT NOT NULL PRIMARY KEY,
  "sourceId"        TEXT NOT NULL REFERENCES "HolidaySource"("id") ON DELETE CASCADE,
  "year"            INTEGER NOT NULL,
  "stateCode"       TEXT,
  "title"           TEXT NOT NULL,
  "date"            TEXT,
  "rawDateText"     TEXT,
  "type"            TEXT NOT NULL DEFAULT 'state',
  "holidayType"     TEXT NOT NULL DEFAULT 'gazetted',
  "confidence"      TEXT NOT NULL DEFAULT 'low',
  "rawExcerpt"      TEXT,
  "sourceUrl"       TEXT NOT NULL,
  "status"          TEXT NOT NULL DEFAULT 'pending',
  "duplicateOfId"   TEXT,
  "resultHolidayId" TEXT,
  "reviewedAt"      TIMESTAMP(3),
  "reviewedBy"      TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "HolidayCandidate_status_idx" ON "HolidayCandidate" ("status");
CREATE INDEX IF NOT EXISTS "HolidayCandidate_year_idx" ON "HolidayCandidate" ("year");
CREATE INDEX IF NOT EXISTS "HolidayCandidate_stateCode_idx" ON "HolidayCandidate" ("stateCode");
CREATE INDEX IF NOT EXISTS "HolidayCandidate_sourceId_idx" ON "HolidayCandidate" ("sourceId");

CREATE TABLE IF NOT EXISTS "IngestionRun" (
  "id"                  TEXT NOT NULL PRIMARY KEY,
  "startedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt"          TIMESTAMP(3),
  "status"              TEXT NOT NULL DEFAULT 'running',
  "triggeredBy"         TEXT NOT NULL DEFAULT 'manual',
  "sourcesChecked"      INTEGER NOT NULL DEFAULT 0,
  "sourcesFailed"       INTEGER NOT NULL DEFAULT 0,
  "candidatesFound"     INTEGER NOT NULL DEFAULT 0,
  "candidatesNew"       INTEGER NOT NULL DEFAULT 0,
  "candidatesDuplicate" INTEGER NOT NULL DEFAULT 0,
  "errors"              JSONB NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS "IngestionRun_status_idx" ON "IngestionRun" ("status");
CREATE INDEX IF NOT EXISTS "IngestionRun_startedAt_idx" ON "IngestionRun" ("startedAt");
