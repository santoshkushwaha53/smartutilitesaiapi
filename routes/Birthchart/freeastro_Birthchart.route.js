import express from 'express';
import { query } from '../../src/db.js';
import {
  buildWesternPlanetsPayload,
  buildWesternHousesPayload,
  buildWesternAspectsPayload,
  callFreeAstro,
} from '../../utils/freeastro.js';

// ✅ interpretation service (your real service)
import { predictBirthChart } from '../../src/services/birthchart-engine/westernInterpret.service.js';

const router = express.Router();

/* -------------------------------------------------------
 * Normalize coordinates to avoid duplicate DB rows
 * ----------------------------------------------------- */
function normalizeCoords(lat, lon) {
  return `${Number(lat).toFixed(6)},${Number(lon).toFixed(6)}`;
}

/* -------------------------------------------------------
 * Convert fetch / axios errors into readable output
 * ----------------------------------------------------- */
function toErrorDetail(e) {
  const status = e?.response?.status;
  const data = e?.response?.data;
  if (status) return { kind: 'http', status, data };

  return {
    kind: 'fetch',
    name: e?.name,
    message: String(e?.message || e),
    cause: e?.cause ? String(e.cause) : null,
  };
}

/* -------------------------------------------------------
 * Helpers: derive birth_date & birth_time from ISO
 * ✅ FIX: do NOT convert to UTC (toISOString changes time)
 * ----------------------------------------------------- */
function isoToBirthDate(iso) {
  return String(iso).split('T')[0];
}
function isoToBirthTime(iso) {
  const t = String(iso).split('T')[1] || '';
  return t.slice(0, 8);
}

/* -------------------------------------------------------
 * ✅ Helper: sometimes prediction_html is NULL in DB
 * but response_json has answerHtml
 * ----------------------------------------------------- */
function resolvePredictionHtml(row) {
  if (!row) return null;

  const p = row.prediction_html;
  if (p && String(p).trim()) return String(p).trim();

  const rj = row.response_json || {};
  const fromJson =
    (rj.answerHtml && String(rj.answerHtml).trim()) ||
    (rj.answer_html && String(rj.answer_html).trim()) ||
    null;

  return fromJson;
}

/* -------------------------------------------------------
 * Save RAW birth chart JSON (planets, houses, aspects)
 * ----------------------------------------------------- */
async function upsertBirthChartRaw({
  userEmail,
  birthProfileEmail = null,
  system = 'western',
  houseSystem = 'Placidus',
  provider = 'freeastrologyapi.com',
  iso,
  coords,
  latitude,
  longitude,
  timezoneOffset,
  observationPoint = null,
  ayanamsha = null,
  lang = 'en',
  planetJson,
  houseJson,
  aspectJson,
  statusCode = 200,
  purpose = 'natal',
}) {
  const sql = `
    INSERT INTO public.astro_birth_chart_raw (
      user_id,
      birth_profile_id,
      system,
      house_system,
      ayanamsha,
      provider,
      iso_input,
      coord_str,
      latitude,
      longitude,
      timezone_offset,
      observation_point,
      lang,
      planet_raw_output,
      house_raw_output,
      aspect_raw_output,
      status_code,
      purpose,
      updated_at
    )
    VALUES (
      $1,$2,
      $3,$4,$5,$6,
      $7,$8,$9,$10,$11,$12,$13,
      $14::jsonb,$15::jsonb,$16::jsonb,
      $17,$18,
      now()
    )
    ON CONFLICT (user_id, system, iso_input, coord_str, house_system, lang, provider)
    DO UPDATE SET
      birth_profile_id  = EXCLUDED.birth_profile_id,
      ayanamsha         = EXCLUDED.ayanamsha,
      observation_point = EXCLUDED.observation_point,
      latitude          = EXCLUDED.latitude,
      longitude         = EXCLUDED.longitude,
      timezone_offset   = EXCLUDED.timezone_offset,
      planet_raw_output = EXCLUDED.planet_raw_output,
      house_raw_output  = EXCLUDED.house_raw_output,
      aspect_raw_output = EXCLUDED.aspect_raw_output,
      status_code       = EXCLUDED.status_code,
      purpose           = EXCLUDED.purpose,
      updated_at        = now()
    RETURNING *;
  `;

  const params = [
    String(userEmail),
    birthProfileEmail ? String(birthProfileEmail) : null,
    system,
    houseSystem,
    ayanamsha,
    provider,
    iso,
    coords,
    Number(latitude),
    Number(longitude),
    Number(timezoneOffset),
    observationPoint,
    lang,
    JSON.stringify(planetJson || {}),
    JSON.stringify(houseJson || {}),
    JSON.stringify(aspectJson || {}),
    statusCode,
    purpose,
  ];

  const { rows } = await query(sql, params);
  return rows[0];
}

