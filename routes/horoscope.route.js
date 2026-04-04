// routes/horoscope.route.js
import express from 'express';
import path from 'path';
import crypto from 'node:crypto';

import { query } from '../src/db.js';
import { estimateCostUSD } from '../utils/pricing.js';
import { getSetting } from '../src/settings.js';
import { fetchRoutedRawSnapshot } from '../src/providerRouter.js';

import {
  assertRawProviderEnabled,
  assertPredictionProviderEnabled,
} from '../src/apiProviders.js';

// ✅ unified AI service – uses your 10 tables + JSON cache
//    NOTE: writePrediction() is the central AI entrypoint.
//    Horoscope → maybePredict() → writePrediction() → ai-engine → OpenAI.
import { writePrediction } from '../src/services/ai-engine/aiIndex.js';

const ROUTER_VERSION = 'v12.5-personal-raw-hardened';
console.log('[HORO ROUTER LOADED]', {
  file: import.meta?.url || path.resolve('routes/horoscope.route.js'),
  version: ROUTER_VERSION,
});

/* ---------- settings ---------- */
const AI_PREDICTION_ON = await getSetting('ai', 'AI_PREDICTION_ON', true);
const SYSTEM_DEFAULT = await getSetting(
  'provider',
  'HOROSCOPE_SYSTEM_DEFAULT',
  'western'
);
const PK_MODE = await getSetting('provider', 'PROKERALA_MODE', 'sandbox'); // sandbox|live

// 🔁 NEW: toggle to use transit-rule engine (fn_generate_prediction)
const HORO_TRANSIT_ENGINE_ON = await getSetting(
  'ai',
  'HORO_USE_TRANSIT_ENGINE',
  false // default OFF so existing behaviour is unchanged
);

const router = express.Router();

console.log('[HORO CONFIG]', {
  AI_PREDICTION_ON,
  SYSTEM_DEFAULT,
  PK_MODE,
  HORO_TRANSIT_ENGINE_ON,
});

/* ---------- constants ---------- */
const DEFAULT_COORDS = process.env.APP_COORDS || '3.1390,101.6869';
const DEFAULT_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';

// ♈ All signs for bulk generation
const ALL_SIGNS = [
  'aries',
  'taurus',
  'gemini',
  'cancer',
  'leo',
  'virgo',
  'libra',
  'scorpio',
  'sagittarius',
  'capricorn',
  'aquarius',
  'pisces',
];

// 🎯 Default aspects – used only as a fallback if DB query fails / is empty
const MULTI_TOPICS_FALLBACK = [
  'general',
  'love',
  'career',
  'family',
  'health',
  'wellness',
  'money',
  'business',
];

/* ======================================================
 * HELPER UTILITIES (safe JSON, hashing, window, sign-id)
 * ====================================================== */

const safeStringify = (obj) => {
  try {
    return JSON.stringify(obj ?? {});
  } catch {
    return '{"error":"stringify_failed"}';
  }
};

function makeRequestHashSafe(endpoint, params) {
  try {
    const s = `${String(endpoint || '')}::${JSON.stringify(params ?? {})}`;
    return crypto.createHash('sha256').update(s).digest('hex');
  } catch {
    return crypto.randomUUID().replace(/-/g, '');
  }
}

/**
 * Decide the date window (start/end) and ISO datetime for the horoscope.
 * - Handles today / yesterday / weekly / monthly / yearly
 * - Applies Prokerala sandbox override for Vedic (Jan 1, 2025)
 */
function resolveWindow({ period, system, isPersonal, profile, pkMode }) {
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  const sandboxOn = String(pkMode || '').toLowerCase() === 'sandbox';

  const today = new Date();
  let start = new Date(today);
  let end = new Date(today);
  let singleISO = null;

  switch ((period || 'today').toLowerCase()) {
    case 'today':
      singleISO = `${fmt(today)}T10:30:00+08:00`;
      break;
    case 'tomorrow': {
      const t = new Date(today);
      t.setDate(t.getDate() + 1);
      start = t;
      end = t;
      singleISO = `${fmt(t)}T10:30:00+08:00`;
      break;
    }
    case 'yesterday': {
      const y = new Date(today);
      y.setDate(y.getDate() - 1);
      start = y;
      end = y;
      singleISO = `${fmt(y)}T10:30:00+08:00`;
      break;
    }
    case 'weekly': {
      const day = today.getDay();
      const delta = day === 0 ? -6 : 1 - day;
      start = new Date(today);
      start.setDate(today.getDate() + delta);
      end = new Date(start);
      end.setDate(start.getDate() + 6);
      break;
    }
    case 'monthly':
      start = new Date(today.getFullYear(), today.getMonth(), 1);
      end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      break;
    case 'yearly':
      start = new Date(today.getFullYear(), 0, 1);
      end = new Date(today.getFullYear(), 11, 31);
      break;
    default:
      singleISO = `${fmt(today)}T10:30:00+08:00`;
  }

  let iso = singleISO || `${fmt(start)}T10:30:00+08:00`;

  // Personal audience can override datetime from profile
  if (isPersonal && profile?.datetime) {
    iso = profile.datetime;
  }

  // Sandbox override: Prokerala only allows Jan 1
  if (sandboxOn && system?.toLowerCase() === 'vedic') {
    const tzMatch = iso?.match(/([+\-]\d{2}):?(\d{2})$/);
    const tz = tzMatch ? iso.slice(-6) : '+05:30';
    iso = `2025-01-01T10:30:00${tz}`;
    start = end = new Date(`2025-01-01T10:30:00${tz}`);
  }

  return { start: fmt(start), end: fmt(end), singleISO, iso, sandbox: sandboxOn };
}

