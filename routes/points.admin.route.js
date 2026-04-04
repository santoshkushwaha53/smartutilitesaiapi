// API/routes/points.admin.route.js
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../src/db.js';
// if you have an admin auth middleware, import it and apply to router

const router = Router();

/* ========= Zod Schemas ========= */

const serviceSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_]+$/, 'Use lowercase letters, numbers and underscores'),
  name: z.string().min(1).max(255),
  category: z.string().min(1).max(255),
  base_points: z.number().int().nonnegative(),
  free_chats: z.number().int().nonnegative().default(0),
  is_active: z.boolean().optional().default(true),
});

const serviceArraySchema = z.array(serviceSchema);

const multipliersSchema = z.object({
  free: z.number().min(0.1).max(5),
  lite: z.number().min(0.1).max(5),
  pro: z.number().min(0.1).max(5),
});

/* ========= Services ========= */

/**
 * GET /api/admin/points/services
 * Returns all services (for your grid)
 */
router.get('/services', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, name, category, base_points, free_chats, is_active
       FROM app_horoscope_services
       ORDER BY name;`,
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/points/services
 * Upsert a full list of services (from your Angular page).
 * Body: Service[]
 */
router.post('/services', async (req, res, next) => {
  try {
    const parsed = serviceArraySchema.parse(req.body);

    const client = await query('BEGIN'); // query returns rows, but to start a tx we use pool
    // If your `query` wrapper doesn’t expose client/transactions,
    // replace this whole transaction block with simple loop of `await query(...)` calls.

    try {
      await query('TRUNCATE TABLE app_horoscope_services RESTART IDENTITY;');

      for (const svc of parsed) {
        await query(
          `INSERT INTO app_horoscope_services
             (id, name, category, base_points, free_chats, is_active)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (id)
           DO UPDATE SET
             name = EXCLUDED.name,
             category = EXCLUDED.category,
             base_points = EXCLUDED.base_points,
             free_chats = EXCLUDED.free_chats,
             is_active = EXCLUDED.is_active;`,
          [
            svc.id,
            svc.name,
            svc.category,
            svc.base_points,
            svc.free_chats ?? 0,
            svc.is_active ?? true,
          ],
        );
      }

      await query('COMMIT;');
    } catch (inner) {
      await query('ROLLBACK;');
      throw inner;
    }

    res.json({ ok: true, count: parsed.length });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({
        ok: false,
        error: 'Validation failed',
        details: err.flatten(),
      });
    }
    next(err);
  }
});

/* ========= Tier multipliers ========= */

/**
 * GET /api/admin/points/multipliers
 */
router.get('/multipliers', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT tier, multiplier
       FROM app_horoscope_tier_multipliers;`,
    );

    const output = {
      free: 1.5,
      lite: 1.2,
      pro: 1.0,
    };

    for (const r of rows) {
      if (r.tier === 'free') output.free = Number(r.multiplier);
      if (r.tier === 'lite') output.lite = Number(r.multiplier);
      if (r.tier === 'pro') output.pro = Number(r.multiplier);
    }

    res.json(output);
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/admin/points/multipliers
 * Body: { free: number, lite: number, pro: number }
 */
router.put('/multipliers', async (req, res, next) => {
  try {
    const parsed = multipliersSchema.parse(req.body);

    const entries = [
      ['free', parsed.free],
      ['lite', parsed.lite],
      ['pro', parsed.pro],
    ];

    for (const [tier, value] of entries) {
      await query(
        `INSERT INTO app_horoscope_tier_multipliers (tier, multiplier)
         VALUES ($1, $2)
         ON CONFLICT (tier) DO UPDATE SET multiplier = EXCLUDED.multiplier;`,
        [tier, value],
      );
    }

    res.json({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({
        ok: false,
        error: 'Validation failed',
        details: err.flatten(),
      });
    }
    next(err);
  }
});

export default router;