/* =======================================================
 * POST /api/birthchart/western/birth-chart/raw
 * PURPOSE:
 * 1) Call FreeAstro API (planets, houses, aspects)
 * 2) Save RAW JSON (astro_birth_chart_raw)
 * 3) Build structured birth chart (birth_* tables)
 * 4) ✅ Call interpretation service (prediction) AFTER BUILD
 * 5) ✅ APPEND: return full payload (chart + latest prediction)
 * ===================================================== */
router.post('/western/birth-chart/raw', async (req, res) => {
  const startedAt = Date.now();

  try {
    const {
      userEmail,
      birthProfileEmail,
      iso,
      latitude,
      longitude,
      timezoneOffset,
      lang = 'en',
      houseSystem = 'Placidus',
      observationPoint = null,
      ayanamsha = null,
      purpose = 'natal',
      tone = 'balanced',
    } = req.body || {};

    /* -------------------- Validation -------------------- */
    if (!userEmail) return res.status(400).json({ ok: false, error: 'missing_userEmail' });
    if (!iso) return res.status(400).json({ ok: false, error: 'missing_iso' });
    if (latitude == null || longitude == null) {
      return res.status(400).json({
        ok: false,
        error: 'missing_coordinates',
        message: 'latitude and longitude are required',
      });
    }
    if (timezoneOffset == null) {
      return res.status(400).json({
        ok: false,
        error: 'missing_timezoneOffset',
        message: 'timezoneOffset is required (e.g. 5.5)',
      });
    }

    const coords = normalizeCoords(latitude, longitude);

    /* -------------------- 1) PLANETS -------------------- */
    let planetsResp;
    try {
      const payload = buildWesternPlanetsPayload(iso, coords, lang);
      planetsResp = await callFreeAstro('western/planets', payload);
    } catch (e) {
      return res.status(502).json({
        ok: false,
        error: 'freeastro_planets_failed',
        detail: toErrorDetail(e),
      });
    }

    /* -------------------- 2) HOUSES --------------------- */
    let housesResp;
    try {
      const payload = buildWesternHousesPayload(iso, coords, lang, houseSystem);
      housesResp = await callFreeAstro('western/houses', payload);
    } catch (e) {
      return res.status(502).json({
        ok: false,
        error: 'freeastro_houses_failed',
        detail: toErrorDetail(e),
      });
    }

    /* -------------------- 3) ASPECTS -------------------- */
    let aspectsResp;
    try {
      const payload = buildWesternAspectsPayload(iso, coords, lang, {});
      aspectsResp = await callFreeAstro('western/aspects', payload);
    } catch (e) {
      return res.status(502).json({
        ok: false,
        error: 'freeastro_aspects_failed',
        detail: toErrorDetail(e),
      });
    }

    const statusCode =
      planetsResp?.data?.statusCode ||
      housesResp?.data?.statusCode ||
      aspectsResp?.data?.statusCode ||
      200;

    /* -------------------- 4) SAVE RAW JSON -------------------- */
    const saved = await upsertBirthChartRaw({
      userEmail,
      birthProfileEmail: birthProfileEmail || null,
      system: 'western',
      houseSystem,
      provider: 'freeastrologyapi.com',
      iso,
      coords,
      latitude,
      longitude,
      timezoneOffset,
      observationPoint,
      ayanamsha,
      lang,
      planetJson: planetsResp.data,
      houseJson: housesResp.data,
      aspectJson: aspectsResp.data,
      statusCode,
      purpose,
    });

    /* -------------------- 5) BUILD STRUCTURED CHART -------------------- */
    let buildResult = { ok: false };
    let buildError = null;

    const birthDate = isoToBirthDate(iso);
    const birthTime = isoToBirthTime(iso);

    try {
      await query(
        `CALL sp_birth_generate_chart_from_raw($1, $2, $3, $4);`,
        [String(userEmail), String(iso), String(birthDate), String(birthTime)]
      );
      buildResult = { ok: true };
    } catch (e) {
      console.error('[BirthChart structured build failed]', e);
      buildError = String(e?.message || e);
    }

    /* -------------------- 6) INTERPRETATION (PREDICT) AFTER BUILD -------------------- */
    let interpretation = null;
    let chartId = null; // ✅ keep chartId for next step

    if (buildResult.ok) {
      try {
        const { rows: chartRows } = await query(
          `
          SELECT chart_id
          FROM birth_chart
          WHERE user_id = $1
            AND iso_input = $2
          ORDER BY chart_id DESC
          LIMIT 1
          `,
          [String(userEmail), String(iso)]
        );

        chartId = chartRows.length ? Number(chartRows[0].chart_id) : null;

        if (chartId) {
          interpretation = await predictBirthChart({
            userId: String(userEmail),
            chartId,
            lang: String(lang),
            purpose: String(purpose),
            tone: String(tone),
            sessionId: req.headers['x-session-id'] ? String(req.headers['x-session-id']) : null,
            apiSource: 'service',
          });
        } else {
          interpretation = { ok: false, error: 'chart_id_not_found_after_build' };
        }
      } catch (e) {
        console.error('[BirthChart interpretation failed]', e);
        interpretation = {
          ok: false,
          error: 'interpretation_failed',
          detail: String(e?.message || e),
        };
      }
    } else {
      interpretation = {
        ok: false,
        error: 'skipped_interpretation_build_failed',
        detail: buildError,
      };
    }

    /* ======================================================
     * ✅ 7) APPENDED: After interpretation saved, return FULL payload
     * EXACTLY like GET /western/chart/:chartId/full
     * - Uses chartId from step 6 (no extra logic changes)
     * - BEST EFFORT: if it fails, do not fail the whole API
     * ==================================================== */
    let full = null;

    try {
      if (chartId) {
        const { rows: chartRows2 } = await query(
          `
          SELECT *
          FROM vw_birth_chart_openai_payload
          WHERE chart_id = $1
            AND user_id = $2
          LIMIT 1
          `,
          [Number(chartId), String(userEmail)]
        );

        const chartRow = chartRows2.length ? chartRows2[0] : null;

        const { rows: predRows } = await query(
          `
          SELECT prediction_html, response_json, created_at, prompt_hash
          FROM birth_chart_prediction
          WHERE chart_id = $1
            AND user_id = $2
            AND ($3::text IS NULL OR lang = $3::text)
            AND ($4::text IS NULL OR purpose = $4::text)
            AND ($5::text IS NULL OR tone = $5::text)
          ORDER BY created_at DESC
          LIMIT 1
          `,
          [Number(chartId), String(userEmail), String(lang), String(purpose), String(tone)]
        );

        const predRow = predRows.length ? predRows[0] : null;

        full = {
          chart: chartRow
            ? {
                chartId: chartRow.chart_id,
                userId: chartRow.user_id,
                isoInput: chartRow.iso_input,
                planets: chartRow.planets || [],
                houses: chartRow.houses || [],
                aspects: chartRow.aspects || [],
              }
            : null,
          prediction: {
            lang,
            purpose,
            tone,
            html: resolvePredictionHtml(predRow),
            createdAt: predRow?.created_at || null,
            promptHash: predRow?.prompt_hash || null,
          },
        };
      } else {
        full = {
          ok: false,
          error: 'chart_id_missing_for_full_payload',
        };
      }
    } catch (e) {
      console.error('[BirthChart full payload build failed]', e);
      full = {
        ok: false,
        error: 'full_payload_failed',
        detail: String(e?.message || e),
      };
    }

    /* -------------------- FINAL RESPONSE (NO BREAKING) -------------------- */
    return res.json({
      ok: true,
      message: 'Birth chart raw saved & structured chart generated',
      chartRawId: saved.chart_raw_id,
      userEmail,
      birthProfileEmail: birthProfileEmail || null,
      iso,
      coords,
      birthDate,
      birthTime,
      structuredBuild: buildResult,
      structuredBuildError: buildError,

      // ✅ existing field kept
      interpretation,

      // ✅ appended field (chart + latest prediction)
      full,

      tookMs: Date.now() - startedAt,
    });
  } catch (err) {
    console.error('[BirthChart RAW fatal]', err);
    return res.status(500).json({
      ok: false,
      error: 'birth_chart_generation_failed',
      detail: toErrorDetail(err),
    });
  }
});

