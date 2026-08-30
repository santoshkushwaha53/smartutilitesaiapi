-- Additive migration for the developer API portal. See
-- add-holiday-ingestion-tables.sql for why this project uses raw SQL
-- instead of `prisma db push` (this DB is shared with other services not
-- modeled in this schema).

CREATE TABLE IF NOT EXISTS "ApiKey" (
  "id"              TEXT NOT NULL PRIMARY KEY,
  "key"             TEXT NOT NULL,
  "name"            TEXT NOT NULL,
  "email"           TEXT NOT NULL,
  "isActive"        BOOLEAN NOT NULL DEFAULT true,
  "rateLimitPerDay" INTEGER NOT NULL DEFAULT 1000,
  "dailyCount"      INTEGER NOT NULL DEFAULT 0,
  "dailyResetAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "requestCount"    BIGINT NOT NULL DEFAULT 0,
  "lastUsedAt"      TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "ApiKey_key_key" ON "ApiKey" ("key");
CREATE UNIQUE INDEX IF NOT EXISTS "ApiKey_email_key" ON "ApiKey" ("email");
CREATE INDEX IF NOT EXISTS "ApiKey_isActive_idx" ON "ApiKey" ("isActive");
