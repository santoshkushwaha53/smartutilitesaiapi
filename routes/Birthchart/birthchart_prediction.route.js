// routes/BirthChart/birthchart_prediction.route.js

import express from 'express';
import OpenAI from 'openai';
import crypto from 'node:crypto';
import { query } from '../../src/db.js';
import { logAiApiCall, newRequestId } from '../../src/services/aiApiLog.service.js';

const router = express.Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * ✅ You can tune these in .env
 * BIRTHCHART_MODEL=gpt-4o-mini
 * BIRTHCHART_MAX_TOKENS=1400
 */
const MODEL = process.env.BIRTHCHART_MODEL || 'gpt-4o-mini';
const MAX_TOKENS = Number(process.env.BIRTHCHART_MAX_TOKENS || 1400);

/**
 * ✅ Helper (APPENDED)
 * Why needed?
 * - Sometimes your DB row has prediction_html = NULL
 * - But response_json may contain the HTML as response_json.answerHtml
 * This prevents cached response from returning prediction:null
 */
function resolveCachedPredictionHtml(row) {
  if (!row) return null;

  // 1) Prefer prediction_html if present
  const p = row.prediction_html;
  if (p && String(p).trim()) return String(p).trim();

  // 2) Fallback: response_json.answerHtml (your save format)
  const rj = row.response_json || {};
  const fromJson =
    (rj.answerHtml && String(rj.answerHtml).trim()) ||
    (rj.answer_html && String(rj.answer_html).trim()) ||
    null;

  return fromJson;
}

/**
 * Make LLM input accurate + small:
 * - keep only main planets + angles
 * - dedupe aspects
 * - keep strongest aspect types first
 */
