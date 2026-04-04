// routes/daily-horoscope-raw-summary_route.js
import express from "express";
import {
  buildDailyAndCurrentWeekly,
  ensureWeeklyForMonth,
  ensureMonthly,
  ensureYearly,
  buildDailyUntilYearEnd,
  getDailyByDate,
  ensureAllSnapshots, // ✅ NEW
  buildDailyForFullYear,
} from "../src/services/daily-horoscope-raw-summary.js";

const router = express.Router();

router.post("/build/daily-weekly", async (req, res) => {
  try {
    const system = (req.query.system || "western").toString();
    const lang = (req.query.lang || "en").toString();
    const out = await buildDailyAndCurrentWeekly({ system, lang });
    res.json(out);
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

router.post("/build/weekly-month", async (req, res) => {
  try {
    const system = (req.query.system || "western").toString();
    const lang = (req.query.lang || "en").toString();
    const year = Number(req.query.year);
    const month = Number(req.query.month);

    if (!year || !month || month < 1 || month > 12) {
      return res
        .status(400)
        .json({ status: "error", message: "year and month required (month 1..12)" });
    }

    const out = await ensureWeeklyForMonth({ system, lang, year, month });
    res.json(out);
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

router.post("/build/monthly", async (req, res) => {
  try {
    const system = (req.query.system || "western").toString();
    const lang = (req.query.lang || "en").toString();
    const year = Number(req.query.year);
    const month = Number(req.query.month);

    if (!year || !month || month < 1 || month > 12) {
      return res
        .status(400)
        .json({ status: "error", message: "year and month required (month 1..12)" });
    }

    const out = await ensureMonthly({ system, lang, year, month });
    res.json(out);
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

router.post("/build/yearly", async (req, res) => {
  try {
    const system = (req.query.system || "western").toString();
    const lang = (req.query.lang || "en").toString();
    const year = Number(req.query.year);

    if (!year) {
      return res.status(400).json({ status: "error", message: "year required" });
    }

    const out = await ensureYearly({ system, lang, year });
    res.json(out);
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

router.post("/build/daily-until-year-end", async (req, res) => {
  try {
    const system = (req.query.system || "western").toString();
    const lang = (req.query.lang || "en").toString();
    const year = Number(req.query.year);

    if (!year) return res.status(400).json({ status: "error", message: "year required" });

    const out = await buildDailyUntilYearEnd({ system, lang, year });
    res.json(out);
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// ✅ GET cached daily (duration='daily') for a date (all 12 signs)
router.get("/daily", async (req, res) => {
  try {
    const system = (req.query.system || "western").toString();
    const lang = (req.query.lang || "en").toString();
    const date = (req.query.date || "").toString();

    if (!date) {
      return res
        .status(400)
        .json({ status: "error", message: "date is required (YYYY-MM-DD)" });
    }

    const out = await getDailyByDate({ system, lang, date });
    res.json(out);
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

/**
 * ✅ NEW: One-shot ensure + verify (yesterday/today/tomorrow + weekly + monthly + yearly)
 * POST /api/astro/raw-summary/build/ensure-all?system=western&lang=en&year=2026&month=1
 */
router.post("/build/ensure-all", async (req, res) => {
  try {
    const system = (req.query.system || "western").toString();
    const lang = (req.query.lang || "en").toString();
    const year = req.query.year ? Number(req.query.year) : undefined;
    const month = req.query.month ? Number(req.query.month) : undefined;

    const out = await ensureAllSnapshots({ system, lang, year, month });
    res.json(out);
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});
// POST /api/astro/raw-summary/build/daily-year?system=western&lang=en&year=2026&force=0
router.post("/build/daily-year", async (req, res) => {
  try {
    const system = (req.query.system || "western").toString();
    const lang = (req.query.lang || "en").toString();
    const year = Number(req.query.year);
    const force = String(req.query.force || "0") === "1";

    if (!year) {
      return res.status(400).json({ status: "error", message: "year required" });
    }

    const out = await buildDailyForFullYear({ system, lang, year, force });
    res.json(out);
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

export default router;
