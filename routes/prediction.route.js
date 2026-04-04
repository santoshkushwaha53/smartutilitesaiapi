import express from 'express';
import { query } from '../src/db.js';
import { writePredictionFromRaw } from '../utils/llm.js';
import { assertPredictionProviderEnabled } from '../src/apiProviders.js';  // 👈 NEW
const router = express.Router();

/*
POST /api/prediction/run
{
  "rawEventId": "UUID from astro_raw_event",
  "period": "today",
  "audience_scope": "generic",      // or "personal"
  "lang": "en",
  "tone": "concise",
  "provider": "openai",
  "model": "gpt-4o-mini",
  "force": false
}
*/
router.post('/run', async (req, res) => {
  try {
    const {
      rawEventId,
      period = 'today',
      audience_scope = 'generic',
      lang = 'en',
      tone = 'concise',
      provider = 'openai',
      model = 'gpt-4o-mini',
      force = false
    } = req.body || {};

      // 🔒 NEW: API Manager check for OpenAI
    try {
      await assertPredictionProviderEnabled('openai-oracle', {
        chatScopeId: chatScopeId || null,
        featureId: featureId || 'general-tools',
      });
    } catch (cfgErr) {
      console.warn('[PREDICTION] blocked by API Manager:', cfgErr.message);
      return res.status(503).json({
        error: 'prediction_provider_disabled',
        message: cfgErr.message,
      });
    }

    if (!rawEventId) return res.status(400).json({ error: 'rawEventId is required' });
    if (!['generic','personal'].includes(audience_scope)) {
      return res.status(400).json({ error: 'audience_scope must be generic|personal' });
    }

    // 1) fetch the raw event
    const r = await query('SELECT * FROM astro_raw_event WHERE id=$1', [rawEventId]);
    if (!r.rows.length) return res.status(404).json({ error: 'raw event not found' });
    const raw = r.rows[0];

    // 2) if not force, see if we already have a prediction
    if (!force) {
      const existing = await query(
        `SELECT * FROM astro_prediction 
         WHERE raw_event_id=$1 AND lang=$2 AND tone=$3 AND audience_scope=$4 
         LIMIT 1`,
        [rawEventId, lang, tone, audience_scope]
      );
      if (existing.rows.length) {
        return res.json({ fromCache: true, prediction: existing.rows[0] });
      }
    }

    // 3) generate text
    // You can trim what you pass to the LLM to reduce tokens:
    const rawJson = raw.response_json?.data || raw.response_json;
    const gen = await writePredictionFromRaw({
      provider, model, period, lang, tone, rawJson
    });

    // 4) save
    const ins = `
      INSERT INTO astro_prediction
        (raw_event_id, period, audience_scope, lang, tone, model_provider, model_name, text,
         prompt_tokens, completion_tokens, cost_usd)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (raw_event_id, lang, tone, audience_scope) DO UPDATE
        SET text = EXCLUDED.text,
            model_provider = EXCLUDED.model_provider,
            model_name = EXCLUDED.model_name
      RETURNING *;`;
    const usage = gen.usage || {};
    const vals = [
      rawEventId, period, audience_scope, lang, tone,
      gen.provider, gen.model, gen.text,
      usage.input_tokens || null, usage.output_tokens || null, null /* cost calc optional */
    ];
    const saved = await query(ins, vals);

    res.json({ fromCache: false, prediction: saved.rows[0] });
  } catch (err) {
    console.error('prediction error:', err);
    res.status(500).json({ error: err.message || 'prediction failed' });
  }
});

// convenience: latest by raw
router.get('/latest/:rawEventId', async (req, res) => {
  try {
    const r = await query(
      `SELECT * FROM astro_prediction 
       WHERE raw_event_id=$1 
       ORDER BY created_at DESC LIMIT 1`,
      [req.params.rawEventId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
