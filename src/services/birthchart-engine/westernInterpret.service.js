// ==========================================================
// FILE: src/services/birthchart-engine/westernInterpret.service.js
// PURPOSE:
//  - Generate (or reuse cached) Western birth chart interpretation via OpenAI
//  - Save prediction to DB using your SP
//  - ✅ NEW: Generate + store chart_highlights (jsonb) for chat clarifications
//  - Provide a ROUTE-FRIENDLY wrapper: ensureWesternInterpretation()
// ==========================================================

import OpenAI from 'openai';
import crypto from 'node:crypto';
import { query } from '../../db.js';
import { logAiApiCall, newRequestId } from '../../services/aiApiLog.service.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MODEL = process.env.BIRTHCHART_MODEL || 'gpt-4o-mini';
const MAX_TOKENS = Number(process.env.BIRTHCHART_MAX_TOKENS || 1400);

/* ---------------- Utilities (NEW) ---------------- */

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeKey(x) {
  return String(x || '').trim().toLowerCase();
}

/**
 * ✅ Token-friendly chart highlights for follow-up Q&A / chat.
 * Never returns null (always returns an object).
 */
export function chartHighlightsFromOptimized(optimized) {
  const planets = Array.isArray(optimized?.planets) ? optimized.planets : [];
  const houses = Array.isArray(optimized?.houses) ? optimized.houses : [];
  const aspects = Array.isArray(optimized?.aspects) ? optimized.aspects : [];

  const findPlanet = (name) =>
    planets.find(p => normalizeKey(p?.planet) === normalizeKey(name)) || null;

  const pickPlanet = (name) => {
    const p = findPlanet(name);
    if (!p) return null;
    return {
      planet: String(p.planet),
      sign: String(p.sign),
      house: p.house ?? null,
      degree: Number(p.degree ?? 0),
    };
  };

  const getHouseSign = (houseNo) => {
    const h = houses.find(x => Number(x?.house) === Number(houseNo));
    if (!h) return null;
    return { house: Number(h.house), sign: String(h.sign), degree: Number(h.degree ?? 0) };
  };

  // Core placements
  const asc = pickPlanet('Ascendant');
  const mc = pickPlanet('MC');
  const sun = pickPlanet('Sun');
  const moon = pickPlanet('Moon');
  const mercury = pickPlanet('Mercury');
  const venus = pickPlanet('Venus');
  const mars = pickPlanet('Mars');
  const jupiter = pickPlanet('Jupiter');
  const saturn = pickPlanet('Saturn');

  // Basic Asc ruler mapping (good enough for clarifications)
  const rulerBySign = {
    Aries: 'Mars',
    Taurus: 'Venus',
    Gemini: 'Mercury',
    Cancer: 'Moon',
    Leo: 'Sun',
    Virgo: 'Mercury',
    Libra: 'Venus',
    Scorpio: 'Mars',
    Sagittarius: 'Jupiter',
    Capricorn: 'Saturn',
    Aquarius: 'Saturn',
    Pisces: 'Jupiter',
  };

  const ascRulerName = asc?.sign ? rulerBySign[asc.sign] : null;
  const ascRuler = ascRulerName ? pickPlanet(ascRulerName) : null;

  // “Top” aspects (you already rank/sort them in optimizeChartForAI)
  const keyAspects = aspects.slice(0, 8).map(a => ({
    a: String(a.a),
    b: String(a.b),
    type: String(a.type),
  }));

  return {
    debug: {
      chartId: optimized?.chart_id ?? null,
      planetsCount: planets.length,
      housesCount: houses.length,
      aspectsCount: aspects.length,
      hasAsc: !!asc,
      hasSun: !!sun,
      hasMoon: !!moon,
      hasMC: !!mc,
    },

    core: {
      ascendant: asc,
      ascRuler,
      sun,
      moon,
      mc,
    },

    career: {
      house10: getHouseSign(10),
      mc,
      saturn,
      jupiter,
      mercury,
    },

    wellness: {
      house6: getHouseSign(6),
      moon,
      saturn,
      mars,
    },

    keyPlacements: [sun, moon, asc, mc, mercury, venus, mars, jupiter, saturn]
      .filter(Boolean)
      .slice(0, 10),

    keyAspects,
  };
}