/**
 * Ensure zodiac_sign row exists, return its id.
 * Used for generic audience header (horoscope_generic).
 */
async function ensureSignId(sign) {
  const code = String(sign || '').toLowerCase().trim();
  let r = await query('SELECT id FROM zodiac_sign WHERE code=$1', [code]);
  if (r.rows.length) return r.rows[0].id;
  r = await query(
    'INSERT INTO zodiac_sign (code) VALUES ($1) ON CONFLICT (code) DO UPDATE SET code=EXCLUDED.code RETURNING id',
    [code]
  );
  return r.rows[0].id;
}

/**
 * Map (system, period) → service_code in app_ai_service_master.
 * This is what the AI engine uses to pick template + model.
 */
function resolveServiceCodeForHoroscope(system, period) {
  const sys = String(system || SYSTEM_DEFAULT).toLowerCase();
  const per = String(period || 'today').toLowerCase();

  if (per === 'today') {
    return sys === 'vedic' ? 'HORO_DAILY_VEDIC' : 'HORO_DAILY_WESTERN';
  }
  if (per === 'weekly') {
    return sys === 'vedic' ? 'HORO_WEEKLY_VEDIC' : 'HORO_WEEKLY_WESTERN';
  }
  // fallback – still safe
  return sys === 'vedic' ? 'HORO_DAILY_VEDIC' : 'HORO_DAILY_WESTERN';
}
/**
 * Load enabled topics from app_topic_master.
 * Falls back to MULTI_TOPICS if table is empty.
 */
async function getEnabledTopicsFromDb() {
  const sql = `
    SELECT topic_code
    FROM app_topic_master
    WHERE is_enabled = true
    ORDER BY sort_order, topic_code
  `;
  const r = await query(sql, []);
  return r.rows.map((row) => row.topic_code);
}


/**
 * NEW: fetch enabled topics from public.app_topic_master.
 * - Uses topic_code
 * - Only rows with is_enabled = true
 * - Ordered by sort_order then topic_code
 * - Falls back to MULTI_TOPICS_FALLBACK if empty or error.
 */
async function getEnabledTopicCodes() {
  try {
    const sql = `
      SELECT topic_code
      FROM app_topic_master
      WHERE is_enabled = true
      ORDER BY sort_order NULLS LAST, topic_code
    `;
    const r = await query(sql, []);
    const codes = r.rows
      .map((row) => String(row.topic_code || '').trim())
      .filter(Boolean);

    if (!codes.length) {
      console.warn(
        '[HORO/TOPICS] app_topic_master returned 0 enabled rows – using fallback topics'
      );
      return MULTI_TOPICS_FALLBACK;
    }

    console.log('[HORO/TOPICS] enabled topics from DB:', codes);
    return codes;
  } catch (err) {
    console.error(
      '[HORO/TOPICS] error reading app_topic_master – using fallback topics',
      err.message
    );
    return MULTI_TOPICS_FALLBACK;
  }
}

/* ======================================================
 * DB WRITES – RAW EVENT + PREDICTIONS
 * ====================================================== */

/**
 * Save personal raw Prokerala payload into astro_raw_event.
 * This is the "source data" that predictions will be based on.
 */
async function insertPersonalRaw({
  system,
  profile_id,
  iso,
  lang,
  endpoint,
  params,
  data,
}) {
  const request_hash = makeRequestHashSafe(endpoint, params);
  const reqParams = safeStringify(params);
  const respJson = safeStringify(data);

  console.log('[RAW/PERSONAL][TRY]', {
    profile_id,
    system,
    iso,
    lang,
    endpoint,
    request_hash,
  });

  const sql = `
    INSERT INTO astro_raw_event
      (sign_id, profile_id, system, calc_type, context_ts, endpoint,
       request_params, response_json, credits_used, lang, request_hash, updated_at)
    VALUES (NULL,$1,$2,'panchang',$3,$4,$5::jsonb,$6::jsonb,NULL,$7,$8,now())
    ON CONFLICT (request_hash) DO UPDATE
      SET response_json = EXCLUDED.response_json,
          updated_at    = now()
    RETURNING *`;

  const vals = [
    profile_id,
    system,
    iso,
    endpoint,
    reqParams,
    respJson,
    lang,
    request_hash,
  ];

  let r;
  try {
    r = await query(sql, vals);
  } catch (e) {
    console.error('[RAW/PERSONAL][INSERT ERR]', e.message);
    throw e;
  }

  let row = r.rows?.[0];
  if (!row || !row.id) {
    console.warn(
      '[RAW/PERSONAL][RETURNING EMPTY] doing lookup by request_hash…',
      request_hash
    );
    const look = await query(
      'SELECT * FROM astro_raw_event WHERE request_hash=$1 ORDER BY updated_at DESC LIMIT 1',
      [request_hash]
    );
    row = look.rows?.[0];
  }

  if (!row || !row.id) {
    console.error(
      '[RAW/PERSONAL][FATAL] could not obtain astro_raw_event row for request_hash',
      request_hash
    );
    throw new Error('failed_to_create_personal_raw_event');
  }

  console.log('[RAW/PERSONAL][OK]', { id: row.id, request_hash });
  return row;
}

