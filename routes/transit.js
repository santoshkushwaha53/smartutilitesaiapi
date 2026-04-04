// routes/transit.js
import { Router } from 'express';
import { query } from '../src/db.js';

const router = Router();

function toYmd(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function toIsoUtc(v) {
  if (!v) return null;
  try {
    // Works for "2026-01-03T22:07:56.554+08:00" and for JS Date
    return new Date(v).toISOString();
  } catch {
    return null;
  }
}

/**
 * GET /api/transit/daily?system=western&sign=5&tz=Asia/Kuala_Lumpur&purpose=transit
 *
 * Uses UTC day as the global anchor, and also returns the user's local day.
 * Optional: &at=2026-01-03T18:30:00Z (for testing day changes across timezones)
 */
router.get('/daily', async (req, res) => {
  try {
    const system = String(req.query.system || 'western').trim();
    const purpose = String(req.query.purpose || 'transit').trim();
    const userTz = String(req.query.tz || 'UTC').trim();

    const sign = parseInt(String(req.query.sign || ''), 10);
    if (!Number.isFinite(sign) || sign < 1 || sign > 12) {
      return res.status(400).json({ ok: false, error: 'sign must be an integer 1..12' });
    }

    // Optional test override. If invalid, ignore and fall back to now().
    const atRaw = String(req.query.at || '').trim();
    const atIso = atRaw && !Number.isNaN(Date.parse(atRaw)) ? atRaw : null;

    // ✅ Compute BOTH days from the SAME instant (one DB round-trip)
    // - anchor_ts is timestamptz (the single source of truth)
    // - utc_day / user_day are derived from that same anchor_ts
    const dayRes = await query(
      `
      WITH t AS (
        SELECT COALESCE($1::timestamptz, now()) AS anchor_ts
      )
      SELECT
        (anchor_ts AT TIME ZONE 'UTC')::date::text      AS utc_day,
        (anchor_ts AT TIME ZONE $2)::date::text         AS user_day,
        anchor_ts::text                                 AS anchor_ts
      FROM t
      `,
      [atIso, userTz]
    );

    const utcDay = dayRes.rows?.[0]?.utc_day;     // "YYYY-MM-DD"
    const userLocalDay = dayRes.rows?.[0]?.user_day; // "YYYY-MM-DD"
    const anchorTs = dayRes.rows?.[0]?.anchor_ts;

    if (!utcDay) {
      return res.status(500).json({ ok: false, error: 'Failed to compute UTC day' });
    }

    // ✅ DB call anchored to UTC day (global snapshot)
    const dbRes = await query(
      `SELECT public.astro_get_transit_by_sign_day_relaxed(
         $1::text,     -- system
         $2::int,      -- sign
         $3::date,     -- UTC day
         $4::text,     -- tz anchor
         $5::text      -- purpose
       ) AS data`,
      [system, sign, utcDay, 'UTC', purpose]
    );

    const payload =
      dbRes.rows?.[0]?.data || { meta: {}, houses: [], aspects: [], placements: [] };

    // ✅ Normalize calculatedAt -> calculatedAtUtc (NO breaking change)
    // Keep original calculatedAt as-is, add calculatedAtUtc beside it.
    const existingCalculatedAt = payload?.meta?.calculatedAt || null;

    // Keep any existing meta fields produced by DB, just enrich safely
    payload.meta = {
      ...(payload.meta || {}),

      system,
      purpose,
      userSignNumber: sign,

      // Global anchor
      tzAnchor: 'UTC',
      dayUtc: toYmd(utcDay),

      // User timezone view
      tzUser: userTz,
      dayUserLocal: toYmd(userLocalDay),

      // Helpful debugging (safe additions)
      anchorTs: anchorTs || null, // the exact instant used to compute both days
      calculatedAtUtc: toIsoUtc(existingCalculatedAt),
      referenceMode: 'global',
      referenceCoord: payload?.meta?.coordStrUsed || null
    };

    return res.json(payload);
  } catch (err) {
    console.error('transit/daily error', err);
    return res.status(500).json({
      ok: false,
      error: 'Internal error',
      detail: String(err?.message || err)
    });
  }
});

export default router;