function optimizeChartForAI(row) {
  const planets = Array.isArray(row.planets) ? row.planets : [];
  const houses = Array.isArray(row.houses) ? row.houses : [];
  const aspects = Array.isArray(row.aspects) ? row.aspects : [];

  const importantPlanets = new Set([
    'Sun', 'Moon', 'Mercury', 'Venus', 'Mars',
    'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto',
    'Ascendant', 'MC', 'IC', 'Descendant'
  ]);

  const filteredPlanets = planets
    .filter(p => importantPlanets.has(String(p.planet)))
    .map(p => ({
      planet: String(p.planet),
      sign: String(p.sign),
      house: p.house ?? null,
      degree: Number(p.degree ?? 0)
    }))
    .sort((a, b) => (a.house ?? 99) - (b.house ?? 99));

  const filteredHouses = houses
    .map(h => ({
      house: Number(h.house),
      sign: String(h.sign),
      degree: Number(h.degree ?? 0)
    }))
    .sort((a, b) => a.house - b.house);

  // rank aspects: these usually matter more for natal overview
  const aspectRank = {
    'Conjunction': 1,
    'Opposition': 2,
    'Square': 3,
    'Trine': 4,
    'Sextile': 5
  };

  const seen = new Set();
  const filteredAspects = aspects
    .map(a => ({
      a: String(a.planet_1),
      b: String(a.planet_2),
      type: String(a.aspect_type)
    }))
    // keep only aspects involving important planets
    .filter(x => importantPlanets.has(x.a) && importantPlanets.has(x.b))
    // dedupe A-B same as B-A for same type
    .filter(x => {
      const key = [x.type, ...[x.a, x.b].sort()].join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    // prioritize strong aspect types
    .sort((x, y) => (aspectRank[x.type] ?? 99) - (aspectRank[y.type] ?? 99));

  return {
    chart_id: row.chart_id,
    user_id: row.user_id,
    iso_input: row.iso_input,
    asc: row.ascendant || null, // if your view provides it
    planets: filteredPlanets,
    houses: filteredHouses,
    aspects: filteredAspects
  };
}

export function buildSystemPrompt({ tone = 'balanced', lang = 'en' }) {
  const persona =
    tone === 'mystical'
      ? `You are "Sohum", a compassionate astrologer guide. You may use gentle spiritual language, but keep it realistic and grounded.`
      : tone === 'practical'
      ? `You are "Maya", a pragmatic astrology coach focused on execution, habits, and measurable progress.`
      : `You are "Oracle", a calm mentor who balances intuition with practicality.`;

  return `
${persona}

You are generating a REALISTIC birth chart interpretation focused on:
- Career & business execution
- Productivity, decision-making, and stress patterns
- Health & wellness habits (non-medical)
- Personal growth with clear next steps

OUTPUT RULES (STRICT):
- Return ONLY a single valid JSON object.
- No markdown. No HTML. No code fences. No extra text.
- Use language: ${lang}.
- Be specific, actionable, and non-generic.
- Avoid fate/destiny claims. Use probability words (tends to, likely, may, watch for).
- Do NOT give medical diagnosis or treatment. Do NOT give guaranteed financial outcomes.

JSON SCHEMA (MUST FOLLOW):
{
  "meta": {
    "lang": "${lang}",
    "tone": "${tone}",
    "purpose": "natal|career|love|health|general",
    "disclaimer": "1 short sentence disclaimer"
  },
  "summary": {
    "headline": "1 sentence",
    "key_points": ["3 short bullets"]
  },
  "career_business": {
    "strengths": ["2 bullets"],
    "risks": ["2 bullets"],
    "actions": ["2 bullets"]
  },
  "wellness": {
    "energy": ["1–2 bullets"],
    "stress": ["1–2 bullets"],
    "habits": ["2 bullets"]
  },
  "planet_insights": [
    {
      "insight": "1–2 sentences",
      "basis": "planet+sign+house | planet+sign",
      "confidence": "high|medium",
      "tags": ["career|money|leadership|focus|stress|health|relationships|growth"]
    }
  ],
  "next_steps": {
    "7_days": ["2 bullets"],
    "30_days": ["2 bullets"]
  },
  "tone_extras": {
    "affirmation": "required when tone=balanced",
    "ritual": "required when tone=mystical",
    "timeline": ["required when tone=practical: 2 short steps with timebox"]
  }
}

TONE REQUIREMENTS:
- If tone="mystical": include "tone_extras.ritual" (1 short, practical ritual; no superstition).
- If tone="balanced": include "tone_extras.affirmation" (1 sentence).
- If tone="practical": include "tone_extras.timeline" (exactly 2 items like "This week: ...", "This month: ...").

STYLE LIMITS:
- Each bullet <= 18 words.
- Total planet_insights: 5 to 7 items.
- If a planet has no house, use basis="planet+sign" and confidence="medium".
- No repetition across sections.

Return the JSON now.
`.trim();
}


function buildUserPrompt({ optimized, purpose = 'natal' }) {
  return [
    `Birth chart purpose: ${purpose}`,
    ``,
    `Chart data (optimized):`,
    JSON.stringify(
      {
        planets: optimized.planets,
        houses: optimized.houses,
        aspects: optimized.aspects
      },
      null,
      2
    ),
    ``,
    `Role:
You are a practical astrology analyst. Your job is to convert a birth chart into realistic, user-relevant guidance focused on career, business decisions, productivity, stress, health routines, and personal growth.

Output format:
- Return ONLY valid JSON.
- No markdown, no explanations, no extra text.

Tone & realism:
- Practical, grounded, non-mystical.
- Avoid generic praise or vague destiny language.
- Use probability words (tends to, likely, watch for).
- Be specific and actionable.
- No medical or financial claims.

Selection rules:
- Use only the 5–7 strongest chart indicators.
- Prioritize Sun, Moon, Ascendant, ruler, Saturn, and key aspects.
- If a planet has no house, interpret by sign only and mark "basis":"sign-only".
- Skip weak or redundant placements.

Content focus (in order):
1) Career & business execution
2) Stress patterns and energy management
3) Health & wellness habits (non-medical)
4) Decision-making style and growth edges

JSON structure (keep fields concise):
{
  "summary": {
    "headline": "1 sentence overview",
    "key_points": ["3 short bullets"]
  },
  "career_business": {
    "strengths": ["2 bullets"],
    "risks": ["2 bullets"],
    "actions": ["2 bullets"]
  },
  "wellness": {
    "energy": ["1–2 bullets"],
    "stress": ["1–2 bullets"],
    "habits": ["2 bullets"]
  },
  "planet_insights": [
    {
      "insight": "1–2 sentences",
      "basis": "planet+sign+house | planet+sign",
      "confidence": "high|medium"
    }
  ],
  "next_steps": {
    "7_days": ["2 bullets"],
    "30_days": ["2 bullets"]
  }
}

Writing rules:
- Each bullet ≤ 18 words.
- No repetition across sections.
- Convert every insight into a behavior or decision pattern.
- Keep total response concise but complete.

Disclaimer:
Include one short disclaimer sentence at the end.
`,
  ].join('\n');
}

/**
 * POST /api/birthchart/western/predict
 * Body:
 * {
 *   "userId": "email@x.com",
 *   "chartId": 123,
 *   "lang": "en",
 *   "purpose": "natal",
 *   "tone": "balanced" // balanced | mystical | practical
 * }
 */
router.post('/western/predict', async (req, res) => {
  // ✅ Start timing + ids for logging (works for both success & failure)
  const startedAt = new Date();
  const startedAtMs = Date.now();

  // You can pass session id from frontend via header: x-session-id: <value>
  const sessionId = req.headers['x-session-id']
    ? String(req.headers['x-session-id'])
    : null;

  // Unique request id for this API call
  const requestId = newRequestId();

  // We'll set these later before logging
  let userIdForLog = null;
  let chartIdForLog = null;

  // We'll capture prompts/payloads for logging
  let systemPrompt = '';
  let userPrompt = '';
  let promptHash = '';
  let promptJson = {};
  let responseJson = {};
  let openaiReqPayload = {};
  let openaiRespPayload = {};

  try {
    const {
      userId,
      chartId,
      lang = 'en',
      purpose = 'natal',
      tone = 'balanced'
    } = req.body || {};

    userIdForLog = userId || null;
    chartIdForLog = chartId || null;

    if (!userId || !chartId) {
      return res.status(400).json({
        ok: false,
        error: 'missing_required_fields',
        message: 'userId and chartId are required'
      });
    }

    /* -------------------------------------------------------
     * 1) Load OpenAI-ready payload from your VIEW
     * ----------------------------------------------------- */
    const { rows } = await query(
      `
      SELECT *
      FROM vw_birth_chart_openai_payload
      WHERE chart_id = $1
        AND user_id = $2
      `,
      [chartId, userId]
    );

    if (!rows.length) {
      return res.status(404).json({
        ok: false,
        error: 'chart_not_found',
        message: 'No chart found for this userId + chartId'
      });
    }

    const optimized = optimizeChartForAI(rows[0]);

    /* -------------------------------------------------------
     * 2) Build prompt + hash (to prevent duplicates)
     * ----------------------------------------------------- */
    systemPrompt = buildSystemPrompt({ tone, lang });
    userPrompt = buildUserPrompt({ optimized, purpose });

    promptHash = crypto
      .createHash('sha256')
      .update(systemPrompt + '\n' + userPrompt)
      .digest('hex');

    /* -------------------------------------------------------
     * 3) If already predicted with same prompt hash, return cached
     * ----------------------------------------------------- */
    const existing = await query(
      `
      SELECT prediction_html, response_json
      FROM birth_chart_prediction
      WHERE chart_id = $1 AND user_id = $2 AND prompt_hash = $3
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [chartId, userId, promptHash]
    );

    if (existing.rows.length) {
      // ✅ FIX (APPENDED): ensure cached prediction is never null if saved in response_json
      const cachedRow = existing.rows[0];
      const cachedHtml = resolveCachedPredictionHtml(cachedRow);

      // ✅ Optional: log "cache hit" too (still useful)
      const endedAt = new Date();
      const executionMs = Date.now() - startedAtMs;

      await logAiApiCall({
        userId,
        sessionId,
        requestId,
        provider: 'openai',
        apiType: 'chat',
        apiSource: 'web',
        endpoint: '/v1/chat/completions',
        model: MODEL,

        promptText: `BirthChart cache-hit (${purpose}) tone=${tone} lang=${lang} chartId=${chartId}`,
        promptTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,

        startedAt,
        endedAt,
        executionMs,

        costUsd: null,
        status: 'success',
        httpStatus: 200,

        requestPayload: { cached: true, promptHash },
        responsePayload: cachedRow?.response_json || {},
        metadata: {
          feature: 'birthchart_prediction',
          cached: true,
          purpose,
          tone,
          lang,
          chartId
        }
      });

      return res.json({
        ok: true,
        cached: true,
        chartId,
        prediction: cachedHtml // ✅ FIX: use resolved html
      });
    }

    /* -------------------------------------------------------
     * 4) Call OpenAI (same style as your AstroChat)
     * ----------------------------------------------------- */
    openaiReqPayload = {
      model: MODEL,
      temperature: 0.8,
      max_tokens: MAX_TOKENS,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    };

    const resp = await openai.chat.completions.create(openaiReqPayload);

    openaiRespPayload = resp;

    const choice = resp.choices?.[0];
    const predictionHtml = (choice?.message?.content || '').trim();

    /* -------------------------------------------------------
     * 5) Save prediction (use your procedure)
     * ----------------------------------------------------- */
    promptJson = {
      systemPrompt,
      userPrompt,
      optimizedChart: optimized
    };

    responseJson = {
      model: MODEL,
      answerHtml: predictionHtml,
      usage: resp.usage || {},
      finishReason: choice?.finish_reason || 'stop'
    };

    // ✅ correct order & correct variables
    await query(
      `CALL public.sp_birth_chart_prediction_upsert(
         $1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9
       );`,
      [
        userId,          // TEXT
        chartId,         // BIGINT
        lang,            // TEXT
        purpose,         // TEXT
        tone,            // TEXT
        MODEL,           // model name
        promptJson,      // JSONB
        responseJson,    // JSONB
        promptHash       // TEXT
      ]
    );

    /* -------------------------------------------------------
     * 6) Mark raw chart as predicted (optional but useful)
     * ----------------------------------------------------- */
    await query(
      `
      UPDATE astro_birth_chart_raw
      SET is_predicted = true,
          updated_at = now()
      WHERE user_id = $1
        AND iso_input = $2
      `,
      [userId, optimized.iso_input]
    );

    /* -------------------------------------------------------
     * 7) ✅ LOG to ai_api_call_log (your common service)
     * ----------------------------------------------------- */
    const endedAt = new Date();
    const executionMs = Date.now() - startedAtMs;

    await logAiApiCall({
      userId,
      sessionId,
      requestId,

      provider: 'openai',
      apiType: 'chat',
      apiSource: 'web',
      endpoint: '/v1/chat/completions',
      model: MODEL,

      // keep this short (don’t store huge prompt text here)
      promptText: `BirthChart(${purpose}) tone=${tone} lang=${lang} chartId=${chartId} promptHash=${promptHash.slice(0, 12)}`,

      promptTokens: resp.usage?.prompt_tokens ?? 0,
      inputTokens: resp.usage?.prompt_tokens ?? 0,
      outputTokens: resp.usage?.completion_tokens ?? 0,
      totalTokens: resp.usage?.total_tokens ?? 0,

      startedAt,
      endedAt,
      executionMs,

      // optional – set if you calculate cost
      costUsd: null,

      status: 'success',
      httpStatus: 200,

      // For audit/debug: save safe payloads
      requestPayload: openaiReqPayload,
      responsePayload: openaiRespPayload,
      metadata: {
        feature: 'birthchart_prediction',
        purpose,
        tone,
        lang,
        chartId,
        promptHash,
        cached: false
      }
    });

    return res.json({
      ok: true,
      cached: false,
      chartId,
      prediction: predictionHtml,
      usage: {
        prompt: resp.usage?.prompt_tokens ?? 0,
        completion: resp.usage?.completion_tokens ?? 0,
        total: resp.usage?.total_tokens ?? 0
      },
      finishReason: choice?.finish_reason || 'stop'
    });
  } catch (err) {
    console.error('[BirthChart Predict Error]', err);

    // ✅ log failures too (so you can debug prod easily)
    try {
      const endedAt = new Date();
      const executionMs = Date.now() - startedAtMs;

      await logAiApiCall({
        userId: userIdForLog || 'unknown',
        sessionId,
        requestId,

        provider: 'openai',
        apiType: 'chat',
        apiSource: 'web',
        endpoint: '/v1/chat/completions',
        model: MODEL,

        promptText: `BirthChart FAILED chartId=${chartIdForLog ?? 'unknown'}`,
        promptTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,

        startedAt,
        endedAt,
        executionMs,

        costUsd: null,
        status: 'failed',
        httpStatus: 500,

        requestPayload: {
          systemPrompt,
          userPrompt,
          promptHash,
          openaiReqPayload
        },
        responsePayload: {
          error: err?.message || String(err),
          stack: err?.stack || null
        },
        metadata: {
          feature: 'birthchart_prediction',
          cached: false
        }
      });
    } catch (logErr) {
      console.error('[BirthChart Predict Error] logAiApiCall failed:', logErr);
    }

    return res.status(500).json({
      ok: false,
      error: 'birth_chart_prediction_failed',
      detail: err?.message || String(err)
    });
  }
});

export default router;
