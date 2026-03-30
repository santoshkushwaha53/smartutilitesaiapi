const express = require('express');
const multer  = require('multer');
const { parse } = require('csv-parse/sync');
const prisma  = require('../../../lib/prisma');
const auth    = require('../../../middleware/auth.middleware');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ─── Parse helpers ────────────────────────────────────────────────────────────
function parseCsvRows(buffer) {
  return parse(buffer, { columns: true, skip_empty_lines: true, trim: true });
}

function safeJson(v, fallback = []) {
  if (!v) return fallback;
  if (Array.isArray(v)) return v;
  try { return JSON.parse(v); } catch { return String(v).split(',').map(s => s.trim()).filter(Boolean); }
}

// ─── POST /api/import/preview  (validate without saving) ─────────────────────
router.post('/preview', auth, upload.single('file'), async (req, res) => {
  const type = req.body.type; // 'festivals' | 'holidays' | 'states'
  if (!type) return res.status(400).json({ message: 'type is required' });

  let rows = [];
  if (req.file) {
    const ext = (req.file.originalname || '').split('.').pop().toLowerCase();
    if (ext === 'csv') {
      rows = parseCsvRows(req.file.buffer);
    } else {
      try { const p = JSON.parse(req.file.buffer.toString()); rows = Array.isArray(p) ? p : (p.holidays || p.festivals || p.states || p.data || []); }
      catch { return res.status(400).json({ message: 'Invalid JSON file' }); }
    }
  } else if (req.body.data) {
    try { rows = JSON.parse(req.body.data); }
    catch { return res.status(400).json({ message: 'Invalid JSON data' }); }
  } else {
    return res.status(400).json({ message: 'No file or data provided' });
  }

  res.json({ type, count: rows.length, preview: rows.slice(0, 5), columns: rows[0] ? Object.keys(rows[0]) : [] });
});

// ─── POST /api/import/festivals ──────────────────────────────────────────────
router.post('/festivals', auth, upload.single('file'), async (req, res) => {
  let rows = [];
  if (req.file) {
    const ext = (req.file.originalname || '').split('.').pop().toLowerCase();
    rows = ext === 'csv' ? parseCsvRows(req.file.buffer)
         : (() => { const p = JSON.parse(req.file.buffer.toString()); return Array.isArray(p) ? p : (p.festivals || p.data || []); })();
  } else if (req.body.data) {
    rows = JSON.parse(req.body.data);
  }

  if (!rows.length) return res.status(400).json({ message: 'No data to import' });

  let created = 0, updated = 0, errors = [];

  for (const r of rows) {
    try {
      const id = r.id || r.slug || `${(r.name || '').toLowerCase().replace(/\s+/g, '-')}-import`;
      const data = {
        name:             r.name || 'Unknown',
        alternateName:    r.alternateName || r.alternate_name || null,
        type:             r.type || 'cultural',
        month:            Number(r.month) || 1,
        day:              Number(r.day || r.date) || 0,
        shortDesc:        r.shortDesc || r.short_desc || r.description || null,
        description:      r.description || null,
        heroEmoji:        r.heroEmoji || r.hero_emoji || '',
        colorTone:        r.colorTone || r.color_tone || '',
        calendarType:     r.calendarType || null,
        dateLabel:        r.dateLabel || null,
        sortOrder:        Number(r.sortOrder || r.sort_order) || 0,
        isActive:         r.isActive !== 'false' && r.isActive !== false,
        heroImage:        r.heroImage || r.hero_image || null,
        images:           JSON.stringify(safeJson(r.images)),
        regions:          JSON.stringify(safeJson(r.regions)),
        statesCelebrated: JSON.stringify(safeJson(r.statesCelebrated || r.states_celebrated)),
        tags:             JSON.stringify(safeJson(r.tags)),
        significance:     JSON.stringify(safeJson(r.significance)),
        whyCelebrate:     JSON.stringify(safeJson(r.whyCelebrate || r.why_celebrate)),
        howToCelebrate:   JSON.stringify(safeJson(r.howToCelebrate || r.how_to_celebrate)),
        rituals:          JSON.stringify(safeJson(r.rituals)),
        foods:            JSON.stringify(safeJson(r.foods)),
        wishes:           JSON.stringify(safeJson(r.wishes)),
        timeline:         JSON.stringify(safeJson(r.timeline)),
        faq:              JSON.stringify(safeJson(r.faq)),
        cardTheme:        typeof r.cardTheme === 'object' ? JSON.stringify(r.cardTheme) : (r.cardTheme || '{}'),
        seoTitle:         r.seoTitle || r.seo_title || null,
        seoDescription:   r.seoDescription || r.seo_description || null,
        seoKeywords:      JSON.stringify(safeJson(r.seoKeywords || r.seo_keywords)),
      };

      const existing = await prisma.festival.findUnique({ where: { id } });
      if (existing) {
        await prisma.festival.update({ where: { id }, data: { ...data, updatedAt: new Date() } });
        updated++;
      } else {
        await prisma.festival.create({ data: { id, ...data } });
        created++;
      }
    } catch (e) {
      errors.push({ row: r.name || r.id, error: e.message });
    }
  }

  res.json({ message: 'Import complete', created, updated, errors, total: rows.length });
});

