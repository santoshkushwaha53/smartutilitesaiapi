// routes/admin.topups.route.js
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../src/db.js';

const router = Router();

// ⚠️ IMPORTANT: no requireAuth / requireAdmin here while you test
// If you had something like:
//   router.use(requireAuth, requireAdmin);
// or custom middleware that returns { error: 'no_token' }
// please REMOVE it for now.

// ---------- Zod schema ----------
const topupBaseSchema = z.object({
  pack_code: z.string().min(3).max(80),
  display_name: z.string().min(1).max(200),
  tagline: z.string().optional().nullable(),

  region_band: z.string().min(1).max(20),              // global / A / B / C
  country_code: z.string().max(4).optional().nullable(),
  currency_code: z.string().min(3).max(8),
  local_price: z.number().nonnegative(),
  base_price_usd: z.number().nonnegative(),

  points_amount: z.number().int().nonnegative(),
  sort_order: z.number().int().nonnegative().default(0),
  is_active: z.boolean().default(true),
    usage_label: z.string().max(200).optional().nullable(),
  benefits_text: z.string().max(2000).optional().nullable(),
  available_from: z.string().optional().nullable(), // ISO string or ''
  available_until: z.string().optional().nullable()
});

const createTopupSchema = topupBaseSchema;
const updateTopupSchema = topupBaseSchema.partial().extend({
  id: z.number().int().positive(),
});

function rowToTopup(row) {
  return {
    id: row.id,
    pack_code: row.pack_code,
    display_name: row.display_name,
    tagline: row.tagline,
    region_band: row.region_band,
    country_code: row.country_code,
    currency_code: row.currency_code,
    local_price: Number(row.local_price),
    base_price_usd: Number(row.base_price_usd),
    points_amount: row.points_amount,
    sort_order: row.sort_order,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
    usage_label: row.usage_label,
    benefits_text: row.benefits_text,
    available_from: row.available_from,
    available_until: row.available_until
  };
}

// GET /api/admin/topups
router.get('/admin/topups', async (_req, res) => {
  try {
    const sql = `
      SELECT *
      FROM astro_topup_pack
      ORDER BY sort_order, pack_code
    `;
    const result = await query(sql);
    res.json(result.rows.map(rowToTopup));
  } catch (e) {
    console.error('[TOPUPS] list error', e);
    res.status(500).json({ error: 'Failed to load top-up packs' });
  }
});

// POST /api/admin/topups
router.post('/admin/topups', async (req, res) => {
  try {
   

    const sql = `  INSERT INTO astro_topup_pack
    (pack_code, display_name, tagline,
     region_band, country_code, currency_code,
     local_price, base_price_usd,
     points_amount, sort_order, is_active,
     usage_label, benefits_text, available_from, available_until)
  VALUES
    ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
  RETURNING *

    `;
    const parsed = createTopupSchema.parse(req.body);

// helper: treat '' as null for dates/text
const toNullIfEmpty = (v) =>
  v === '' || v === undefined ? null : v;
    const params = [
      parsed.pack_code,
      parsed.display_name,
      parsed.tagline ?? null,
      parsed.region_band,
      parsed.country_code ?? null,
      parsed.currency_code,
      parsed.local_price,
      parsed.base_price_usd,
      parsed.points_amount,
      parsed.sort_order ?? 0,
      parsed.is_active ?? true,
       toNullIfEmpty(parsed.usage_label),
    toNullIfEmpty(parsed.benefits_text),
    toNullIfEmpty(parsed.available_from),
    toNullIfEmpty(parsed.available_until)
    ];

    const result = await query(sql, params);
    res.status(201).json(rowToTopup(result.rows[0]));
  } catch (e) {
    if (e instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid payload', details: e.errors });
    }
    console.error('[TOPUPS] create error', e);
    res.status(500).json({ error: 'Failed to create top-up pack' });
  }
});

// PUT /api/admin/topups/:id
router.put('/admin/topups/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid id' });
    }

    const parsed = updateTopupSchema.parse({ ...req.body, id });

    const sql = `
     UPDATE astro_topup_pack
  SET
    pack_code      = $1,
    display_name   = $2,
    tagline        = $3,
    region_band    = $4,
    country_code   = $5,
    currency_code  = $6,
    local_price    = $7,
    base_price_usd = $8,
    points_amount  = $9,
    sort_order     = $10,
    is_active      = $11,
    usage_label    = $12,
    benefits_text  = $13,
    available_from = $14,
    available_until= $15
  WHERE id = $16
  RETURNING *
    `;
    // same helper
const toNullIfEmpty = (v) =>
  v === '' || v === undefined ? null : v;

const params = [
  parsed.pack_code,
  parsed.display_name,
  parsed.tagline ?? null,
  parsed.region_band,
  parsed.country_code ?? null,
  parsed.currency_code,
  parsed.local_price,
  parsed.base_price_usd,
  parsed.points_amount,
  parsed.sort_order ?? 0,
  parsed.is_active ?? true,
  toNullIfEmpty(parsed.usage_label),
  toNullIfEmpty(parsed.benefits_text),
  toNullIfEmpty(parsed.available_from),
  toNullIfEmpty(parsed.available_until),
  parsed.id
];

    const result = await query(sql, params);
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Top-up pack not found' });
    }
    res.json(rowToTopup(result.rows[0]));
  } catch (e) {
    if (e instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid payload', details: e.errors });
    }
    console.error('[TOPUPS] update error', e);
    res.status(500).json({ error: 'Failed to update top-up pack' });
  }
});

export default router;
