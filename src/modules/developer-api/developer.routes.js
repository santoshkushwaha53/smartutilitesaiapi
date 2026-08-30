const express = require('express');
const crypto = require('crypto');
const prisma = require('../../lib/prisma');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function generateKey() {
  return `iph_live_${crypto.randomBytes(24).toString('hex')}`;
}

function toClient(record) {
  return {
    apiKey: record.key,
    name: record.name,
    email: record.email,
    rateLimitPerDay: record.rateLimitPerDay,
    createdAt: record.createdAt,
  };
}

// POST /api/developer/signup  { name, email }
// One key per email — resubmitting the same email returns the existing key
// rather than erroring, so a developer who lost their key can just sign up
// again instead of needing account recovery.
router.post('/signup', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();

  if (!name || name.length < 2) return res.status(400).json({ message: 'A project/app name is required.' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ message: 'A valid email is required.' });

  const existing = await prisma.apiKey.findUnique({ where: { email } });
  if (existing) return res.json(toClient(existing));

  const record = await prisma.apiKey.create({
    data: { key: generateKey(), name, email },
  });
  res.status(201).json(toClient(record));
});

// GET /api/developer/usage?apiKey=...  — self-serve usage check, no header needed
router.get('/usage', async (req, res) => {
  const key = String(req.query.apiKey || '');
  if (!key) return res.status(400).json({ message: 'Pass ?apiKey=' });

  const record = await prisma.apiKey.findUnique({ where: { key } });
  if (!record) return res.status(404).json({ message: 'Unknown API key.' });

  res.json({
    name: record.name,
    isActive: record.isActive,
    rateLimitPerDay: record.rateLimitPerDay,
    usedToday: record.dailyCount,
    lifetimeRequests: record.requestCount.toString(),
    lastUsedAt: record.lastUsedAt,
  });
});

module.exports = router;
