// routes/freeastroScheduler.route.js
import express from 'express';
import {
  runDailyJobNow,
  runWeeklyJobNow,
  runMonthlyJobNow,
  runYearlyJobNow,
} from '../jobs/PlanetsScheduler.js';

const router = express.Router();

/**
 * POST /api/admin/freeastro/run-planets-job
 *
 * Body:
 * { "mode": "daily" | "weekly" | "monthly" | "yearly" }
 *
 * This will:
 *  - read all zodiac signs from public.zodiac_sign
 *  - call /api/freeastro/western/planets/range for each sign
 *  - use the correct periods depending on mode
 */
router.post('/run-planets-job', async (req, res) => {
  const mode = (req.body?.mode || 'daily').toLowerCase();

  try {
    let resultLabel = '';

    if (mode === 'daily') {
      await runDailyJobNow();
      resultLabel = 'daily(yesterday,today,tomorrow)';
    } else if (mode === 'weekly') {
      await runWeeklyJobNow();
      resultLabel = 'weekly(next7)';
    } else if (mode === 'monthly') {
      await runMonthlyJobNow();
      resultLabel = 'monthly(next30-for-next-month)';
    } else if (mode === 'yearly') {
      await runYearlyJobNow();
      resultLabel = 'yearly(year-for-next-year)';
    } else {
      return res.status(400).json({
        ok: false,
        error: 'invalid_mode',
        message: 'mode must be one of: daily, weekly, monthly, yearly',
      });
    }

    return res.json({
      ok: true,
      mode,
      message: `Planets job triggered: ${resultLabel}`,
    });
  } catch (err) {
    console.error('[FreeAstroSched Admin] run-planets-job error', err);
    return res.status(500).json({
      ok: false,
      error: 'scheduler_error',
      detail: String(err?.message || err),
    });
  }
});

export default router;
