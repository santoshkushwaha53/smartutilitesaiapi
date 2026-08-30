/**
 * Kids Zone API  —  /api/kids
 */
const { Router } = require('express');
const prisma = require('../../../lib/prisma');

const router = Router();

// ── helpers ──────────────────────────────────────────────────────────────────

function parseJson(str, fallback) {
  if (!str) return fallback;
  if (typeof str !== 'string') return str;
  try { return JSON.parse(str); } catch { return fallback; }
}

function toClient(row, full = false) {
  const content = parseJson(row.content, {});
  return {
    id:           row.id,
    slug:         row.slug,
    type:         row.type,
    title:        row.title,
    emoji:        row.emoji,
    summary:      row.summary,
    festivalSlugs: parseJson(row.festivalSlugs, []),
    ageGroup:     parseJson(row.ageGroup, []),
    featured:     row.featured,
    isActive:     row.isActive,
    sortOrder:    row.sortOrder,
    content:      full ? content : {},
    createdAt:    row.createdAt,
    updatedAt:    row.updatedAt,
  };
}

// ── GET /api/kids  — list (summary, paginated) ────────────────────────────────
router.get('/', async (req, res) => {
    const {
    type, featured, isActive = 'true',
    page = '0', limit = '50',
    festival, q,
  } = req.query;

  const where = {};
  if (type)     where.type     = type;
  if (featured === 'true')  where.featured = true;
  if (isActive !== 'all')   where.isActive = isActive === 'true';
  if (festival) where.festivalSlugs = { contains: festival };
  if (q)        where.OR = [
    { title:   { contains: q, mode: 'insensitive' } },
    { summary: { contains: q, mode: 'insensitive' } },
  ];

  const skip = Number(page) * Number(limit);
  const [rows, total] = await Promise.all([
    prisma.kidsContent.findMany({ where, skip, take: Number(limit), orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }] }),
    prisma.kidsContent.count({ where }),
  ]);

  res.json({ items: rows.map(r => toClient(r)), total, page: Number(page), limit: Number(limit) });
});

// ── GET /api/kids/by-type  — grouped counts ───────────────────────────────────
router.get('/by-type', async (req, res) => {
    const rows = await prisma.kidsContent.groupBy({
    by: ['type'],
    _count: { id: true },
    where: { isActive: true },
  });
  const result = {};
  rows.forEach(r => { result[r.type] = r._count.id; });
  res.json(result);
});

// ── GET /api/kids/:id  — full detail ─────────────────────────────────────────
router.get('/:id', async (req, res) => {
    const row = await prisma.kidsContent.findUnique({ where: { id: req.params.id } })
           || await prisma.kidsContent.findUnique({ where: { slug: req.params.id } });
  if (!row) return res.status(404).json({ message: 'Not found' });
  res.json(toClient(row, true));
});

// ── POST /api/kids  — create ──────────────────────────────────────────────────
router.post('/', async (req, res) => {
    const b = req.body;
  if (!b.title || !b.type) return res.status(400).json({ message: 'title and type are required' });

  const slug = b.slug || b.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now();
  const id   = b.id || `${b.type}-${Date.now()}`;

  const row = await prisma.kidsContent.upsert({
    where: { slug },
    create: buildData(b, id, slug),
    update: buildData(b, id, slug),
  });
  res.status(201).json(toClient(row, true));
});

// ── PUT /api/kids/:id  — update ───────────────────────────────────────────────
router.put('/:id', async (req, res) => {
    const existing = await prisma.kidsContent.findUnique({ where: { id: req.params.id } })
                || await prisma.kidsContent.findUnique({ where: { slug: req.params.id } });
  if (!existing) return res.status(404).json({ message: 'Not found' });

  const row = await prisma.kidsContent.update({
    where: { id: existing.id },
    data: buildData(req.body, existing.id, existing.slug),
  });
  res.json(toClient(row, true));
});

// ── DELETE /api/kids/:id ──────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
    const existing = await prisma.kidsContent.findUnique({ where: { id: req.params.id } })
                || await prisma.kidsContent.findUnique({ where: { slug: req.params.id } });
  if (!existing) return res.status(404).json({ message: 'Not found' });
  await prisma.kidsContent.delete({ where: { id: existing.id } });
  res.json({ ok: true });
});

// ── helpers ───────────────────────────────────────────────────────────────────

function buildData(b, id, slug) {
  return {
    id,
    slug,
    type:          b.type,
    title:         b.title,
    emoji:         b.emoji || '🎉',
    summary:       b.summary || null,
    festivalSlugs: JSON.stringify(b.festivalSlugs || []),
    ageGroup:      JSON.stringify(b.ageGroup      || []),
    featured:      b.featured  ?? false,
    isActive:      b.isActive  ?? true,
    sortOrder:     Number(b.sortOrder || 0),
    content:       JSON.stringify(b.content || {}),
  };
}

module.exports = router;