/**
 * Save / upsert generic raw snapshot into horoscope_generic
 * (one row per sign + system + period + topic + date).
 */
async function upsertGenericRaw({
  sign_id,
  system,
  period,
  topic,
  lang,
  rawJson,
  modelNameLabel = 'raw-snapshot',
  provider = 'provider',
}) {
  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const valid_from = `${today.getFullYear()}-${pad(
    today.getMonth() + 1
  )}-${pad(today.getDate())}`;

  const up = `
    INSERT INTO horoscope_generic
      (sign_id, system, period, topic, valid_from, lang, provider, model_name, text, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
    ON CONFLICT (sign_id, system, period, topic, valid_from, lang)
    DO UPDATE SET text=EXCLUDED.text, model_name=EXCLUDED.model_name, updated_at=now()
    RETURNING *`;

  const vals = [
    sign_id,
    system,
    period,
    topic,
    valid_from,
    lang,
    provider,
    modelNameLabel,
    JSON.stringify(rawJson ?? {}),
  ];
  const r = await query(up, vals);
  return r.rows[0];
}

/**
 * Save PERSONAL prediction into astro_prediction_user.
 * This is the final AI text the user sees (per profile).
 */
async function saveUserPrediction({
  profile_id,
  raw_event_id,
  system,
  period,
  start,
  end,
  topic,
  lang,
  tone,
  model,
  text,
  usage,
  rawSnapshot,
  aiPayload,
  userPrompt, // ✅ from AI engine
}) {
  const cost = usage ? estimateCostUSD(model, usage) : 0;
  const sql = `
    INSERT INTO astro_prediction_user
      (profile_id, raw_event_id, system, period, period_start, period_end, topic, audience_scope,
       lang, tone, model_provider, model_name, text,
       user_prompt, prompt_tokens, completion_tokens, cost_usd, ai_payload, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'personal',
            $8,$9,'openai',$10,$11,
            $12,$13,$14,$15,$16::jsonb, now())
    RETURNING *`;

  const vals = [
    profile_id,
    raw_event_id,
    system,
    period,
    start,
    end,
    topic,
    lang,
    tone,
    model,
    text,
    userPrompt || null,
    usage?.input_tokens ?? null,
    usage?.output_tokens ?? null,
    cost,
    JSON.stringify(aiPayload || {}),
  ];
  const r = await query(sql, vals);
  return r.rows[0];
}

/**
 * Save GENERIC prediction into astro_prediction.
 * Links to horoscope_generic header (per sign,topic,date).
 */
async function saveGenericPrediction({
  headerId,
  sign_id,
  system,
  period,
  start,
  end,
  topic,
  lang,
  tone,
  model,
  text,
  usage,
  rawSnapshot,
  aiPayload,
  userPrompt, // ✅ from AI engine
}) {
  if (!headerId) {
    throw new Error(
      'saveGenericPrediction: headerId (horoscope_generic.id) is required for generic audience'
    );
  }

  console.log('[GENERIC] inserting prediction with', {
    headerId,
    sign_id,
    system,
    period,
    topic,
  });

  const cost = usage ? estimateCostUSD(model, usage) : 0;

  const sql = `
    INSERT INTO astro_prediction
      (raw_event_id, horoscope_generic_id, sign_id, system,
       period, period_start, period_end, topic, audience_scope,
       lang, tone, model_provider, model_name, text,
       user_prompt, prompt_tokens, completion_tokens, cost_usd,
       raw_snapshot, ai_payload, updated_at)
    VALUES ($1, $1, $2, $3,
            $4, $5, $6, $7, 'generic',
            $8, $9, 'openai', $10, $11,
            $12, $13, $14, $15,
            $16::jsonb, $17::jsonb, now())
    RETURNING *`;

  const vals = [
    headerId,
    sign_id,
    system,
    period,
    start,
    end,
    topic,
    lang,
    tone,
    model,
    text,
    userPrompt || null,
    usage?.input_tokens ?? null,
    usage?.output_tokens ?? null,
    cost,
    safeStringify(rawSnapshot),
    JSON.stringify(aiPayload || {}),
  ];

  const r = await query(sql, vals);
  return r.rows[0];
}

/* ======================================================
 * AI WRAPPER – THIS IS WHERE PREDICTION IS CALLED
 * ======================================================
 *
 * maybePredict() is the SINGLE place that horoscope.route
 * calls into the AI engine:
 *
 *   maybePredict() → writePrediction() → ai-engine → OpenAI
 *
 * This is used from /get (Prokerala + AI) and bulk route.
 */