/* =======================================================
 * ✅ DOWNLOAD APIs (your existing)
 * ===================================================== */

router.get('/western/chart/:chartId', async (req, res) => {
  try {
    const chartId = Number(req.params.chartId);
    const userId = req.query.userId ? String(req.query.userId) : null;

    if (!chartId || Number.isNaN(chartId)) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_chartId',
        message: 'chartId must be a valid number',
      });
    }

    const { rows } = await query(
      `
      SELECT *
      FROM vw_birth_chart_openai_payload
      WHERE chart_id = $1
        AND ($2::text IS NULL OR user_id = $2::text)
      LIMIT 1
      `,
      [chartId, userId]
    );

    if (!rows.length) {
      return res.status(404).json({
        ok: false,
        error: 'chart_not_found',
        message: 'No chart found for this chartId (and userId if provided)',
      });
    }

    const r = rows[0];

    return res.json({
      ok: true,
      chart: {
        chartId: r.chart_id,
        userId: r.user_id,
        isoInput: r.iso_input,
        planets: r.planets || [],
        houses: r.houses || [],
        aspects: r.aspects || [],
      },
    });
  } catch (err) {
    console.error('[BirthChart download chart error]', err);
    return res.status(500).json({
      ok: false,
      error: 'birth_chart_download_failed',
      detail: err?.message || String(err),
    });
  }
});

