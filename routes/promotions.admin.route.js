// API/routes/promotions.admin.route.js
import { Router } from 'express';
import adminPromosSvc from '../src/services/promotions.admin.service.js';
import { z } from 'zod';

const router = Router();

/**
 * Simple admin guard.
 * Assumes a global auth middleware has already populated req.user
 * from the JWT (id, email, role, ...).
 */
const requireAdmin = (req, res, next) => {
  if (!req.user?.id || req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};

// ------------------------------------------------------
// Helpers: coercion for numbers / strings
// ------------------------------------------------------

// required non-negative integer (e.g. points, days_valid)
const intRequired = (minVal = 0, maxVal) => {
  let numSchema = z.number().int().min(minVal);

  if (typeof maxVal === 'number') {
    numSchema = numSchema.max(maxVal);
  }

  return z.preprocess(
    (val) => {
      if (val === null || val === undefined || val === '') return undefined;
      const n = Number(val);
      return Number.isNaN(n) ? undefined : n;
    },
    numSchema
  );
};

// optional / nullable integer (e.g. max_global_redemptions, max_per_user)
const intNullableOptional = () =>
  z.preprocess(
    (val) => {
      if (val === null || val === undefined || val === '') return null;
      const n = Number(val);
      return Number.isNaN(n) ? null : n;
    },
    z.number().int().nullable()
  );

// required string with min length
const stringRequiredMin = (minLen = 1) =>
  z.preprocess(
    (val) => (val === null || val === undefined ? '' : String(val)),
    z.string().min(minLen)
  );

// optional string coercion
const stringOptional = () =>
  z.preprocess(
    (val) =>
      val === null || val === undefined || val === ''
        ? undefined
        : String(val),
    z.string()
  );

// ------------------------------------------------------
// Zod Schemas for promotions
// ------------------------------------------------------
//
// NOTE: kind / status must still match your Postgres enums:
// promo_kind:   'global_code' | 'targeted' | 'referral' | 'feature_unlock'
// promo_status: 'draft' | 'active' | 'paused' | 'expired'

const createSchema = z.object({
  kind: stringRequiredMin(1), // later can change to z.enum([...])
  code: stringOptional(),
  name: stringRequiredMin(3),
  description: stringOptional(),

  points: intRequired(0),
  days_valid: intRequired(0),

  start_at: stringRequiredMin(1), // ISO date string
  end_at: stringRequiredMin(1), // ISO date string

  max_global_redemptions: intNullableOptional().optional(),
  max_per_user: intNullableOptional().optional(),

  metadata: z.any().optional(),
});

// For update: all fields optional, plus constrained status
const updateSchema = createSchema
  .partial()
  .extend({
    status: z
      .preprocess(
        (val) =>
          val === null || val === undefined || val === ''
            ? undefined
            : String(val),
        z.enum(['draft', 'active', 'paused', 'expired'])
      )
      .optional(),
  });

// for code generation
const generateCodesSchema = z.object({
  prefix: stringRequiredMin(2),
  count: intRequired(1, 1000), // min 1, max 1000
});

// ------------------------------------------------------
// Zod Schemas for assignment
// ------------------------------------------------------

// ✅ Zod: assignment rules structure
const AssignmentRulesSchema = z.object({
  target: z
    .object({
      scope: z.enum(['all_users', 'segment', 'plan_only']),
      segment_keys: z.array(z.string()).default([]),
      plans: z.array(z.string()).default([]),
    })
    .strict(),

  quota: z
    .object({
      max_assignments_total: z.number().int().nullable().optional(),
      max_assignments_per_user: z.number().int().nullable().optional(),
    })
    .strict(),

  channels: z
    .object({
      web: z.boolean().default(true),
      android: z.boolean().default(true),
      ios: z.boolean().default(true),
    })
    .strict(),

  auto_trigger: z
    .object({
      on_signup: z.boolean().default(false),
      on_first_purchase: z.boolean().default(false),
      on_daily_login: z.boolean().default(false),
    })
    .strict(),
}).strict();

// ✅ Payload wrapper
const AssignmentPayloadSchema = z.object({
  assignment_rules: AssignmentRulesSchema,
});


// ------------------------------------------------------
// Routes
// Base path: /api/admin/promotions
// ------------------------------------------------------

// IMPORTANT: more specific routes (/:id/assignment, /:id/stats, etc.)
// MUST come before the generic "/:id" route, or Express will swallow
// the path and you'll see 404s.

// GET /api/admin/promotions/:id/assignment
router.get('/:id/assignment', requireAdmin, async (req, res) => {
  try {
    const rules = await adminPromosSvc.getAssignment(req.params.id);
    res.json({ assignment_rules: rules });
  } catch (err) {
    console.error('[PROMO ADMIN] getAssignment error:', err);
    const status = err.statusCode || 400;
    res
      .status(status)
      .json({ error: err.message || 'Failed to fetch assignment rules' });
  }
});

// POST /api/admin/promotions/:id/assignment
router.post('/:id/assignment', requireAdmin, async (req, res) => {
  try {
    console.log('ASSIGNMENT BODY:', req.body); // 👈 add this temporarily

    const parsed = AssignmentPayloadSchema.parse(req.body || {});
    const saved = await adminPromosSvc.saveAssignment(
      req.params.id,
      parsed.assignment_rules
    );
    res.json({ ok: true, assignment_rules: saved });
  } catch (err) {
    if (err?.issues) {
      return res.status(400).json({
        error: 'Invalid assignment payload',
        details: err.issues,
      });
    }
    console.error('[PROMO ADMIN] saveAssignment error:', err);
    const status = err.statusCode || 400;
    res
      .status(status)
      .json({ error: err.message || 'Failed to save assignment rules' });
  }
});

// ------------------------------------------------------
// LIST + BASIC PROMO ENDPOINTS
// ------------------------------------------------------

// GET /api/admin/promotions
router.get('/', requireAdmin, async (req, res) => {
  try {
    const rawStatus = req.query.status;
    const rawKind = req.query.kind;

    const status =
      typeof rawStatus === 'string' && rawStatus.trim() !== ''
        ? rawStatus.trim()
        : null;

    const kind =
      typeof rawKind === 'string' && rawKind.trim() !== ''
        ? rawKind.trim()
        : null;

    const data = await adminPromosSvc.list({ status, kind });
    res.json(data);
  } catch (err) {
    console.error('[PROMO ADMIN] list error:', err);
    res
      .status(400)
      .json({ error: err.message || 'Failed to list promotions' });
  }
});

// GET /api/admin/promotions/:id/stats
router.get('/:id/stats', requireAdmin, async (req, res) => {
  try {
    const stats = await adminPromosSvc.stats(req.params.id);
    res.json(stats);
  } catch (err) {
    console.error('[PROMO ADMIN] stats error:', err);
    res
      .status(400)
      .json({ error: err.message || 'Failed to fetch stats' });
  }
});

// POST /api/admin/promotions
router.post('/', requireAdmin, async (req, res) => {
  try {
    const payload = createSchema.parse(req.body || {});
    const data = await adminPromosSvc.create(payload, req.user.id);
    res.status(201).json(data);
  } catch (err) {
    if (err?.issues) {
      return res
        .status(400)
        .json({ error: 'Invalid payload', details: err.issues });
    }
    console.error('[PROMO ADMIN] create error:', err);
    res
      .status(400)
      .json({ error: err.message || 'Failed to create promotion' });
  }
});

// PATCH /api/admin/promotions/:id
router.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const payload = updateSchema.parse(req.body || {});
    const data = await adminPromosSvc.update(req.params.id, payload);
    res.json(data);
  } catch (err) {
    if (err?.issues) {
      return res
        .status(400)
        .json({ error: 'Invalid payload', details: err.issues });
    }
    console.error('[PROMO ADMIN] update error:', err);
    res
      .status(400)
      .json({ error: err.message || 'Failed to update promotion' });
  }
});

