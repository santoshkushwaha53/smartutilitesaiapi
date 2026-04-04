// routes/topups.route.js
import { Router } from 'express';
import { query } from '../src/db.js';

const router = Router();

/**
 * GET /api/topups
 * Frontend endpoint
 *
 * Query params:
 *   country_code=IN
 *   currency_code=INR
 *   region_band=global
 */
router.get('/', async (req, res) => {
  try {
    const { country_code, currency_code, region_band } = req.query;

    const params = [];
    const where = [];

    // Country + global fallback
    if (country_code) {
      params.push(country_code);
      where.push(`(country_code = $${params.length} OR country_code IS NULL)`);
    }

    if (currency_code) {
      params.push(currency_code);
      where.push(`currency_code = $${params.length}`);
    }

    if (region_band) {
      params.push(region_band);
      where.push(`region_band = $${params.length}`);
    }

    const sql = `
      SELECT
        id,
        pack_code,
        display_name,
        tagline,
        region_band,
        country_code,
        currency_code,
        local_price,
        base_price_usd,
        points_amount,
        sort_order
      FROM public.astro_topup_pack
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY
        CASE WHEN country_code IS NULL THEN 2 ELSE 1 END,
        COALESCE(sort_order, 999999),
        id;
    `;

    const r = await query(sql, params);

    res.set('Cache-Control', 'no-store'); // avoid 304 during dev
    res.json({ ok: true, items: r.rows });
  } catch (e) {
    console.error('[GET /api/topups]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
