import express from 'express';
import { generateVedicBirthChartRaw, loadVedicRawForUi } from '../../src/services/vedicBirthChartRaw.service.js';
import { interpretVedicChart, loadLatestVedicInterpretationForUi } from '../../src/services/vedicBirthChartInterpret.service.js';

const router = express.Router();

/* ======================================================
 * POST /api/birthchart/vedic/birth-chart/raw
 * (EXACT SAME payload + response as before)
 * ====================================================== */
router.post('/vedic/birth-chart/raw', async (req, res) => {
  try {
    const result = await generateVedicBirthChartRaw(req.body);
    return res.status(result.httpStatus).json(result.body);
  } catch (err) {
    console.error('[Vedic BirthChart RAW Error]', err);
    return res.status(500).json({
      ok: false,
      error: 'vedic_birth_chart_raw_failed',
      detail: err?.message || String(err)
    });
  }
});

/* ======================================================
 * POST /api/birthchart/vedic/interpret
 * (EXACT SAME payload + response as before)
 * ====================================================== */
router.post('/vedic/interpret', async (req, res) => {
  try {
    const result = await interpretVedicChart(req.body);
    return res.status(result.httpStatus).json(result.body);
  } catch (err) {
    console.error('[Vedic Interpretation Error]', err);
    return res.status(500).json({
      ok: false,
      error: 'vedic_interpretation_failed',
      detail: err.message
    });
  }
});

/* ======================================================
 * NEW: POST /api/birthchart/vedic/get-or-generate
 *
 * PURPOSE:
 *  1) RAW generate/store (phase1+phase2)
 *  2) Interpret (cached or new)
 *  3) Return RAW + divisionals + interpretation FROM DB to UI
 *
 * NOTE:
 *  - This is NEW endpoint (no breaking to existing endpoints)
 * ====================================================== */
router.post('/vedic/get-or-generate', async (req, res) => {
  const startedAt = Date.now();

  try {
    // Keep flexible inputs (raw endpoint expects these fields)
    const {
      userId,
      birthProfileId = null,
      year, month, date, hours, minutes, seconds = 0,
      latitude, longitude, timezone,
      observation_point = 'topocentric',
      ayanamsha = 'lahiri',
      language = 'en',
      purpose = 'natal',
      lang = 'en',
      tone = 'balanced'
    } = req.body || {};

    if (!userId) {
      return res.status(400).json({ ok: false, error: 'missing_userId' });
    }

    // 1) RAW (returns same body as raw endpoint)
    const rawResult = await generateVedicBirthChartRaw({
      userId,
      birthProfileId,
      year, month, date, hours, minutes, seconds,
      latitude, longitude, timezone,
      observation_point,
      ayanamsha,
      language,
      purpose
    });

    if (!rawResult?.body?.ok) {
      // rawResult already has proper httpStatus + body
      return res.status(rawResult.httpStatus || 500).json(rawResult.body);
    }

    const vedicRawId = rawResult.body.vedicRawId;

    // 2) INTERPRET (returns same body as interpret endpoint)
    const interpResult = await interpretVedicChart({
      userId,
      vedicRawId,
      lang,
      purpose,
      tone
    });

    if (!interpResult?.body?.ok) {
      return res.status(interpResult.httpStatus || 500).json(interpResult.body);
    }

    // 3) LOAD FROM DB for UI
    const { raw, divisionals } = await loadVedicRawForUi({ userId, vedicRawId });
    const latestInterp = await loadLatestVedicInterpretationForUi({
      userId,
      vedicRawId,
      lang,
      purpose,
      tone
    });

    return res.json({
      ok: true,
      source: interpResult.body.cached ? 'cache' : 'generated',
      userId,
      vedicRawId,

      // raw generation summary (same fields)
      generatorResponse: rawResult.body,

      // interpretation summary (same fields)
      interpretationResponse: interpResult.body,

      // DB payload for UI
      db: {
        raw,                 // full row from vedic_birth_chart_raw
        divisionals,         // rows from vedic_divisional_chart_raw
        interpretation: latestInterp
          ? {
              html: latestInterp.interpretation_html,
              createdAt: latestInterp.created_at,
              promptHash: latestInterp.prompt_hash,
              model: latestInterp.model,
              responseJson: latestInterp.response_json
            }
          : null
      },

      tookMs: Date.now() - startedAt
    });

  } catch (err) {
    console.error('[vedic/get-or-generate fatal]', err);
    return res.status(500).json({
      ok: false,
      error: 'vedic_get_or_generate_failed',
      detail: err?.message || String(err)
    });
  }
});

export default router;