// ─── POST /api/import/holidays ───────────────────────────────────────────────
router.post('/holidays', auth, upload.single('file'), async (req, res) => {
  let rows = [];
  if (req.file) {
    const ext = (req.file.originalname || '').split('.').pop().toLowerCase();
    rows = ext === 'csv' ? parseCsvRows(req.file.buffer)
         : (() => { const p = JSON.parse(req.file.buffer.toString()); return Array.isArray(p) ? p : (p.holidays || p.data || []); })();
  } else if (req.body.data) {
    rows = JSON.parse(req.body.data);
  }

  if (!rows.length) return res.status(400).json({ message: 'No data to import' });

  let created = 0, updated = 0, errors = [];

  for (const r of rows) {
    try {
      const date  = r.date || r.Date || '';
      const year  = Number(r.year || r.Year || (date ? date.substring(0, 4) : new Date().getFullYear()));
      const title = r.title || r.Title || r.name || 'Unknown';
      const type  = (r.type || r.Type || 'national').toLowerCase();
      const states = safeJson(r.states || r.States || r.state || []);
      const id    = r.id || `${title.toLowerCase().replace(/\s+/g, '-')}-${type}-${year}-import`;

      const data = {
        title,
        date:        date,
        year,
        type,
        states:      JSON.stringify(states),
        description: r.description || r.Description || null,
        holidayType: r.holidayType || r.holiday_type || 'gazetted',
      };

      const existing = await prisma.holiday.findUnique({ where: { id } });
      if (existing) {
        await prisma.holiday.update({ where: { id }, data: { ...data, updatedAt: new Date() } });
        updated++;
      } else {
        await prisma.holiday.create({ data: { id, ...data } });
        created++;
      }
    } catch (e) {
      errors.push({ row: r.title || r.id, error: e.message });
    }
  }

  res.json({ message: 'Import complete', created, updated, errors, total: rows.length });
});

// ─── POST /api/import/states ──────────────────────────────────────────────────
router.post('/states', auth, upload.single('file'), async (req, res) => {
  let rows = [];
  if (req.file) {
    const ext = (req.file.originalname || '').split('.').pop().toLowerCase();
    rows = ext === 'csv' ? parseCsvRows(req.file.buffer)
         : (() => { const p = JSON.parse(req.file.buffer.toString()); return Array.isArray(p) ? p : (p.states || p.data || []); })();
  } else if (req.body.data) {
    rows = JSON.parse(req.body.data);
  }

  if (!rows.length) return res.status(400).json({ message: 'No data to import' });

  let created = 0, updated = 0, errors = [];

  for (const r of rows) {
    try {
      const code = (r.code || r.Code || '').toUpperCase();
      if (!code) { errors.push({ row: r.name, error: 'code is required' }); continue; }
      const data = {
        name:  r.name  || r.Name  || code,
        emoji: r.emoji || r.Emoji || '',
        tone:  r.tone  || r.Tone  || 'warm',
        type:  r.type  || r.Type  || 'state',
      };
      await prisma.state.upsert({ where: { code }, update: { ...data, updatedAt: new Date() }, create: { code, ...data } });
      created++;
    } catch (e) {
      errors.push({ row: r.code || r.name, error: e.message });
    }
  }

  res.json({ message: 'Import complete', created, updated, errors, total: rows.length });
});

module.exports = router;