async function maybePredict({
  aiOn,
  period,
  lang,
  tone,
  rawJson,
  model,
  sign,
  system,
  window,
  callChannel,
  originTag,
  featureId,
  chatScopeId,
  audienceScope,
  topic,
  // NEW: optional array of topics for multi-aspect predictions
  topicsArray,
}) {
  // 🔌 If prediction is off at setting level, skip AI entirely.
  if (!aiOn) {
    return {
      ok: false,
      text: null,
      json: null,
      model,
      usage: null,
      aiPayload: null,
      userPrompt: null,
    };
  }

  try {
    const serviceCode = resolveServiceCodeForHoroscope(system, period);
    const tier = 'free'; // later: derive from user plan / subscription

    console.log('[HORO/maybePredict] calling writePrediction', {
      serviceCode,
      period,
      system,
      topic,
      audienceScope,
      callChannel,
    });

    // ✅ Full payload snapshot of what we send (for debug/audit)
    const aiPayload = {
      serviceCode,
      tier,
      lang,
      tone,
      audience: audienceScope || 'generic',
      system,
      period,
      topic: topic || 'general',
      sign,
      window,
      callChannel,
      originTag,
      featureId,
      chatScopeId,
      rawJson,
    };

    // NEW: choose topics list
    const topicsForAi =
      Array.isArray(topicsArray) && topicsArray.length
        ? topicsArray
        : [topic || 'general'];

    // ⭐ THIS IS THE ACTUAL PREDICTION CALL:
    //    writePrediction → aiIndex → ai-engine → OpenAI Responses API.
    const gen = await writePrediction({
      serviceCode,
      tier,
      lang,
      tone,
      audience: audienceScope || 'generic',
      system,
      period,
      topics: topicsForAi,
      rawJson,
      sign,
      window,
      callChannel,
      originTag,
      featureId,
      chatScopeId,
    });

    // Try to capture the exact user prompt text returned by the engine
    const userPrompt =
      gen?.userPromptText ||
      gen?.userPrompt ||
      gen?.prompt ||
      null;

    return {
      ok: true,
      text: gen?.text || '',
      json: gen?.json ?? null,
      model: gen?.model || model,
      usage: gen?.usage || null,
      aiPayload,
      userPrompt,
    };
  } catch (e) {
    console.error('[HORO/maybePredict] AI error:', e);

    const msg = e?.response?.data
      ? JSON.stringify(e.response.data)
      : e?.message || String(e) || 'prediction_failed';

    // Mark model with "(error)" so you can see it in DB quickly
    return {
      ok: false,
      text: `[AI_ERROR] ${msg}`, // 👈 for easier debugging
      json: null,
      model: `${model} (error)`,
      usage: null,
      aiPayload: null,
      userPrompt: null,
    };
  }
}

/* ======================================================
 * ROUTE #1: /api/horoscope/ai/get
 * PURE AI – NO PROKERALA, ONLY PREDICTION
 * ====================================================== */

router.post('/ai/get', async (req, res) => {
  console.log('[HORO/AI/ENTER]', {
    body: req.body,
  });

  try {
    const {
      system = SYSTEM_DEFAULT,
      period = 'today',
      sign = 'aries',
      tier = 'free',
      lang = 'en',
      tone = 'soft',
      audience = 'generic',
      profileId = null,
      profile = {},
      extraCtx = {},
      rawJson = null, // can pass your own raw data if you want
    } = req.body || {};

    // 🔒 Gate via API Manager for AI provider only (no Prokerala here)
    try {
      await assertPredictionProviderEnabled('openai-oracle', {
        featureId: 'horoscope-ai',
      });
    } catch (cfgErr) {
      console.warn('[HORO/AI] blocked by API Manager:', cfgErr.message);
      return res.status(503).json({
        ok: false,
        error: 'prediction_provider_disabled',
        message: cfgErr.message,
      });
    }

    const serviceCode = resolveServiceCodeForHoroscope(system, period);
    const todayISO = new Date().toISOString().slice(0, 10);
    const window = { start: todayISO, end: todayISO };

    const mergedCtx = {
      sign,
      rashi: sign,
      dateISO: todayISO,
      profileId,
      profile,
      period,
      system,
      ...extraCtx,
    };

    // ⭐ Direct AI call (no Prokerala); still goes through writePrediction.
    const result = await writePrediction({
      serviceCode,
      tier,
      lang,
      tone,
      audience,
      system,
      period,
      topics: ['general'],
      rawJson, // you can pass mergedCtx here later if needed
      sign,
      window,
      callChannel: 'backend',
      originTag: 'horoscope-ai-get',
      featureId: 'horoscope-ai',
      chatScopeId: null,
      // mergedCtx is used inside templates via your cache engine (if needed)
    });

    return res.json({
      ok: true,
      serviceCode,
      modelId: result.model || null,
      responseFormat: 'json',
      payload: result.json ?? null,
      textFallback: result.text || null,
      usedPrompts: result.usedPromptCodes || null,
      rawMeta: {
        provider: result.providerCode || null,
        schemaCode: result.schemaCode || null,
      },
    });
  } catch (e) {
    console.error('[HORO/AI/ERROR]', e);
    return res.status(500).json({
      ok: false,
      error: e.message || 'ai_get_failed',
    });
  }
});

