// Public, API-key-gated, versioned endpoints for external developers.
// Deliberately separate from the internal /api/holidays etc. used by the
// live frontend (which stay open, unversioned, and unkeyed) — versioning and
// auth here can evolve without ever risking the site that already depends on
// the internal shape.

const express = require('express');
const prisma = require('../../lib/prisma');

const router = express.Router();

function safeJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function paginate(req) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 100));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

function meta(page, pageSize, total) {
  return { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

// GET /api/v1/holidays?year=2026&state=MH&type=national
router.get('/holidays', async (req, res) => {
  const { year, state, type } = req.query;
  if (!year || !/^\d{4}$/.test(String(year))) {
    return res.status(400).json({ error: 'invalid_year', message: '?year=YYYY is required.' });
  }

  const where = { year: Number(year) };
  if (type) where.type = String(type);

  const { page, pageSize, skip, take } = paginate(req);
  const [rows, total] = await Promise.all([
    prisma.holiday.findMany({ where, orderBy: { date: 'asc' } }),
    prisma.holiday.count({ where }),
  ]);

  let filtered = rows;
  if (state && String(state).toUpperCase() !== 'ALL') {
    const code = String(state).toUpperCase();
    filtered = rows.filter((r) => {
      const states = safeJsonArray(r.states);
      return states.length === 0 || states.includes(code);
    });
  }

  const paged = filtered.slice(skip, skip + take);

  res.json({
    data: paged.map((r) => ({
      id: r.id,
      title: r.title,
      date: r.date,
      year: r.year,
      type: r.type,
      holidayType: r.holidayType,
      states: safeJsonArray(r.states),
      description: r.description,
    })),
    meta: meta(page, pageSize, state ? filtered.length : total),
  });
});

// GET /api/v1/festivals?month=10&type=religious
router.get('/festivals', async (req, res) => {
  const { month, type } = req.query;
  const where = { isActive: true };
  if (month) where.month = Number(month);
  if (type) where.type = String(type);

  const { page, pageSize, skip, take } = paginate(req);
  const [rows, total] = await Promise.all([
    prisma.festival.findMany({ where, orderBy: [{ month: 'asc' }, { day: 'asc' }], skip, take }),
    prisma.festival.count({ where }),
  ]);

  res.json({
    data: rows.map((f) => ({
      id: f.id,
      name: f.name,
      alternateName: f.alternateName,
      type: f.type,
      month: f.month,
      day: f.day,
      shortDesc: f.shortDesc,
      statesCelebrated: safeJsonArray(f.statesCelebrated),
      tags: safeJsonArray(f.tags),
    })),
    meta: meta(page, pageSize, total),
  });
});

// GET /api/v1/states
router.get('/states', async (_req, res) => {
  const rows = await prisma.state.findMany({ orderBy: { name: 'asc' } });
  res.json({
    data: rows.map((s) => ({ code: s.code, name: s.name, type: s.type })),
  });
});

module.exports = router;
