import { Router } from 'express';
import {
  SIGNS,
  callOpenAIForAll,
  upsertAllSigns,
  getOneSign
} from '../src/services/auspicious.service.js';
import { callAiService } from '../src/services/ai-engine/aiEngine.js'; // 👈 generic engine using tables + cache

const router = Router();

/**
 * POST /api/astro/build/all?dayOffset=0&userId=u1
 * Calls OpenAI (structured JSON) for all 12 signs, then upserts into Postgres.
 */
router.post('/build/all', async (req, res) => {
  try {
    const dayOffset = Number(req.query.dayOffset ?? 0);
    const userId    = String(req.query.userId ?? '');

    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + dayOffset);
    const dayISO = d.toISOString().slice(0, 10);

    const payload = await callOpenAIForAll(dayISO);
    if (payload.dateISO !== dayISO) {
      throw new Error(`dateISO mismatch: ${payload.dateISO} vs ${dayISO}`);
    }
    if (!payload.signs || payload.signs.length !== 12) {
      throw new Error('Expected 12 signs in payload');
    }

    await upsertAllSigns(dayISO, dayOffset, userId, payload);
    res.json({ ok: true, dayISO, inserted: payload.signs.map(s => s.sign) });
  } catch (e) {
    console.error('[auspicious.build/all]', e);
    res.status(500).json({ ok: false, error: e.message || 'failed' });
  }
});

/**
 * 🔁 NEW: POST /api/astro/build/all-live?dayOffset=0&tier=free
 * Uses generic config-driven engine (service tables + schema) to get JSON
 * for all 12 signs WITHOUT writing to DB. Good for testing schemas/prompts.
 */
router.post('/build/all-live', async (req, res) => {
  try {
    const dayOffset = Number(req.query.dayOffset ?? 0);
    const tier      = String(req.query.tier || 'free');

    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + dayOffset);
    const dayISO = d.toISOString().slice(0, 10);

    const result = await callAiService({
      serviceCode: 'AUSPICIOUS_ALL_SIGNS',
      tier,
      languageCode: 'en',
      period: 'daily',
      extraCtx: {
        dateISO: dayISO,
        signsCsv: SIGNS.join(', '),
        temperature: 0.2,
      },
    });

    // result.payload is JSON defined by app_ai_schema_master for AUSPICIOUS_ALL_SIGNS
    res.json({
      ok: true,
      dayISO,
      modelId: result.modelId,
      responseFormat: result.responseFormat,
      payload: result.payload,
    });
  } catch (e) {
    console.error('[auspicious.build/all-live]', e);
    res.status(500).json({ ok: false, error: e.message || 'failed' });
  }
});

/**
 * GET /api/astro/auspicious?sign=Leo&dayOffset=0&userId=u1
 * Returns one sign’s data in the exact shape your widget consumes.
 */
router.get('/auspicious', async (req, res) => {
  try {
    const sign      = String(req.query.sign || 'Leo');
    const dayOffset = Number(req.query.dayOffset ?? 0);
    const userId    = String(req.query.userId ?? '');

    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + dayOffset);
    const dayISO = d.toISOString().slice(0, 10);

    const payload = await getOneSign(sign, dayISO, dayOffset, userId);
    if (!payload) {
      return res
        .status(404)
        .json({ ok: false, error: 'Not found. Run /api/astro/build/all first.' });
    }
    res.json(payload);
  } catch (e) {
    console.error('[auspicious.get]', e);
    res.status(500).json({ ok: false, error: e.message || 'failed' });
  }
});

// Read one sign in widget shape
router.get('/sign/:sign', async (req, res) => {
  try {
    const dayOffset = Number(req.query.dayOffset ?? 0);
    const userId = String(req.query.userId || '');
    const dayISO = new Date(Date.now() + dayOffset*24*3600*1000)
      .toISOString()
      .slice(0,10);

    const payload = await getOneSign(req.params.sign, dayISO, dayOffset, userId);
    if (!payload) return res.status(404).json({ ok:false, error: 'not found' });

    res.json({ ok:true, sign: req.params.sign, dayISO, payload });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

export default router;
