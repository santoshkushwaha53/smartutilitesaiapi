// routes/geo.js
import { Router } from 'express';
import { query } from '../src/db.js';

const router = Router();

/**
 * EXISTING: /api/geo/country-from-tz?tz=Asia/Kuala_Lumpur
 * (keep as-is)
 */
router.get('/country-from-tz', async (req, res) => {
  try {
    const tz = String(req.query.tz || '').trim();

    if (!tz) {
      return res.status(400).json({ error: 'tz (timezone) is required' });
    }

    const dbRes = await query(
      'SELECT GetCountryCodeFromTimezone($1) AS country_code',
      [tz]
    );

    const countryCode = dbRes.rows[0]?.country_code || null;

    res.json({
      timezone: tz,
      country_code: countryCode, // e.g. "MY"
      fallback: countryCode ? false : true
    });
  } catch (err) {
    console.error('country-from-tz error', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * NEW: /api/geo/countries?activeOnly=true&q=india&limit=50&offset=0
 * Returns list from mst_country for dropdown/fallback
 */
router.get('/countries', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const activeOnly = String(req.query.activeOnly || 'false') === 'true';

    const limitRaw = parseInt(String(req.query.limit || '250'), 10);
    const offsetRaw = parseInt(String(req.query.offset || '0'), 10);

    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 1000) : 250;
    const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;

    const sql = `
      SELECT
        country_id,
        iso2_code,
        iso3_code,
        numeric_code,
        country_name_en,
        native_name,
        primary_timezone,
        default_utc_offset_min,
        uses_dst,
        currency_code,
        currency_name,
        currency_symbol,
        phone_country_code,
        region_code,
        sub_region,
        is_active,
        flag_emoji,
        flag_asset_url
      FROM mst_country
      WHERE (
        $1::text IS NULL
        OR country_name_en ILIKE '%' || $1 || '%'
        OR iso2_code ILIKE $1 || '%'
        OR iso3_code ILIKE $1 || '%'
      )
      AND ($2::boolean IS FALSE OR is_active = TRUE)
      ORDER BY sort_order NULLS LAST, country_name_en ASC
      LIMIT $3 OFFSET $4
    `;

    const dbRes = await query(sql, [q || null, activeOnly, limit, offset]);

    res.json({
      ok: true,
      q: q || null,
      activeOnly,
      limit,
      offset,
      count: dbRes.rows.length,
      countries: dbRes.rows
    });
  } catch (err) {
    console.error('countries error', err);
    res.status(500).json({ ok: false, error: 'Failed to load countries' });
  }
});

/**
 * NEW: /api/geo/countries/IN
 * Lookup by ISO2
 */
router.get('/countries/:iso2', async (req, res) => {
  try {
    const iso2 = String(req.params.iso2 || '').trim().toUpperCase();
    if (!iso2 || iso2.length !== 2) {
      return res.status(400).json({ ok: false, error: 'iso2 must be 2 letters' });
    }

    const dbRes = await query(
      `SELECT * FROM mst_country WHERE UPPER(iso2_code) = $1 LIMIT 1`,
      [iso2]
    );

    const row = dbRes.rows?.[0];
    if (!row) return res.status(404).json({ ok: false, error: 'Country not found' });

    res.json({ ok: true, country: row });
  } catch (err) {
    console.error('country lookup error', err);
    res.status(500).json({ ok: false, error: 'Failed to load country' });
  }
});

export default router;
