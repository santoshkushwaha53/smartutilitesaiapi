// routes/public.pricing.route.js
import { Router } from 'express';
import { query } from '../src/db.js';

const router = Router();

// GET /api/public/plans?billing=monthly
router.get('/public/plans', async (req, res, next) => {
  try {
    const billing = req.query.billing || 'monthly';

    const { rows } = await query(
      `SELECT id, plan_code, display_name, tagline, tier, horoscope_scope,
              billing_period, base_price_usd, monthly_points, daily_points,
              rollover_cap, max_profiles, is_ad_free, is_most_popular,
              sort_order, feature_bullets
       FROM subscription_plans
       WHERE is_active = TRUE
         AND (billing_period = $1 OR $1 = 'all')
       ORDER BY sort_order, id`,
      [billing]
    );

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

export default router;