router.get('/western/chart/:chartId/full', async (req, res) => {
  try {
    const chartId = Number(req.params.chartId);

    const userId = req.query.userId ? String(req.query.userId) : null;
    const lang = req.query.lang ? String(req.query.lang) : 'en';
    const purpose = req.query.purpose ? String(req.query.purpose) : 'natal';
    const tone = req.query.tone ? String(req.query.tone) : 'balanced';

    if (!chartId || Number.isNaN(chartId)) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_chartId',
        message: 'chartId must be a valid number',
      });
    }

    if (!userId) {
      return res.status(400).json({
        ok: false,
        error: 'missing_userId',
        message: 'userId is required (use query param userId=email)',
      });
    }

    const { rows: chartRows } = await query(
      `
      SELECT *
      FROM vw_birth_chart_openai_payload
      WHERE chart_id = $1
        AND user_id = $2
      LIMIT 1
      `,
      [chartId, userId]
    );

    if (!chartRows.length) {
      return res.status(404).json({
        ok: false,
        error: 'chart_not_found',
        message: 'No chart found for this chartId + userId',
      });
    }

    const chartRow = chartRows[0];

    const { rows: predRows } = await query(
      `
      SELECT prediction_html, response_json, created_at
      FROM birth_chart_prediction
      WHERE chart_id = $1
        AND user_id = $2
        AND ($3::text IS NULL OR lang = $3::text)
        AND ($4::text IS NULL OR purpose = $4::text)
        AND ($5::text IS NULL OR tone = $5::text)
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [chartId, userId, lang, purpose, tone]
    );

    const predRow = predRows.length ? predRows[0] : null;
    const predictionHtml = resolvePredictionHtml(predRow);

    return res.json({
      ok: true,
      chart: {
        chartId: chartRow.chart_id,
        userId: chartRow.user_id,
        isoInput: chartRow.iso_input,
        planets: chartRow.planets || [],
        houses: chartRow.houses || [],
        aspects: chartRow.aspects || [],
      },
      prediction: {
        lang,
        purpose,
        tone,
        html: predictionHtml,
        createdAt: predRow?.created_at || null,
      },
    });
  } catch (err) {
    console.error('[BirthChart download full error]', err);
    return res.status(500).json({
      ok: false,
      error: 'birth_chart_download_full_failed',
      detail: err?.message || String(err),
    });
  }
});

export default router;
