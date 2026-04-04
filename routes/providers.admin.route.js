// routes/providers.admin.route.js
// Simple, read-only admin endpoints to see routing rules in effect.
// Mount at: app.use('/api/horoscope/providers', providersAdminRouter);

import express from 'express';
import { query } from '../src/db.js';

const providersAdminRouter = express.Router();

// These are just convenient defaults so /routes works out-of-the-box.
// They don't restrict your DB rules in any way.
const FEATURES = [
  'raw_panchang',          // vedic raw (panchang/kundli pre-compute)
  'horoscope_prediction',  // text predictions
  'compatibility',
  'kundli',
  'numerology',
  'birth_chart',
];

const SYSTEMS = ['western', 'vedic'];
const PERIODS = ['yesterday', 'today', 'tomorrow', 'weekly', 'monthly', 'yearly'];

// Topics are now free-form in your schema; this list only drives the /routes grid.
const TOPICS = [
  'general', 'love', 'career', 'money', 'health', 'relationships',
  'family', 'job', 'lucky_number', 'lucky_color', 'numerology'
];

/**
 * GET /api/horoscope/providers/_diag
 * Quick fingerprint/health for this router.
 */
providersAdminRouter.get('/_diag', (_req, res) => {
  res.json({ ok: true, where: 'providers.admin.route.js', version: 'v2' });
});

/**
 * GET /api/horoscope/providers/routes
 * Returns a grid of {feature,system,period,topic -> provider_code}.
 * You can filter with ?feature=&system=&period=&topic= (single values).
 */
providersAdminRouter.get('/routes', async (req, res) => {
  try {
    const featureQ = req.query.feature ? [String(req.query.feature)] : FEATURES;
    const systemQ  = req.query.system  ? [String(req.query.system)]  : SYSTEMS;
    const periodQ  = req.query.period  ? [String(req.query.period)]  : PERIODS;
    const topicQ   = req.query.topic   ? [String(req.query.topic)]   : TOPICS;

    const rows = [];
    for (const feature of featureQ) {
      for (const system of systemQ) {
        for (const period of periodQ) {
          for (const topic of topicQ) {
            const r = await query(
              `SELECT public.fn_pick_provider($1,$2,$3,$4, CURRENT_DATE) AS code`,
              [feature, system, period, topic]
            );
            rows.push({
              feature, system, period, topic,
              provider: r.rows?.[0]?.code ?? null,
            });
          }
        }
      }
    }

    return res.json({ ok: true, rows, count: rows.length });
  } catch (e) {
    console.error('[providers.routes] error', e);
    return res.status(500).json({ ok: false, error: e.message || 'failed' });
  }
});

/**
 * GET /api/horoscope/providers/pick?feature=...&system=...&period=...&topic=...
 * Fast single-pick helper.
 */
providersAdminRouter.get('/pick', async (req, res) => {
  try {
    const feature = String(req.query.feature || '');
    const system  = req.query.system  ? String(req.query.system)  : null;
    const period  = req.query.period  ? String(req.query.period)  : null;
    const topic   = req.query.topic   ? String(req.query.topic)   : null;

    if (!feature) {
      return res.status(400).json({ ok: false, error: 'feature is required' });
    }

    const r = await query(
      `SELECT public.fn_pick_provider($1,$2,$3,$4, CURRENT_DATE) AS code`,
      [feature, system, period, topic]
    );

    return res.json({
      ok: true,
      input: { feature, system, period, topic },
      provider: r.rows?.[0]?.code ?? null,
    });
  } catch (e) {
    console.error('[providers.pick] error', e);
    return res.status(500).json({ ok: false, error: e.message || 'failed' });
  }
});

/**
 * GET /api/horoscope/providers/rules
 * Dump raw rules + joined provider info (debug).
 * Works if your DB has:
 *   - public.provider_routing_rules (feature, system, period, topic, provider_code, priority, enabled, updated_at, ...)
 *   - public.providers (code, name, is_active, ...)
 */
providersAdminRouter.get('/rules', async (_req, res) => {
  try {
    const sql = `
      SELECT r.*, p.name AS provider_name, p.is_active AS provider_active
      FROM public.provider_routing_rules r
      JOIN public.providers p ON p.code = r.provider_code
      ORDER BY r.feature,
               r.system  NULLS LAST,
               r.period  NULLS LAST,
               r.topic   NULLS LAST,
               r.priority DESC,
               r.updated_at DESC
    `;
    const r = await query(sql);
    return res.json({ ok: true, rules: r.rows, count: r.rowCount });
  } catch (e) {
    console.error('[providers.rules] error', e);
    return res.status(500).json({ ok: false, error: e.message || 'failed' });
  }
});

/**
 * GET /api/horoscope/providers
 * List providers registry.
 */
providersAdminRouter.get('/', async (_req, res) => {
  try {
    const r = await query(`SELECT * FROM public.providers ORDER BY code`);
    return res.json({ ok: true, providers: r.rows });
  } catch (e) {
    console.error('[providers.list] error', e);
    return res.status(500).json({ ok: false, error: e.message || 'failed' });
  }
});

export default providersAdminRouter;
