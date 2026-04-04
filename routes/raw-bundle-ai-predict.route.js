// routes/raw-bundle-ai-predict.route.js
import express from "express";
import { buildPredictionsFromRawBundles } from "../src/services/raw-bundle-ai-predict.service.js";

const router = express.Router();

/* ------------------------------
   UTC helpers (route-level)
------------------------------ */
function toYMDUTC(dt = new Date()) {
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function addDaysUTC(ymd, days) {
  const dt = new Date(`${ymd}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return toYMDUTC(dt);
}

/**
 * POST /api/astro/raw-ai/build
 *
 * Query:
 *  system=western&lang=en
 *  duration=daily|weekly|monthly|yearly|today|yesterday|tomorrow
 *  date=YYYY-MM-DD (for daily/today/yesterday/tomorrow)
 *  rangeStart=YYYY-MM-DD&rangeEnd=YYYY-MM-DD (for weekly/monthly/yearly)
 *  signId=1..12 (optional)
 *  limit=12 (optional, max 200)
 *  force=0|1 (optional)
 *
 * Optional:
 *  tone=mystical|balanced|practical
 *  expertId=sohum|oracle|maya
 *  audience_scope=sign
 */
router.post("/build", async (req, res) => {
  try {
    const system = (req.query.system || "western").toString();
    const lang = (req.query.lang || "en").toString();

    const durationRaw = (req.query.duration || "daily").toString().toLowerCase();

    const utcToday = toYMDUTC(new Date());

    let duration = durationRaw;
    let date = (req.query.date || "").toString();
    let rangeStart = (req.query.rangeStart || "").toString();
    let rangeEnd = (req.query.rangeEnd || "").toString();

    // ✅ duration aliases -> daily + computed date (UTC)
    if (durationRaw === "today") {
      duration = "daily";
      date = date || utcToday;
    } else if (durationRaw === "yesterday") {
      duration = "daily";
      date = date || addDaysUTC(utcToday, -1);
    } else if (durationRaw === "tomorrow") {
      duration = "daily";
      date = date || addDaysUTC(utcToday, +1);
    }

    const signId = req.query.signId ? Number(req.query.signId) : null;
    const limit = req.query.limit ? Math.min(200, Math.max(1, Number(req.query.limit))) : 12;
    const force = String(req.query.force || "0") === "1";

    const tone = (req.query.tone || "balanced").toString();
    const expertId = (req.query.expertId || "oracle").toString();
    const audience_scope = (req.query.audience_scope || "sign").toString();

    // service supports only these durations
    if (!["daily", "weekly", "monthly", "yearly"].includes(duration)) {
      return res.status(400).json({
        status: "error",
        message: "duration must be daily|weekly|monthly|yearly (aliases: today|yesterday|tomorrow)",
      });
    }

    // validation
    if (duration === "daily" && !date) {
      return res.status(400).json({
        status: "error",
        message: "date required for daily/today/yesterday/tomorrow",
      });
    }
    if (duration !== "daily" && (!rangeStart || !rangeEnd)) {
      return res.status(400).json({
        status: "error",
        message: "rangeStart and rangeEnd required for weekly/monthly/yearly",
      });
    }

    const out = await buildPredictionsFromRawBundles({
      system,
      lang,
      duration,
      date: duration === "daily" ? date : null,
      rangeStart: duration !== "daily" ? rangeStart : null,
      rangeEnd: duration !== "daily" ? rangeEnd : null,
      signId,
      limit,
      force,
      tone,
      expertId,
      audience_scope,
    });

    res.json({
      ...out,
      durationRequested: durationRaw,
      durationResolved: duration,
      resolvedDate: duration === "daily" ? date : null,
      utcToday,
    });
  } catch (e) {
    console.error("[raw-ai] error:", e);
    res.status(500).json({ status: "error", message: e.message });
  }
});

export default router;