/* ======================================================
 * ROUTE #2: /api/horoscope/get
 * FULL PIPELINE = PROKERALA RAW + AI PREDICTION + DB SAVE
 * ====================================================== */

router.post('/get', async (req, res) => {
  console.log('[HORO/ENTER]', ROUTER_VERSION, {
    audience: req.body?.audience,
    sign: req.body?.sign,
    system: req.body?.system,
    period: req.body?.period,
  });

  try {
    res.set('X-Horo-Version', ROUTER_VERSION);

    const {
      audience = 'generic',
      sign = 'aries',
      system = SYSTEM_DEFAULT,
      period = 'today',
      topics = ['general'],
      lang = 'en',
      tone = 'concise',
      profileId = null,
      profile = {},
    } = req.body || {};

    const isPersonal = audience === 'personal';
    const isGeneric = audience === 'generic';

    if (!isPersonal && !isGeneric) {
      return res
        .status(400)
        .json({ error: "audience must be either 'personal' or 'generic'" });
    }
    if (isPersonal && !profileId) {
      return res
        .status(400)
        .json({ error: "profileId is required for audience='personal'" });
    }

    const win = resolveWindow({
      period,
      system,
      isPersonal,
      profile,
      pkMode: PK_MODE,
    });

    let { start, end } = win;
    let iso = profile?.datetime
      ? profile.datetime
      : win.singleISO || `${start}T10:30:00+08:00`;

    const sign_id = await ensureSignId(sign);
    const coords = profile?.coordinates || DEFAULT_COORDS;

    console.log('[HORO/PARAMS]', { period, lang, tone, coords, iso });

    /* -----------------------------------------------
     * STEP A: RAW HOROSCOPE API CALL (PROKERALA)
     * -----------------------------------------------
     * - Uses fetchRoutedRawSnapshot()
     * - Writes into astro_raw_event (personal) or
     *   horoscope_generic (generic).
     */

    const feature =
      String(system).toLowerCase() === 'vedic'
        ? 'raw_panchang'
        : 'horoscope_prediction';

    // 🔒 Gate raw provider before calling Prokerala
    try {
      await assertRawProviderEnabled('prokerala-astro', {
        featureId: 'daily-horoscope',
      });
    } catch (cfgErr) {
      console.warn('[HORO/RAW] blocked by API Manager:', cfgErr.message);
      return res.status(503).json({
        error: 'raw_provider_disabled',
        message: cfgErr.message,
      });
    }

    const prov = await fetchRoutedRawSnapshot({
      feature,
      system,
      period,
      topic: topics[0],
      iso,
      lang,
      coords,
      sign,
    });

    console.log('[HORO/RAW]', {
      provider: prov.provider,
      ok: prov.ok,
      status: prov.status,
      endpoint: prov.endpoint,
    });

    if (!prov.ok) {
      return res.status(prov.status || 400).json({
        error: 'provider_error',
        provider: prov.provider,
        endpoint: prov.endpoint,
        params: prov.params,
        body: prov.data,
      });
    }

    // Raw bundle is what will be used as "rawJson" input for prediction (fallback).
    const rawBundle = [{ date: iso, data: prov.data }];

    let personal_raw_id = null;
    const headerIdsByTopic = {};

    // PERSONAL = store astro_raw_event row
    if (isPersonal) {
      console.log('[HORO/PERSONAL] insert astro_raw_event');
      const rawRow = await insertPersonalRaw({
        system,
        profile_id: profileId,
        iso,
        lang,
        endpoint: prov.endpoint,
        params: prov.params,
        data: prov.data,
      });
      personal_raw_id = rawRow.id;
      console.log('[HORO/PERSONAL] raw_event_id=', personal_raw_id);
    } else {
      // GENERIC = upsert horoscope_generic header per topic
      console.log('[HORO/GENERIC] upsert horoscope_generic');
      for (const topic of topics) {
        const cacheRow = await upsertGenericRaw({
          sign_id,
          system,
          period,
          topic,
          lang,
          rawJson: prov.data,
          modelNameLabel: prov.ok
            ? prov.provider || 'raw-snapshot'
            : 'raw-error',
          provider: prov.provider || 'provider',
        });
        if (!cacheRow?.id) {
          console.error(
            '[GENERIC] upsertGenericRaw returned no id for topic',
            topic,
            cacheRow
          );
          return res.status(500).json({
            error: `failed to create header (horoscope_generic) for ${topic}`,
          });
        }
        headerIdsByTopic[topic] = cacheRow.id;
      }
    }

    /* -----------------------------------------------
     * NEW: STEP A2 – OPTIONAL TRANSIT ENGINE PAYLOAD
     * -----------------------------------------------
     * If HORO_TRANSIT_ENGINE_ON is true, call fn_generate_prediction()
     * once for the window and sign, and use that JSON as rawJson for AI.
     * If it fails or returns null, we simply fall back to rawBundle.
     */

    let transitEnginePayload = null;
    if (HORO_TRANSIT_ENGINE_ON) {
      try {
        console.log('[HORO/TRANSIT] using fn_generate_prediction()', {
          system,
          sign,
          period,
          start,
          end,
          profileId,
        });

        const sql =
          'SELECT fn_generate_prediction($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7,$8) AS payload';
        const vals = [
          system,
          String(sign || '').toLowerCase(),
          profileId || null, // not used yet inside function
          period,
          `${start} 00:00:00+08`,
          `${end} 23:59:59+08`,
          tone,
          topics,
        ];

        const r = await query(sql, vals);
        transitEnginePayload = r.rows?.[0]?.payload || null;

        if (!transitEnginePayload) {
          console.warn(
            '[HORO/TRANSIT] fn_generate_prediction returned NULL – falling back to Prokerala raw bundle'
          );
        }
      } catch (err) {
        console.error(
          '[HORO/TRANSIT] fn_generate_prediction error – falling back to Prokerala raw bundle',
          err
        );
      }
    }

    /* -----------------------------------------------
     * STEP B: AI PREDICTION CALL (OPENAI via ai-engine)
     * -----------------------------------------------
     * - Controlled by AI_PREDICTION_ON + API Manager
     * - Uses maybePredict() → writePrediction()
     * - Writes into astro_prediction / astro_prediction_user
     */

    if (AI_PREDICTION_ON) {
      try {
        await assertPredictionProviderEnabled('openai-oracle', {
          featureId: 'daily-horoscope',
        });
      } catch (cfgErr) {
        console.warn('[HORO/PREDICT] blocked by API Manager:', cfgErr.message);
        return res.status(503).json({
          error: 'prediction_provider_disabled',
          message: cfgErr.message,
        });
      }
    }

    const results = {};
    const featureId =
      period === 'weekly' ? 'weekly-horoscope' : 'daily-horoscope';
    const callChannel = isGeneric ? 'backend' : 'user';

    for (const topic of topics) {
      // ✅ Decide which rawJson to send to AI:
      //    - If transit engine is ON and payload exists, use it.
      //    - Otherwise, use original Prokerala bundle.
      const rawJsonPayload =
        HORO_TRANSIT_ENGINE_ON && transitEnginePayload
          ? {
              // transit JSON already includes system/sign/period/window/meta/events/stats
              ...transitEnginePayload,
              topic,
              source: 'transit_engine', // helpful trace for templates
            }
          : {
              bundle: rawBundle,
              system,
              period,
              start,
              end,
              sign,
              topic,
              mode: isPersonal ? 'personal' : 'generic',
              source: 'prokerala_raw',
            };

      const pred = await maybePredict({
        aiOn: AI_PREDICTION_ON,
        period,
        lang,
        tone,
        rawJson: rawJsonPayload,
        model: DEFAULT_MODEL,
        sign,
        system,
        window: { start, end },
        callChannel,
        originTag: isPersonal
          ? 'horoscope-get-personal'
          : 'horoscope-get-generic',
        featureId,
        chatScopeId: null,
        audienceScope: isPersonal ? 'personal' : 'generic',
        topic,
      });

      // If AI failed, fall back to raw JSON text
      // AFTER – surface AI error when it exists
      const finalText = pred.ok
        ? pred.text
        : pred.text // if we have [AI_ERROR] ... use it
        ? pred.text
        : safeStringify(prov.data);

      const finalModel = pred.ok
        ? pred.model
        : pred.model // will be "<model> (error)"
        ? pred.model
        : DEFAULT_MODEL;

      const finalJson = pred.ok ? pred.json ?? null : null;

      console.log('[HORO/FINAL]', { topic, finalModel, predOk: pred.ok });

      if (isPersonal) {
        // PERSONAL: write astro_prediction_user
        const row = await saveUserPrediction({
          profile_id: profileId,
          raw_event_id: personal_raw_id,
          system,
          period,
          start,
          end,
          topic,
          lang,
          tone,
          model: finalModel,
          text: finalText,
          usage: pred.usage,
          rawSnapshot: prov.data,
          aiPayload: pred.aiPayload || null,
          userPrompt: pred.userPrompt || null,
        });
        results[topic] = {
          id: row.id,
          text: finalText,
          json: finalJson,
          model: finalModel,
          scope: 'personal',
        };
      } else {
        // GENERIC: write astro_prediction + link to horoscope_generic
        const headerId = headerIdsByTopic[topic];
        if (!headerId) {
          console.error('[GENERIC] missing headerId for topic', topic);
          return res.status(500).json({
            error: `internal: missing header id for ${topic}`,
          });
        }
        const row = await saveGenericPrediction({
          headerId,
          sign_id,
          system,
          period,
          start,
          end,
          topic,
          lang,
          tone,
          model: finalModel,
          text: finalText,
          usage: pred.usage,
          rawSnapshot: prov.data,
          aiPayload: pred.aiPayload || null,
          userPrompt: pred.userPrompt || null,
        });
        results[topic] = {
          id: row.id,
          text: finalText,
          json: finalJson,
          model: finalModel,
          scope: 'generic',
        };
      }
    }

    // Final JSON payload back to client
    const payload = {
      audience,
      system,
      sign,
      sign_id,
      period,
      start,
      end,
      topics,
      provider: prov.provider,
      results,
      ...(isPersonal ? { raw_event_id: personal_raw_id } : {}),
    };
    return res.json(payload);
  } catch (e) {
    console.error('horoscope/get error', e);
    return res.status(500).json({ error: e.message || 'failed' });
  }
});

