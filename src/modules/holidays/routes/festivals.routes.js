const express = require('express');
const prisma  = require('../../../lib/prisma');
const auth    = require('../../../middleware/auth.middleware');

const router = express.Router();

// ─── JSON helpers ────────────────────────────────────────────────────────────
const toJson  = (v, fallback = '[]') => v !== undefined ? JSON.stringify(v) : fallback;
const fromJson = (v, fallback = []) => { try { return JSON.parse(v || JSON.stringify(fallback)); } catch { return fallback; } };

// ─── GET /api/festivals ──────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const where = {};
  if (req.query.type)   where.type     = req.query.type;
  if (req.query.month)  where.month    = Number(req.query.month);
  if (req.query.active !== 'false') where.isActive = true;

  const rows = await prisma.festival.findMany({
    where,
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
  res.json(rows.map(r => toClient(r, false)));
});

// ─── GET /api/festivals/:id ──────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const row = await prisma.festival.findUnique({ where: { id: req.params.id } });
  if (!row) return res.status(404).json({ message: 'Festival not found' });
  res.json(toClient(row, true));
});

// ─── POST /api/festivals ─────────────────────────────────────────────────────
router.post('/', auth, async (req, res) => {
  const b = req.body;
  if (!b.name || !b.type || !b.month)
    return res.status(400).json({ message: 'name, type and month are required' });

  const id = b.id || `${b.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')}-${Date.now()}`;

  const row = await prisma.festival.create({ data: buildData(id, b) });
  res.status(201).json(toClient(row, true));
});

// ─── PUT /api/festivals/:id ──────────────────────────────────────────────────
router.put('/:id', auth, async (req, res) => {
  const b = req.body;
  const existing = await prisma.festival.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ message: 'Festival not found' });

  const row = await prisma.festival.update({
    where: { id: req.params.id },
    data: { ...buildData(req.params.id, b, existing), updatedAt: new Date() },
  });
  res.json(toClient(row, true));
});

// ─── DELETE /api/festivals/:id ───────────────────────────────────────────────
router.delete('/:id', auth, async (req, res) => {
  await prisma.festival.delete({ where: { id: req.params.id } });
  res.json({ message: 'Deleted' });
});

// ─── Build prisma data object ─────────────────────────────────────────────────
function buildData(id, b, existing = {}) {
  const str  = (k, def = null) => b[k] !== undefined ? b[k] : (existing[k] ?? def);
  const num  = (k, def = 0)    => b[k] !== undefined ? Number(b[k]) : (existing[k] ?? def);
  const bool = (k, def = true) => b[k] !== undefined ? Boolean(b[k]) : (existing[k] ?? def);
  const arr  = (k, def = [])   => b[k] !== undefined ? JSON.stringify(b[k]) : (existing[k] ?? JSON.stringify(def));
  const obj  = (k, def = {})   => b[k] !== undefined ? JSON.stringify(b[k]) : (existing[k] ?? JSON.stringify(def));

  return {
    id,
    name:             str('name'),
    alternateName:    str('alternateName'),
    type:             str('type', 'cultural'),
    month:            num('month', 1),
    day:              num('day', 0),
    shortDesc:        str('shortDesc'),
    description:      str('description'),
    significance:     arr('significance'),
    heroEmoji:        str('heroEmoji', ''),
    colorTone:        str('colorTone', ''),
    calendarType:     str('calendarType'),
    dateLabel:        str('dateLabel'),
    sortOrder:        num('sortOrder', 0),
    isActive:         bool('isActive', true),
    heroImage:        str('heroImage'),
    images:           arr('images'),
    regions:          arr('regions'),
    statesCelebrated: arr('statesCelebrated'),
    tags:             arr('tags'),
    whyCelebrate:     arr('whyCelebrate'),
    howToCelebrate:   arr('howToCelebrate'),
    rituals:          arr('rituals'),
    foods:            arr('foods'),
    wishes:           arr('wishes'),
    timeline:         arr('timeline'),
    faq:              arr('faq'),
    cardTheme:        obj('cardTheme'),
    seoTitle:         str('seoTitle'),
    seoDescription:   str('seoDescription'),
    seoKeywords:      arr('seoKeywords'),
  };
}

// ─── Convert DB row → API response ──────────────────────────────────────────
function toClient(row, full = false) {
  const base = {
    id:               row.id,
    name:             row.name,
    alternateName:    row.alternateName,
    type:             row.type,
    month:            row.month,
    day:              row.day,
    shortDesc:        row.shortDesc,
    description:      row.description,
    heroEmoji:        row.heroEmoji,
    colorTone:        row.colorTone,
    calendarType:     row.calendarType,
    dateLabel:        row.dateLabel,
    sortOrder:        row.sortOrder,
    isActive:         row.isActive,
    heroImage:        row.heroImage,
    statesCelebrated: fromJson(row.statesCelebrated),
    regions:          fromJson(row.regions),
    tags:             fromJson(row.tags),
    updatedAt:        row.updatedAt,
  };

  if (!full) return base;

  return {
    ...base,
    significance:  fromJson(row.significance, []),
    images:        fromJson(row.images),
    whyCelebrate:  fromJson(row.whyCelebrate),
    howToCelebrate:fromJson(row.howToCelebrate),
    rituals:       fromJson(row.rituals),
    foods:         fromJson(row.foods),
    wishes:        fromJson(row.wishes),
    timeline:      fromJson(row.timeline),
    faq:           fromJson(row.faq),
    cardTheme:     fromJson(row.cardTheme, {}),
    seoTitle:      row.seoTitle,
    seoDescription:row.seoDescription,
    seoKeywords:   fromJson(row.seoKeywords),
  };
}

module.exports = router;
