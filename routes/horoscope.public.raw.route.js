import express from "express";
import pool from "../src/db.js";
import { requireAuth } from "../src/middleware/auth.js";  // ⬅ add this

const router = express.Router();

const PERIOD_ALIAS = {
  today: "today", today: "today",
  yesterday: "yesterday", tomorrow: "tomorrow",
  weekly: "weekly", monthly: "monthly", yearly: "yearly",
};
const normPeriod = (p) => PERIOD_ALIAS[String(p||"").toLowerCase()] || null;

// keep ping public (optional)
router.get("/_ping", (_req, res) => {
  return res.json({ ok: true, where: "public.horoscope.raw" });
});

/**
 * GET /api/public/horoscope/raw?period=today&system=western&lang=en
 * Now protected by JWT: requireAuth
 */
router.get("/horoscope/raw", requireAuth, async (req, res) => {
  try {
    const period = normPeriod(req.query.period);
    const lang   = String(req.query.lang   || "en").toLowerCase();
    const system = String(req.query.system || "western").toLowerCase();

    if (!period) {
      return res.status(400).json({
        ok: false,
        error: "period required: yesterday|today|tomorrow|weekly|monthly|yearly"
      });
    }

    const sql = `
      SELECT raw_event_id, period, lang, system, updated_at,
             "text"::text AS payload_text
        FROM public.astro_prediction
       WHERE LOWER(period) = $1
         AND LOWER(lang)   = $2
         AND LOWER(system) = $3
       ORDER BY updated_at DESC
       LIMIT 1
    `;
    const { rows } = await pool.query(sql, [period, lang, system]);

    if (!rows.length) {
      return res.status(404).json({
        ok: false,
        error: "No prediction found for requested period/lang/system."
      });
    }

    const r = rows[0];
    if (r.payload_text == null) {
      return res.status(500).json({
        ok: false,
        error: 'Row found but "text" was NULL. Check data ingestion.'
      });
    }

    return res.json({
      ok: true,
      meta: {
        period: r.period,
        lang: r.lang,
        system: r.system,
        source_id: r.raw_event_id,
        updated_at: r.updated_at,
        content_type: "application/json"
      },
      payload_text: r.payload_text
    });
  } catch (e) {
    console.error("[/api/public/horoscope/raw ERROR]", e);
    return res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});

// Optional JSON 404 for any other /api/public/* path
router.use((req, res) => {
  return res.status(404).json({ ok:false, error:"Not Found", path: req.originalUrl });
});

export default router;