/* ======================================================
 * ROUTE #3: /api/horoscope/bulk/generate
 * Multi-aspect, all-signs generator (generic audience)
 * - For a given system + period, loops all 12 signs
 * - For each sign:
 *    • builds rawJson (transit engine OR Prokerala)
 *    • calls AI once with topics from app_topic_master
 *    • stores full multi-aspect JSON into horoscope_generic
 *      using topic = 'multi_aspects'
 *    • ALSO writes one row into astro_prediction with topic='multi_aspects'
 * - Result: up to 12 rows (one per sign) per day/period.
 * ====================================================== */

router.post('/bulk/generate', async (req, res) => {
  console.log('[HORO/BULK/ENTER]', ROUTER_VERSION, {
    system: req.body?.system,
    period: req.body?.period,
  });

  try {
    res.set('X-Horo-Version', ROUTER_VERSION);

    const {
      system = SYSTEM_DEFAULT,
      period = 'today',
      lang = 'en',
      tone = 'concise',
    } = req.body || {};

    const audience = 'generic';
    const isPersonal = false;

    // Use one window for all signs
    const win = resolveWindow({
      period,
      system,
      isPersonal,
      profile: {},
      pkMode: PK_MODE,
    });

    let { start, end } = win;
    const iso = win.singleISO || `${start}T10:30:00+08:00`;
   // 🔥 NEW: topics from app_topic_master
    const topicsFromDb = await getEnabledTopicsFromDb();
    const topicsForAi =
      Array.isArray(topicsFromDb) && topicsFromDb.length
        ? topicsFromDb
        : MULTI_TOPICS;
    console.log('[HORO/BULK/PARAMS]', { period, lang, tone, start, end, iso });

    // 🔄 Load enabled topics from DB (or fallback)
    const enabledTopics = await getEnabledTopicCodes();

    const feature =
      String(system).toLowerCase() === 'vedic'
        ? 'raw_panchang'
        : 'horoscope_prediction';

    // 🔒 Check providers once
    try {
      await assertRawProviderEnabled('prokerala-astro', {
        featureId: 'daily-horoscope',
      });
    } catch (cfgErr) {
      console.warn('[HORO/BULK/RAW] blocked by API Manager:', cfgErr.message);
      return res.status(503).json({
        error: 'raw_provider_disabled',
        message: cfgErr.message,
      });
    }

    if (AI_PREDICTION_ON) {
      try {
        await assertPredictionProviderEnabled('openai-oracle', {
          featureId:
            period === 'weekly' ? 'weekly-horoscope-bulk' : 'daily-horoscope-bulk',
        });
      } catch (cfgErr) {
        console.warn('[HORO/BULK/PREDICT] blocked by API Manager:', cfgErr.message);
        return res.status(503).json({
          error: 'prediction_provider_disabled',
          message: cfgErr.message,
        });
      }
    }

    const featureId =
      period === 'weekly'
        ? 'weekly-horoscope-bulk'
        : period === 'monthly'
        ? 'monthly-horoscope-bulk'
        : period === 'yearly'
        ? 'yearly-horoscope-bulk'
        : 'daily-horoscope-bulk';

    const resultsBySign = {};

    for (const sign of ALL_SIGNS) {
      const sign_id = await ensureSignId(sign);

      // 1) Fetch Prokerala raw for this sign
      const prov = await fetchRoutedRawSnapshot({
        feature,
        system,
        period,
        topic: 'general',
        iso,
        lang,
        coords: DEFAULT_COORDS,
        sign,
      });

      console.log('[HORO/BULK/RAW]', {
        sign,
        provider: prov.provider,
        ok: prov.ok,
        status: prov.status,
      });

      if (!prov.ok) {
        resultsBySign[sign] = {
          ok: false,
          error: 'provider_error',
          status: prov.status || 400,
        };
        continue;
      }

      const rawBundle = [{ date: iso, data: prov.data }];

      // 2) (optional) Transit engine payload
      let transitEnginePayload = null;
      if (HORO_TRANSIT_ENGINE_ON) {
        try {
          console.log('[HORO/BULK/TRANSIT] fn_generate_prediction()', {
            system,
            sign,
            period,
            start,
            end,
          });

          const sql =
            'SELECT fn_generate_prediction($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7,$8) AS payload';
          const vals = [
            system,
            String(sign || '').toLowerCase(),
            null, // profile_id not used in engine now
            period,
            `${start} 00:00:00+08`,
            `${end} 23:59:59+08`,
            tone,
            enabledTopics, // 👈 use DB topics here
          ];

          const r = await query(sql, vals);
          transitEnginePayload = r.rows?.[0]?.payload || null;

          if (!transitEnginePayload) {
            console.warn(
              '[HORO/BULK/TRANSIT] fn_generate_prediction returned NULL – falling back to Prokerala raw bundle for sign',
              sign
            );
          }
        } catch (err) {
          console.error(
            '[HORO/BULK/TRANSIT] fn_generate_prediction error – falling back to Prokerala raw bundle for sign',
            sign,
            err
          );
        }
      }
debugger;
      // Decide which rawJson to send to AI:
      // - If transit engine is ON and payload exists, use it.
      // - Otherwise, use original Prokerala bundle.
      const rawJsonPayload =
        HORO_TRANSIT_ENGINE_ON && transitEnginePayload
          ? {
              ...transitEnginePayload,
              source: 'transit_engine',
              topics: enabledTopics,
            }
          : {
              bundle: rawBundle,
              system,
              period,
              start,
              end,
              sign,
              mode: 'generic',
              source: 'prokerala_raw',
              topics: enabledTopics,
            };
debugger;
      // 3) AI prediction once per sign with all aspects
      const pred = await maybePredict({
        aiOn: AI_PREDICTION_ON,
        period,
        lang,
        tone,
        rawJson: rawJsonPayload,
        model: DEFAULT_MODEL,
        sign,
        system,
        window: { start, end },
        callChannel: 'backend',
        originTag: 'horoscope-bulk-generate',
        featureId,
        chatScopeId: null,
        audienceScope: 'generic',
        topic: 'multi', // label for this combined prediction
        topicsArray: topicsForAi, // 👈 ALL enabled topics
      });

      const finalModel = pred.ok
        ? pred.model
        : pred.model
        ? pred.model
        : DEFAULT_MODEL;

      const finalJson = pred.ok ? pred.json ?? null : null;

      // 4) Store ONE row per sign into horoscope_generic with topic = 'multi_aspects'
      //    text column will contain the full JSON (all aspects)
      let headerRow = null;
      try {
        headerRow = await upsertGenericRaw({
          sign_id,
          system,
          period,
          topic: 'multi_aspects',
          lang,
          rawJson: {
            system,
            period,
            sign,
            start,
            end,
            topics: topicsForAi,
            aspects: finalJson?.aspects || null,
            summary: finalJson?.summary || pred.text || null,
            rawSource: rawJsonPayload?.source || null,
            model: finalModel,
          },
          modelNameLabel: finalModel,
          provider: pred.ok ? 'ai-engine' : prov.provider || 'provider',
        });
      } catch (e) {
        console.error(
          '[HORO/BULK/UPSERT_ERR] failed for sign',
          sign,
          e.message
        );
      }

      // 5) ALSO write a row into astro_prediction (generic) linked to that header
      if (headerRow?.id && pred.ok) {
        try {
          await saveGenericPrediction({
            headerId: headerRow.id,
            sign_id,
            system,
            period,
            start,
            end,
            topic: 'multi_aspects',
            lang,
            tone,
            model: finalModel,
            text: finalJson?.summary || pred.text || null,
            usage: pred.usage,
            rawSnapshot: rawJsonPayload,
            aiPayload: pred.aiPayload || null,
            userPrompt: pred.userPrompt || null,
          });
        } catch (e) {
          console.error(
            '[HORO/BULK/saveGenericPrediction_ERR] failed for sign',
            sign,
            e.message
          );
        }
      }

      resultsBySign[sign] = {
        ok: pred.ok,
        model: finalModel,
        provider: pred.ok ? 'ai-engine' : prov.provider,
        summary: finalJson?.summary || pred.text || null,
        aspects: finalJson?.aspects || null,
      };
    }

    return res.json({
      ok: true,
      system,
      period,
      audience,
      start,
      end,
      topics: ['multi_aspects'],
      signs: resultsBySign, // { leo: {aspects:{...}}, aries: {...}, ...}
    });
  } catch (e) {
    console.error('[HORO/BULK/ERROR]', e);
    return res.status(500).json({ ok: false, error: e.message || 'failed' });
  }
});

/* ---------- tiny debug endpoints ---------- */
router.get('/_diag/fingerprint', (_req, res) => {
  res.json({
    ok: true,
    where: 'horoscope.route.js',
    version: ROUTER_VERSION,
    file: import.meta?.url || 'unknown',
  });
});

router.get('/_diag/last-raw', async (req, res) => {
  try {
    const profileId = req.query.profileId;
    if (!profileId)
      return res
        .status(400)
        .json({ ok: false, error: 'profileId required' });
    const r = await query(
      `SELECT id, profile_id, system, calc_type, context_ts, endpoint, lang, request_hash, updated_at
         FROM astro_raw_event
        WHERE profile_id = $1
        ORDER BY updated_at DESC
        LIMIT 10`,
      [profileId]
    );
    res.json({ ok: true, rows: r.rows, count: r.rowCount });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