// POST /api/admin/promotions/:id/generate-codes
router.post('/:id/generate-codes', requireAdmin, async (req, res) => {
  try {
    const { prefix, count } = generateCodesSchema.parse(req.body || {});
    const codes = await adminPromosSvc.generateCodes(req.params.id, {
      prefix,
      count,
    });
    res.json({ ok: true, codes });
  } catch (err) {
    if (err?.issues) {
      return res
        .status(400)
        .json({ error: 'Invalid payload', details: err.issues });
    }
    console.error('[PROMO ADMIN] generate-codes error:', err);
    res
      .status(400)
      .json({ error: err.message || 'Failed to generate codes' });
  }
});

// GET /api/admin/promotions/:id/codes
router.get('/:id/codes', requireAdmin, async (req, res) => {
  try {
    const data = await adminPromosSvc.listCodes(req.params.id);
    res.json(data);
  } catch (err) {
    console.error('[PROMO ADMIN] listCodes error:', err);
    res
      .status(400)
      .json({ error: err.message || 'Failed to fetch codes' });
  }
});

// GET /api/admin/promotions/:id/usage
router.get('/:id/usage', requireAdmin, async (req, res) => {
  try {
    const data = await adminPromosSvc.listUsage(req.params.id);
    res.json(data);
  } catch (err) {
    console.error('[PROMO ADMIN] listUsage error:', err);
    res
      .status(400)
      .json({ error: err.message || 'Failed to fetch usage' });
  }
});

// LAST: generic details route (must be after the more specific ones)
router.get('/:id', requireAdmin, async (req, res) => {
  try {
    const data = await adminPromosSvc.details(req.params.id);
    if (!data) {
      return res.status(404).json({ error: 'Promo not found' });
    }
    res.json(data);
  } catch (err) {
    console.error('[PROMO ADMIN] details error:', err);
    res
      .status(400)
      .json({ error: err.message || 'Failed to fetch promotion' });
  }
});
// PUT /api/admin/promotions/:id/assignment
router.put('/:id/assignment', requireAdmin, async (req, res) => {
  try {
    console.log('ASSIGNMENT BODY (PUT):', req.body); // 👈 add this too

    const parsed = AssignmentPayloadSchema.parse(req.body || {});
    const saved = await adminPromosSvc.saveAssignment(
      req.params.id,
      parsed.assignment_rules
    );
    res.json({ ok: true, assignment_rules: saved });
  } catch (err) {
    if (err?.issues) {
      return res.status(400).json({
        error: 'Invalid assignment payload',
        details: err.issues,
      });
    }
    console.error('[PROMO ADMIN] saveAssignment (PUT) error:', err);
    const status = err.statusCode || 400;
    res
      .status(status)
      .json({ error: err.message || 'Failed to save assignment rules' });
  }
});

export default router;
