// Auth + rate limiting for the public /api/v1/* developer endpoints.
// Distinct from the internal admin JWT auth — this is for external
// developers reading public holiday/festival/state data with a free API key.

const prisma = require('../../lib/prisma');

function isNewDay(resetAt, now) {
  return (
    resetAt.getUTCFullYear() !== now.getUTCFullYear() ||
    resetAt.getUTCMonth() !== now.getUTCMonth() ||
    resetAt.getUTCDate() !== now.getUTCDate()
  );
}

async function apiKeyAuth(req, res, next) {
  const key = req.header('X-API-Key') || req.query.apiKey;

  if (!key) {
    return res.status(401).json({
      error: 'missing_api_key',
      message: 'Send your API key in the X-API-Key header (or ?apiKey= query param). Get one at /developers.',
    });
  }

  const record = await prisma.apiKey.findUnique({ where: { key: String(key) } });

  if (!record || !record.isActive) {
    return res.status(401).json({ error: 'invalid_api_key', message: 'This API key is invalid or has been deactivated.' });
  }

  const now = new Date();
  let { dailyCount, dailyResetAt } = record;
  if (isNewDay(dailyResetAt, now)) {
    dailyCount = 0;
    dailyResetAt = now;
  }

  if (dailyCount >= record.rateLimitPerDay) {
    return res.status(429).json({
      error: 'rate_limit_exceeded',
      message: `Daily limit of ${record.rateLimitPerDay} requests reached. Resets at midnight UTC.`,
    });
  }

  await prisma.apiKey.update({
    where: { id: record.id },
    data: {
      dailyCount: dailyCount + 1,
      dailyResetAt,
      requestCount: { increment: 1 },
      lastUsedAt: now,
    },
  });

  req.apiKeyRecord = record;
  res.set('X-RateLimit-Limit', String(record.rateLimitPerDay));
  res.set('X-RateLimit-Remaining', String(Math.max(0, record.rateLimitPerDay - dailyCount - 1)));
  next();
}

module.exports = { apiKeyAuth };
