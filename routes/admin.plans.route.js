// API/routes/admin.plans.route.js
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../src/db.js';

const router = Router();

/* ───────────── Schemas ───────────── */

const featureBulletSchema = z.object({
  icon: z.string().optional().default('✦'),
  label: z.string().min(1)
});

const planSchema = z.object({
  plan_code: z.string().min(3),
  display_name: z.string().min(3),
  tagline: z.string().optional().nullable(),
  tier: z.enum(['free', 'lite', 'pro', 'universal']),
  horoscope_scope: z.enum(['select_one', 'western_only', 'vedic_only', 'dual']),
  billing_period: z.enum(['none', 'weekly', 'monthly', 'yearly']),

  base_price_usd: z.number().nonnegative(),

  region_band: z.enum(['global', 'A', 'B', 'C']).default('global'),
  country_code: z.string().length(2).optional().nullable(),
  currency_code: z.string().min(3).max(3).default('USD'),
  local_price: z.number().nonnegative(),

  monthly_points: z.number().int().nonnegative(),
  daily_points: z.number().int().nonnegative().optional().default(0),
  rollover_cap: z.number().int().nonnegative(),
  max_profiles: z.number().int().positive(),
  is_ad_free: z.boolean(),
  is_most_popular: z.boolean().optional().default(false),
  sort_order: z.number().int().nonnegative().optional().default(0),

  feature_bullets: z.array(featureBulletSchema).optional().default([]),

  is_active: z.boolean().optional().default(true)
});

const partialPlanSchema = planSchema.partial();

/* ───────────── Helpers ───────────── */

async function getAllPlans(includeInactive = true) {
  const { rows } = await query(
    `SELECT *
       FROM subscription_plans
      ${includeInactive ? '' : 'WHERE is_active = TRUE'}
      ORDER BY sort_order, id`
  );
  return rows;
}

/* ───────────── Routes (mounted under /api/admin) ───────────── */

// GET /api/admin/plans
router.get('/plans', async (req, res) => {
  try {
    const plans = await getAllPlans(true);
    res.json(plans);
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/plans/:id
router.get('/plans/:id', async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT * FROM subscription_plans WHERE id = $1',
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/plans
router.post('/plans', async (req, res, next) => {
  try {
    const data = planSchema.parse(req.body);

    const { rows } = await query(
      `INSERT INTO subscription_plans
        (plan_code, display_name, tagline, tier, horoscope_scope, billing_period,
         base_price_usd, region_band, country_code, currency_code, local_price,
         monthly_points, daily_points, rollover_cap, max_profiles,
         is_ad_free, is_most_popular, sort_order, feature_bullets, is_active)
       VALUES
        ($1,$2,$3,$4,$5,$6,
         $7,$8,$9,$10,$11,
         $12,$13,$14,$15,
         $16,$17,$18,$19::jsonb,$20)
       RETURNING *`,
      [
        data.plan_code,
        data.display_name,
        data.tagline ?? null,
        data.tier,
        data.horoscope_scope,
        data.billing_period,
        data.base_price_usd,
        data.region_band ?? 'global',
        data.country_code ?? null,
        data.currency_code ?? 'USD',
        data.local_price,
        data.monthly_points,
        data.daily_points ?? 0,
        data.rollover_cap,
        data.max_profiles,
        data.is_ad_free,
        data.is_most_popular ?? false,
        data.sort_order ?? 0,
        JSON.stringify(data.feature_bullets || []),
        data.is_active ?? true
      ]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', details: err.errors });
    }
    next(err);
  }
});

// PUT /api/admin/plans/:id
router.put('/plans/:id', async (req, res, next) => {
  try {
    const data = planSchema.parse(req.body);

    const { rows } = await query(
      `UPDATE subscription_plans SET
         plan_code=$1,
         display_name=$2,
         tagline=$3,
         tier=$4,
         horoscope_scope=$5,
         billing_period=$6,
         base_price_usd=$7,
         region_band=$8,
         country_code=$9,
         currency_code=$10,
         local_price=$11,
         monthly_points=$12,
         daily_points=$13,
         rollover_cap=$14,
         max_profiles=$15,
         is_ad_free=$16,
         is_most_popular=$17,
         sort_order=$18,
         feature_bullets=$19::jsonb,
         is_active=$20,
         updated_at=now()
       WHERE id=$21
       RETURNING *`,
      [
        data.plan_code,
        data.display_name,
        data.tagline ?? null,
        data.tier,
        data.horoscope_scope,
        data.billing_period,
        data.base_price_usd,
        data.region_band ?? 'global',
        data.country_code ?? null,
        data.currency_code ?? 'USD',
        data.local_price,
        data.monthly_points,
        data.daily_points ?? 0,
        data.rollover_cap,
        data.max_profiles,
        data.is_ad_free,
        data.is_most_popular ?? false,
        data.sort_order ?? 0,
        JSON.stringify(data.feature_bullets || []),
        data.is_active ?? true,
        req.params.id
      ]
    );

    if (!rows[0]) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json(rows[0]);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', details: err.errors });
    }
    next(err);
  }
});

// PATCH /api/admin/plans/:id
router.patch('/plans/:id', async (req, res, next) => {
  try {
    const patch = partialPlanSchema.parse(req.body);

    const fields = [];
    const values = [];
    let i = 1;

    for (const [key, value] of Object.entries(patch)) {
      if (key === 'feature_bullets') {
        fields.push(`feature_bullets = $${i}::jsonb`);
        values.push(JSON.stringify(value));
      } else {
        fields.push(`${key} = $${i}`);
        values.push(value);
      }
      i++;
    }

    if (!fields.length) {
      return res.status(400).json({ error: 'NO_FIELDS' });
    }

    values.push(req.params.id);

    const { rows } = await query(
      `UPDATE subscription_plans
         SET ${fields.join(', ')}, updated_at = now()
       WHERE id = $${values.length}
       RETURNING *`,
      values
    );

    if (!rows[0]) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json(rows[0]);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', details: err.errors });
    }
    next(err);
  }
});

export default router;