/* ✅ Helper: cached prediction html fallback */
export function resolveCachedPredictionHtml(row) {
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

/* ✅ Reduce payload size for LLM */
export function optimizeChartForAI(row) {
  const planets = Array.isArray(row.planets) ? row.planets : [];
  const houses = Array.isArray(row.houses) ? row.houses : [];
  const aspects = Array.isArray(row.aspects) ? row.aspects : [];

  const importantPlanets = new Set([
    'Sun', 'Moon', 'Mercury', 'Venus', 'Mars',
    'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto',
    'Ascendant', 'MC', 'IC', 'Descendant',
  ]);

  const filteredPlanets = planets
    .filter(p => importantPlanets.has(String(p.planet)))
    .map(p => ({
      planet: String(p.planet),
      sign: String(p.sign),
      house: p.house ?? null,
      degree: Number(p.degree ?? 0),
    }))
    .sort((a, b) => (a.house ?? 99) - (b.house ?? 99));

  const filteredHouses = houses
    .map(h => ({
      house: Number(h.house),
      sign: String(h.sign),
      degree: Number(h.degree ?? 0),
    }))
    .sort((a, b) => a.house - b.house);

  const aspectRank = {
    Conjunction: 1,
    Opposition: 2,
    Square: 3,
    Trine: 4,
    Sextile: 5,
  };

  const seen = new Set();
  const filteredAspects = aspects
    .map(a => ({
      a: String(a.planet_1),
      b: String(a.planet_2),
      type: String(a.aspect_type),
    }))
    .filter(x => importantPlanets.has(x.a) && importantPlanets.has(x.b))
    .filter(x => {
      const key = [x.type, ...[x.a, x.b].sort()].join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((x, y) => (aspectRank[x.type] ?? 99) - (aspectRank[y.type] ?? 99));

  return {
    chart_id: row.chart_id,
    user_id: row.user_id,
    iso_input: row.iso_input,
    asc: row.ascendant || null,
    planets: filteredPlanets,
    houses: filteredHouses,
    aspects: filteredAspects,
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

Return the JSON now.
`.trim();
}

export function buildUserPrompt({ optimized, purpose = 'natal' }) {
  return [
    `Birth chart purpose: ${purpose}`,
    ``,
    `Chart data (optimized):`,
    JSON.stringify(
      {
        planets: optimized.planets,
        houses: optimized.houses,
        aspects: optimized.aspects,
      },
      null,
      2
    ),
    ``,
    `Return ONLY valid JSON (no markdown, no extra text).`,
  ].join('\n');
}

/**
 * ✅ MAIN SERVICE FUNCTION
 */
export async function predictBirthChart({
  userId,
  chartId,
  lang = 'en',
  purpose = 'natal',
  tone = 'balanced',
  sessionId = null,
  apiSource = 'service',
}) {
  const startedAt = new Date();
  const startedAtMs = Date.now();
  const requestId = newRequestId();

  let systemPrompt = '';
  let userPrompt = '';
  let promptHash = '';
  let openaiReqPayload = {};
  let openaiRespPayload = {};
  let optimized = null;

  if (!userId || !chartId) {
    return { ok: false, error: 'missing_required_fields', message: 'userId and chartId are required' };
  }

  try {
    /* 1) Load chart payload from VIEW */
    const { rows } = await query(
      `
      SELECT *
      FROM vw_birth_chart_openai_payload
      WHERE chart_id = $1
        AND user_id = $2
      LIMIT 1
      `,
      [chartId, userId]
    );

    if (!rows.length) {
      return { ok: false, error: 'chart_not_found', message: 'No chart found for this userId + chartId' };
    }

    optimized = optimizeChartForAI(rows[0]);

    // ✅ NEW: build chart highlights now (usable even in cache-hit scenario)
    const chartHighlights = chartHighlightsFromOptimized(optimized);

    /* 2) Build prompt + hash */
    systemPrompt = buildSystemPrompt({ tone, lang });
    userPrompt = buildUserPrompt({ optimized, purpose });

    promptHash = crypto
      .createHash('sha256')
      .update(systemPrompt + '\n' + userPrompt)
      .digest('hex');

    /* 3) Cache hit */
    const existing = await query(
      `
      SELECT prediction_html, response_json, chart_highlights
      FROM birth_chart_prediction
      WHERE chart_id = $1 AND user_id = $2 AND prompt_hash = $3
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [chartId, userId, promptHash]
    );

    if (existing.rows.length) {
      const cachedRow = existing.rows[0];
      const cachedHtml = resolveCachedPredictionHtml(cachedRow);

      const endedAt = new Date();
      const executionMs = Date.now() - startedAtMs;

      await logAiApiCall({
        userId,
        sessionId,
        requestId,
        provider: 'openai',
        apiType: 'chat',
        apiSource,
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
        metadata: { feature: 'birthchart_prediction', cached: true, purpose, tone, lang, chartId },
      });

      return { ok: true, cached: true, chartId, prediction: cachedHtml, promptHash };
      // If later you want: return { ... , chartHighlights: cachedRow.chart_highlights ?? cachedRow?.response_json?.chartHighlights ?? null }
    }

    /* 4) Call OpenAI */
    openaiReqPayload = {
      model: MODEL,
      temperature: 0.8,
      max_tokens: MAX_TOKENS,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    };

    const resp = await openai.chat.completions.create(openaiReqPayload);
    openaiRespPayload = resp;

    const choice = resp.choices?.[0];
    const predictionHtml = (choice?.message?.content || '').trim();

    // ✅ NEW: parse json for UI (optional but useful)
    const answerJson = safeParseJson(predictionHtml);

    /* 5) Save prediction (SP) */
    const promptJson = { systemPrompt, userPrompt, optimizedChart: optimized };

    const responseJson = {
      model: MODEL,
      answerHtml: predictionHtml,
      answerText: predictionHtml,

      // ✅ NEW fields for UI + reuse
      answerJson: answerJson,
      chartHighlights: chartHighlights,

      usage: resp.usage || {},
      finishReason: choice?.finish_reason || 'stop',
    };

    // ✅ IMPORTANT: SP SIGNATURE UPDATED (added $10 chart_highlights)
    await query(
      `CALL public.sp_birth_chart_prediction_upsert(
         $1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10::jsonb
       );`,
      [userId, chartId, lang, purpose, tone, MODEL, promptJson, responseJson, promptHash, chartHighlights]
    );

    /* 6) Mark raw predicted */
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

    /* 7) Log */
    const endedAt = new Date();
    const executionMs = Date.now() - startedAtMs;

    await logAiApiCall({
      userId,
      sessionId,
      requestId,
      provider: 'openai',
      apiType: 'chat',
      apiSource,
      endpoint: '/v1/chat/completions',
      model: MODEL,
      promptText: `BirthChart(${purpose}) tone=${tone} lang=${lang} chartId=${chartId} promptHash=${promptHash.slice(0, 12)}`,
      promptTokens: resp.usage?.prompt_tokens ?? 0,
      inputTokens: resp.usage?.prompt_tokens ?? 0,
      outputTokens: resp.usage?.completion_tokens ?? 0,
      totalTokens: resp.usage?.total_tokens ?? 0,
      startedAt,
      endedAt,
      executionMs,
      costUsd: null,
      status: 'success',
      httpStatus: 200,
      requestPayload: openaiReqPayload,
      responsePayload: openaiRespPayload,
      metadata: { feature: 'birthchart_prediction', purpose, tone, lang, chartId, promptHash, cached: false },
    });

    return {
      ok: true,
      cached: false,
      chartId,
      prediction: predictionHtml,
      usage: {
        prompt: resp.usage?.prompt_tokens ?? 0,
        completion: resp.usage?.completion_tokens ?? 0,
        total: resp.usage?.total_tokens ?? 0,
      },
      finishReason: choice?.finish_reason || 'stop',
      promptHash,
    };
  } catch (err) {
    try {
      const endedAt = new Date();
      const executionMs = Date.now() - startedAtMs;

      await logAiApiCall({
        userId: userId || 'unknown',
        sessionId,
        requestId,
        provider: 'openai',
        apiType: 'chat',
        apiSource,
        endpoint: '/v1/chat/completions',
        model: MODEL,
        promptText: `BirthChart FAILED chartId=${chartId ?? 'unknown'}`,
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
        requestPayload: { systemPrompt, userPrompt, promptHash, openaiReqPayload },
        responsePayload: { error: err?.message || String(err), stack: err?.stack || null },
        metadata: { feature: 'birthchart_prediction', cached: false },
      });
    } catch {}
    return { ok: false, error: 'birth_chart_prediction_failed', detail: err?.message || String(err) };
  }
}

/**
 * ✅ ROUTE-FRIENDLY WRAPPER
 */
export async function ensureWesternInterpretation({
  userId,
  chartId,
  lang = 'en',
  purpose = 'natal',
  tone = 'balanced',
  sessionId = null,
}) {
  const r = await predictBirthChart({
    userId,
    chartId,
    lang,
    purpose,
    tone,
    sessionId,
    apiSource: 'web',
  });

  if (!r?.ok) return r;

  return {
    ok: true,
    cached: !!r.cached,
    chartId: r.chartId,
    html: r.prediction || null,
    promptHash: r.promptHash || null,
  };
}
