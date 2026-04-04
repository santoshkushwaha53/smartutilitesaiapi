// routes/ai.batch.route.js
// -----------------------------------------------------------------------------
// Purpose:
// - Legacy single-batch:      POST /predict/pending
// - Structured single run:    POST /predict/generate
// - Bulk (money-safe):        POST /predict/pending/all     (NO period filter)
// - Quick peek:               GET  /predict/pending/_peek   (counts pending)
// - Route list:               GET  /_routes
//
// Notes:
// - Bulk runner uses each row's own period/lang/system (no period filter).
// - On success, flips is_ai_predicted='Y' and updates updated_at.
// - Adds a progress guard to avoid infinite retry loops on errors.
// -----------------------------------------------------------------------------

import express from "express";
import OpenAI from "openai";
import pool from "../src/db.js";
import { buildLLMInputFromText } from "../utils/horoscope-prep.js";

console.log("[ai.batch.route] loaded");

const router = express.Router();

// --- Router-level logger ----------------------------------------------------
router.use((req, _res, next) => {
  console.log("[AI ROUTER]", req.method, req.originalUrl);
  next();
});

// --- OpenAI client ----------------------------------------------------------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Pricing (USD per 1M tokens) -------------------------------------------
const INPUT_RATE  = Number(process.env.OPENAI_INPUT_RATE_USD_PER_MTOK ?? "0.15");
const OUTPUT_RATE = Number(process.env.OPENAI_OUTPUT_RATE_USD_PER_MTOK ?? "0.60");

// ---- schema config ---------------------------------------------------------
const SRC_TABLE  = "horoscope_generic";
const DST_TABLE  = "astro_prediction";
const SRC_ID_COL = "id";
const DST_FK_COL = "raw_event_id";

// ---- helpers ---------------------------------------------------------------

function estimateCostUSD(usage) {
  const inTok  = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0);
  const outTok = Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0);
  const usd = (inTok * INPUT_RATE + outTok * OUTPUT_RATE) / 1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}

async function upsertPredictionByFk(client, payload) {
  const {
    srcId, text, period, lang, modelName,
    promptTokens = null, completionTokens = null, costUSD = null
  } = payload;

  const upd = await client.query(
    `UPDATE public.${DST_TABLE}
        SET text = $2, period = $3, lang = $4,
            model_provider = 'openai', model_name = $5,
            prompt_tokens = COALESCE($6, prompt_tokens),
            completion_tokens = COALESCE($7, completion_tokens),
            cost_usd = COALESCE($8, cost_usd),
            updated_at = now()
      WHERE ${DST_FK_COL} = $1`,
    [srcId, text, period, lang, modelName, promptTokens, completionTokens, costUSD]
  );
  if (upd.rowCount > 0) return "updated";

  await client.query(
    `INSERT INTO public.${DST_TABLE}
      (${DST_FK_COL}, text, period, lang, model_provider, model_name,
       prompt_tokens, completion_tokens, cost_usd, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'openai', $5, $6, $7, $8, now(), now())`,
    [srcId, text, period, lang, modelName, promptTokens, completionTokens, costUSD]
  );
  return "inserted";
}

function safeParseMaybeTwice(x) {
  let s = x;
  if (Buffer.isBuffer(s)) s = s.toString("utf8");
  if (typeof s !== "string") return s;
  try {
    const once = JSON.parse(s);
    if (typeof once === "string") {
      try { return JSON.parse(once); } catch { return once; }
    }
    return once;
  } catch {
    return s;
  }
}

function sanitizeLLM(content) {
  if (typeof content !== 'string') return content;
  let s = content.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  s = s.replace(/<\/?[^>]+>/g, '');
  const first = s.indexOf('{'); const last = s.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) s = s.slice(first, last + 1);
  return s;
}

// ---------- HARD-RULES prompt (kept as you had) -----------------------------

const ALL_SIGNS = [
  "aries","taurus","gemini","cancer","leo","virgo",
  "libra","scorpio","sagittarius","capricorn","aquarius","pisces"
];

const WORD_LIMITS = {
  yesterday: [100,150],
  today:     [100,150],
  tomorrow:  [100,150],
  weekly:    [150,200],
  monthly:   [200,250],
  yearly:    [250,300],
  other:     [100,150]
};

function buildHardRulesPrompt({
  periods, system, lang, tone,
  planet_status, planet_movements
}) {
  const PERIODS = Array.isArray(periods) && periods.length ? periods.map(String) : [];
  const CATS = ["general","love","family","career","wealth","health","wellness","luck"];

  const WORD_LIMITS = {
    yesterday:[100,150], today:[100,150], today:[100,150], tomorrow:[100,150],
    weekly:[150,200], monthly:[200,250], yearly:[250,300], other:[100,150]
  };

  const systemMsg = [
    "You are an expert Western astrologer and structured-data generator.",
    "Return JSON ONLY. No commentary. Use second person (“you”). Tone: practical, supportive, non-fatalistic.",
    "HARD RULES:",
    "1) Use EXACT period names provided; keep one uniform object shape for all periods.",
    "2) Always include ALL 12 signs as lowercase keys.",
    "3) For each sign include movements:{since_yesterday[],into_tomorrow[]} derived from global planet_movements:",
    "   include items whose current sign equals this sign OR whose sign_change→to_sign equals this sign.",
    "   Each item: {body, delta_deg|null, sign_change, to_sign, retro_flip}. If none, [].",
    "4) For EVERY requested period, add an `influences` array listing planetary impacts on this sign for that period.",
    "   Each influence item: {body, sign, degree, retrograde, positive, negative, solutions, focus, avoid}.",
    "5) For EVERY requested period and EACH category (general,love,family,career,wealth,health,wellness,luck) include:",
    "   {score_percent:int 0..100, summary, positive, negative, solutions, tips[2–4], do[3–6], dont[3–6], lucky_color:nonempty, lucky_number:int 1..99}.",
    "6) Summary word caps: yesterday/today/today/tomorrow 100–150; weekly 150–200; monthly 200–250; yearly 250–300.",
    "   If longer, shorten—do not omit detail. No emojis. No medical/financial guarantees.",
    "7) Period specials:",
    "   weekly.special = {weekly_lucky_day};",
    "   monthly.special = {monthly_lucky_day:int};",
    "   yearly.special  = {yearly_lucky_months[], best_overall_advice, month_breakdown:{",
    "     Jan..Dec: {career,love,wealth,health,family,wellness,social,luck, highlight:boolean}}}.",
    "8) If planet data is missing, still produce predictions; movements/influences may be empty.",
    "9) VALID JSON ONLY—match SCHEMA. No extra keys. No nulls—use empty strings/arrays."
  ].join(" ");

  // Minimal schema exemplar…
  const schema = {
    system, lang, periods: PERIODS,
    planet_status: [{"body":"","sign":"","degree":0,"retrograde":false,"note":""}],
    planet_movements: {
      since_yesterday: [{"body":"","delta_deg":0,"sign_change":false,"to_sign":"","retro_flip":false}],
      into_tomorrow:   [{"body":"","delta_deg":0,"sign_change":false,"to_sign":"","retro_flip":false}]
    },
    signs: {
      "aries": {
        movements: { since_yesterday:[], into_tomorrow:[] },
        periods: {
          "<period>": {
            influences: [
              { "body":"", "sign":"", "degree":0, "retrograde":false,
                "positive":"", "negative":"", "solutions":"", "focus":"", "avoid":"" }
            ],
            special: {
              weekly_lucky_day: "",
              monthly_lucky_day: 0,
              yearly_lucky_months: [],
              best_overall_advice: "",
              month_breakdown: {
                "January":  {career:"",love:"",wealth:"",health:"",family:"",wellness:"",social:"",luck:"",highlight:false},
                "February": {career:"",love:"",wealth:"",health:"",family:"",wellness:"",social:"",luck:"",highlight:false},
                "March":    {career:"",love:"",wealth:"",health:"",family:"",wellness:"",social:"",luck:"",highlight:false},
                "April":    {career:"",love:"",wealth:"",health:"",family:"",wellness:"",social:"",luck:"",highlight:false},
                "May":      {career:"",love:"",wealth:"",health:"",family:"",wellness:"",social:"",luck:"",highlight:false},
                "June":     {career:"",love:"",wealth:"",health:"",family:"",wellness:"",social:"",luck:"",highlight:false},
                "July":     {career:"",love:"",wealth:"",health:"",family:"",wellness:"",social:"",luck:"",highlight:false},
                "August":   {career:"",love:"",wealth:"",health:"",family:"",wellness:"",social:"",luck:"",highlight:false},
                "September":{career:"",love:"",wealth:"",health:"",family:"",wellness:"",social:"",luck:"",highlight:false},
                "October":  {career:"",love:"",wealth:"",health:"",family:"",wellness:"",social:"",luck:"",highlight:false},
                "November": {career:"",love:"",wealth:"",health:"",family:"",wellness:"",social:"",luck:"",highlight:false},
                "December": {career:"",love:"",wealth:"",health:"",family:"",wellness:"",social:"",luck:"",highlight:false}
              }
            },
            categories: {
              general:  { score_percent:0, summary:"", positive:"", negative:"", solutions:"", tips:[], do:[], dont:[], lucky_color:"", lucky_number:0 },
              love:     { score_percent:0, summary:"", positive:"", negative:"", solutions:"", tips:[], do:[], dont:[], lucky_color:"", lucky_number:0 },
              family:   { score_percent:0, summary:"", positive:"", negative:"", solutions:"", tips:[], do:[], dont:[], lucky_color:"", lucky_number:0 },
              career:   { score_percent:0, summary:"", positive:"", negative:"", solutions:"", tips:[], do:[], dont:[], lucky_color:"", lucky_number:0 },
              wealth:   { score_percent:0, summary:"", positive:"", negative:"", solutions:"", tips:[], do:[], dont:[], lucky_color:"", lucky_number:0 },
              health:   { score_percent:0, summary:"", positive:"", negative:"", solutions:"", tips:[], do:[], dont:[], lucky_color:"", lucky_number:0 },
              wellness: { score_percent:0, summary:"", positive:"", negative:"", solutions:"", tips:[], do:[], dont:[], lucky_color:"", lucky_number:0 },
              luck:     { score_percent:0, summary:"", positive:"", negative:"", solutions:"", tips:[], do:[], dont:[], lucky_color:"", lucky_number:0 }
            }
          }
        }
      }
    }
  };

  const userMsg = JSON.stringify({
    system, lang, tone,
    periods: PERIODS,
    sign_keys: [
      "aries","taurus","gemini","cancer","leo","virgo",
      "libra","scorpio","sagittarius","capricorn","aquarius","pisces"
    ],
    categories: CATS,
    word_limits: WORD_LIMITS,
    planet_status: Array.isArray(planet_status) ? planet_status : [],
    planet_movements: planet_movements || { since_yesterday:[], into_tomorrow:[] },
    movement_rules: "For each sign, include planets whose current sign equals the sign OR whose sign_change target equals that sign, for both since_yesterday and into_tomorrow.",
    period_specials: {
      weekly:  ["weekly_lucky_day"],
      monthly: ["monthly_lucky_day"],
      yearly:  ["yearly_lucky_months","best_overall_advice","month_breakdown"]
    },
    // Output contract: replicate this shape for ALL 12 signs and EVERY requested period (exact names).
    schema
  });

  return { systemMsg, userMsg };
}

function trimToWordLimits(obj, periodsList){
  const limits = WORD_LIMITS;
  const periods = Array.isArray(periodsList) ? periodsList : [];
  if (!obj || !obj.signs) return obj;

  for (const sign of ALL_SIGNS) {
    const sp = obj.signs[sign]?.periods;
    if (!sp) continue;

    for (const p of periods) {
      const cats = sp[p]?.categories;
      if (!cats) continue;

      for (const key of ["general","love","family","career","wealth","health","wellness","luck"]) {
        const c = cats[key];
        if (!c || typeof c.summary !== "string") continue;
        const lim = limits[p] || limits.other;
        const words = c.summary.trim().split(/\s+/);
        if (words.length > lim[1]) c.summary = words.slice(0, lim[1]).join(" ");
      }
    }
  }
  return obj;
}

function ensureAllSigns(obj, periodsList){
  if (!obj.signs) obj.signs = {};
  for (const sign of ALL_SIGNS) {
    if (!obj.signs[sign]) obj.signs[sign] = { movements:{ since_yesterday:[], into_tomorrow:[] }, periods:{} };
    const sp = obj.signs[sign].periods || (obj.signs[sign].periods = {});
    for (const p of periodsList) {
      if (!sp[p]) sp[p] = { categories: {} };
      const cats = sp[p].categories;
      for (const key of ["general","love","family","career","wealth","health","wellness","luck"]) {
        if (!cats[key]) {
          cats[key] = { score_percent: 0, summary: "", tips: [], do: [], dont: [], lucky_color: "", lucky_number: 0 };
        }
      }
    }
  }
  return obj;
}

// ----- legacy helpers kept as-is -------------------------------------------
const SIGN_BY_NUM = {
  1: "Aries", 2: "Taurus", 3: "Gemini", 4: "Cancer",
  5: "Leo", 6: "Virgo", 7: "Libra", 8: "Scorpio",
  9: "Sagittarius", 10: "Capricorn", 11: "Aquarius", 12: "Pisces"
};
const SIGN_KEYS = [
  "aries","taurus","gemini","cancer","leo","virgo",
  "libra","scorpio","sagittarius","capricorn","aquarius","pisces"
];
const normalizeSignKey = (s) => String(s || "").trim().toLowerCase();
function resolveSignListForAudience(audience, sign) {
  if (Array.isArray(sign)) {
    const req = new Set(sign.map(normalizeSignKey).filter(Boolean));
    return SIGN_KEYS.filter(k => req.has(k));
  }
  const s = normalizeSignKey(sign);
  if (audience === "generic") {
    if (s === "all" || s === "*" || !s) return SIGN_KEYS.slice();
    if (SIGN_KEYS.includes(s)) return [s];
    return SIGN_KEYS.slice();
  }
  if (SIGN_KEYS.includes(s)) return [s];
  return [];
}

// planets/movements ----------------------------------------------------------
function derivePlanetStatusFromRaw(rawJson) {
  const j = safeParseMaybeTwice(rawJson);
  const out = Array.isArray(j?.output) ? j.output : [];
  return out
    .filter(p => p?.planet?.en && (p?.zodiac_sign?.name?.en || p?.zodiac_sign?.number != null))
    .map(p => ({
      body: String(p.planet.en),
      sign: p?.zodiac_sign?.name?.en || SIGN_BY_NUM[p?.zodiac_sign?.number] || "",
      degree: typeof p.normDegree === "number" ? Number(p.normDegree) : 0,
      retrograde: String(p.isRetro || p.is_retro || "").toLowerCase() === "true",
      fullDegree: typeof p.fullDegree === "number" ? Number(p.fullDegree) : null
    }));
}
function degreeDelta(a, b) { let d = ((b - a + 540) % 360) - 180; return Math.round(d * 100) / 100; }
function indexByBody(arr) { const m = {}; for (const it of arr) m[it.body] = it; return m; }
function buildMovements(yRaw, dRaw, tRaw) {
  const Y = indexByBody(derivePlanetStatusFromRaw(yRaw));
  const D = indexByBody(derivePlanetStatusFromRaw(dRaw));
  const T = indexByBody(derivePlanetStatusFromRaw(tRaw));
  const since_yesterday = Object.keys(D).filter(k => Y[k]).map(k => {
    const a = Y[k], b = D[k];
    return {
      body: k,
      delta_deg: (a.fullDegree != null && b.fullDegree != null) ? degreeDelta(a.fullDegree, b.fullDegree) : null,
      sign_change: a.sign !== b.sign,
      to_sign: b.sign,
      retro_flip: a.retrograde !== b.retrograde
    };
  });
  const into_tomorrow = Object.keys(D).filter(k => T[k]).map(k => {
    const a = D[k], b = T[k];
    return {
      body: k,
      delta_deg: (a.fullDegree != null && b.fullDegree != null) ? degreeDelta(a.fullDegree, b.fullDegree) : null,
      sign_change: a.sign !== b.sign,
      to_sign: b.sign,
      retro_flip: a.retrograde !== b.retrograde
    };
  });
  return { since_yesterday, into_tomorrow };
}

// windows --------------------------------------------------------------------
function computeWindow(period, now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const d0 = new Date(today);
  if (period === "yesterday") { const y = new Date(today); y.setUTCDate(today.getUTCDate() - 1); return { start: fmt(y), end: fmt(y) }; }
  if (period === "tomorrow")  { const t = new Date(today); t.setUTCDate(today.getUTCDate() + 1); return { start: fmt(t), end: fmt(t) }; }
  if (period === "weekly") { const day = (today.getUTCDay() + 6) % 7; const start = new Date(today); start.setUTCDate(today.getUTCDate() - day); const end = new Date(start); end.setUTCDate(start.getUTCDate() + 6); return { start: fmt(start), end: fmt(end) }; }
  if (period === "monthly") { const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)); const end = new Date(Date.UTC(today.getUTCFullYear(), today.getMonth()+1, 0)); return { start: fmt(start), end: fmt(end) }; }
  if (period === "yearly")  { const start = `${today.getUTCFullYear()}-01-01`; const end = `${today.getUTCFullYear()}-12-31`; return { start, end }; }
  return { start: fmt(d0), end: fmt(d0) };
}
function computeAllWindows(now = new Date()) {
  return {
    yesterday: computeWindow("yesterday", now),
    today:     computeWindow("today", now),
    tomorrow:  computeWindow("tomorrow", now),
    weekly:    computeWindow("weekly", now),
    monthly:   computeWindow("monthly", now),
    yearly:    computeWindow("yearly", now),
  };
}

// raw rows -------------------------------------------------------------------
async function fetchLatestRawRow(client, { system = "western", period = "today" }) {
  const { rows } = await client.query(
    `SELECT ${SRC_ID_COL} AS id, text, created_at
       FROM public.${SRC_TABLE}
      WHERE system = $1 AND period = $2
      ORDER BY created_at DESC
      LIMIT 1`, [system, period]
  );
  return rows?.[0] || null;
}
async function fetchLatestPendingRawRow(client, { system = "western", period = "today" }) {
  const { rows } = await client.query(
    `SELECT ${SRC_ID_COL} AS id, text, created_at, period, lang, system
       FROM public.${SRC_TABLE}
      WHERE system = $1 AND period = $2
        AND COALESCE(is_ai_predicted,'N') = 'N'
      ORDER BY created_at DESC
      LIMIT 1`, [system, period]
  );
  return rows?.[0] || null;
}

// prompt overrides (legacy) --------------------------------------------------
async function fetchDbPromptOverride(client, { purpose, period, lang, tone, isSystem }) {
  try {
    const { rows } = await client.query(
      `SELECT template
         FROM public.llm_prompt_template
        WHERE purpose = $1 AND period = $2 AND lang = $3 AND tone = $4
          AND is_system = $5 AND is_active
        ORDER BY updated_at DESC
        LIMIT 1`,
      [purpose, period, lang, tone, isSystem]
    );
    return rows?.[0]?.template || null;
  } catch {
    return null;
  }
}

// legacy prompt builder (kept) -----------------------------------------------
async function buildMessages(client, {
  audience = "generic",
  period, lang, tone, sign, system, window, windowsAll,
  planetStatus, movements
}) {
  const sysDb = await fetchDbPromptOverride(client, {
    purpose: "horoscope_prediction", period, lang, tone, isSystem: true
  });
  const userDb = await fetchDbPromptOverride(client, {
    purpose: "horoscope_prediction", period, lang, tone, isSystem: false
  });

  const LEN = {
    yesterday: [100,150],
    today:     [100,150],
    tomorrow:  [100,150],
    weekly:    [150,200],
    monthly:   [200,250],
    yearly:    [250,300],
    other:     [100,150]
  };
  const constraints =
    "Rules: score_percent 0..100 int; summaries must respect per-period char ranges; " +
    "concise simple English; no medical/financial/therapy directives; JSON only; " +
    "tips=2, do=3, dont=3 for each category.";

  const signList = resolveSignListForAudience(audience, sign);

  const baseSchema =
    `SCHEMA:{
      "system":"",
      "period":"",
      "window":{"start":"","end":""},
      "windows_all":{
        "yesterday":{"start":"","end":""},
        "today":{"start":"","end":""},
        "tomorrow":{"start":"","end":""},
        "weekly":{"start":"","end":""},
        "monthly":{"start":"","end":""},
        "yearly":{"start":"","end":""}
      },
      "planet_status":[{"body":"","sign":"","degree":0,"retrograde":false,"note":""}],
      "planet_movements":{
        "since_yesterday":[{"body":"","delta_deg":0,"sign_change":false,"to_sign":"","retro_flip":false}],
        "into_tomorrow":[{"body":"","delta_deg":0,"sign_change":false,"to_sign":"","retro_flip":false}]
      }
    }`;

  const categoryBlock =
    `"general":{"score_percent":0,"summary":"","tips":[],"do":[],"dont":[],"lucky_color":"","lucky_number":0},
     "love":{"score_percent":0,"summary":"","tips":[],"do":[],"dont":[],"lucky_color":"","lucky_number":0},
     "family":{"score_percent":0,"summary":"","tips":[],"do":[],"dont":[],"lucky_color":"","lucky_number":0},
     "relationships":{"score_percent":0,"summary":"","tips":[],"do":[],"dont":[],"lucky_color":"","lucky_number":0},
     "career":{"score_percent":0,"summary":"","tips":[],"do":[],"dont":[],"lucky_color":"","lucky_number":0},
     "money":{"score_percent":0,"summary":"","tips":[],"do":[],"dont":[],"lucky_color":"","lucky_number":0},
     "wealth":{"score_percent":0,"summary":"","tips":[],"do":[],"dont":[],"lucky_color":"","lucky_number":0},
     "health":{"score_percent":0,"summary":"","tips":[],"do":[],"dont":[],"lucky_color":"","lucky_number":0},
     "wellness":{"score_percent":0,"summary":"","tips":[],"do":[],"dont":[],"lucky_color":"","lucky_number":0},
     "luck":{"score_percent":0,"summary":"","tips":[],"do":[],"dont":[],"lucky_color":"","lucky_number":0}`;

  if (audience === "personal") {
    const systemMsg = sysDb ?? [
      "You are an expert astrologer.",
      "OUTPUT: JSON ONLY. Root must match schema. Be concise. Respect per-period char ranges.",
      `Style:${tone}. Audience:personal. Lang:${lang}. Primary Period:${period}.`,
      baseSchema.replace("}", `,"categories":{${categoryBlock}},"periods":{
        "yesterday":{"categories":{${categoryBlock}}},
        "today":{"categories":{${categoryBlock}}},
        "tomorrow":{"categories":{${categoryBlock}}},
        "weekly":{"categories":{${categoryBlock}}},
        "monthly":{"categories":{${categoryBlock}}},
        "yearly":{"categories":{${categoryBlock}}}
      }}`)
    ].join(" ");

    const userPayload = {
      sign: (resolveSignListForAudience(audience, sign)[0] || null),
      system, period, window, windows_all: windowsAll,
      planet_status: planetStatus,
      planet_movements: movements,
      categories: ['general','love','family','relationships','career','money','wealth','health','wellness','luck']
    };

    const userMsg = userDb ?? JSON.stringify(userPayload);
    return { systemMsg, userMsg, mode: "single" };
  }

  const systemMsg = sysDb ?? [
    "You are an expert astrologer.",
    "OUTPUT: JSON ONLY. Root must match schema. Be concise. Avoid repetition. Respect per-period char ranges.",
    `Style:${tone}. Audience:generic. Lang:${lang}. Primary Period:${period}.`,
    baseSchema.replace("}", `,"signs":{
      "aries":{"categories":{${categoryBlock}},"periods":{
        "yesterday":{"categories":{${categoryBlock}}},
        "today":{"categories":{${categoryBlock}}},
        "tomorrow":{"categories":{${categoryBlock}}},
        "weekly":{"categories":{${categoryBlock}}},
        "monthly":{"categories":{${categoryBlock}}},
        "yearly":{"categories":{${categoryBlock}}}
      }}
      /* same for other requested signs */
    }}`)
  ].join(" ");

  const userPayload = {
    system, period, window, windows_all: windowsAll,
    planet_status: planetStatus,
    planet_movements: movements,
    signs: resolveSignListForAudience(audience, sign),
    categories: ['general','love','family','relationships','career','money','wealth','health','wellness','luck']
  };

  const userMsg = userDb ?? JSON.stringify(userPayload);
  return { systemMsg, userMsg, mode: "multi" };
}

// ---------- NEW: single helper to call Responses API (JSON) -----------------
async function callOpenAIJson({ systemMsg, userMsg, model, temperature = 0.6 }) {
  const r = await openai.responses.create({
    model: model || process.env.HORO_MODEL || "gpt-4o-mini",
    input: [
      { role: "system", content: systemMsg },
      { role: "user",   content: userMsg }
    ],
    temperature,
    text: {
      format: {
        type: "json_schema",
        json_schema: {
          name: "GenericObject",
          schema: { type: "object", additionalProperties: true },
          strict: true
        }
      }
    }
  });

  const raw = r.output_text ?? (r.output?.[0]?.content?.[0]?.text ?? "{}");
  // usage keys differ between APIs; normalize for our estimator
  const usage = r.usage || {};
  if (!("prompt_tokens" in usage) && "input_tokens" in usage) {
    usage.prompt_tokens = usage.input_tokens;
  }
  if (!("completion_tokens" in usage) && "output_tokens" in usage) {
    usage.completion_tokens = usage.output_tokens;
  }
  return { text: raw, usage, model: r.model || model };
}

// ---- endpoints -------------------------------------------------------------

router.get("/ping", (_req, res) => res.json({ ok: true, where: "ai.batch.route" }));

router.get("/_diag", async (_req, res) => {
  try {
    const q = `SELECT table_name, column_name
                 FROM information_schema.columns
                WHERE table_schema='public'
                  AND table_name IN ($1,$2)
                ORDER BY table_name, ordinal_position`;
    const { rows } = await pool.query(q, [SRC_TABLE, DST_TABLE]);
    const tables = rows.reduce((acc, r) => {
      acc[r.table_name] = acc[r.table_name] || [];
      acc[r.table_name].push(r.column_name);
      return acc;
    }, {});
    res.json({
      ok: true,
      openaiKeyPresent: Boolean(process.env.OPENAI_API_KEY),
      tables,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/predict/_echo', (req, res) => {
  return res.status(200).type('application/json').send(JSON.stringify({ ok: true, you_sent: req.body || null }));
});

// 1) Legacy per-batch endpoint (kept) — now uses Responses API
router.post("/predict/pending", async (req, res, next) => {
  console.log("[PENDING_HANDLER] hit", { test: req.query?.test ?? null });

  if (String(req.query.test || "") === "1") {
    return res.json({ ok: true, processed: 0, message: "Bypass OK", echo: req.body });
  }

  const { limit = 10, audience = "generic", period = "today", lang = "en" } = req.body || {};

  const client  = await pool.connect();
  const started = Date.now();

  try {
    await client.query("BEGIN");

    const { rows: pendings } = await client.query(
      `
      SELECT ${SRC_ID_COL} AS src_id, text
        FROM public.${SRC_TABLE}
       WHERE COALESCE(is_ai_predicted,'N') = 'N'
       ORDER BY created_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED
      `,[limit]
    );

    if (pendings.length === 0) {
      await client.query("ROLLBACK");
      return res.json({ ok: true, processed: 0, message: "No pending rows." });
    }

    let processed = 0;
    const results = [];

    for (const row of pendings) {
      const { src_id, text } = row;
      try {
        const textStr = typeof text === "string" ? text : JSON.stringify(text);
        const { system, instruction, context } = buildLLMInputFromText(textStr, { audience, period, lang });

        // ---- NEW: Responses API call (JSON) ----
        const { text: llmText, usage, model } = await callOpenAIJson({
          systemMsg: system,
          userMsg: JSON.stringify([instruction, context]),
          model: process.env.HORO_MODEL || "gpt-4o-mini",
          temperature: 0.6
        });

        const cost  = estimateCostUSD(usage);
        const predictionText = sanitizeLLM(llmText);

        const action = await upsertPredictionByFk(client, {
          srcId: src_id, text: predictionText, period, lang,
          modelName: model || (process.env.HORO_MODEL || "gpt-4o-mini"),
          promptTokens: usage?.prompt_tokens ?? usage?.input_tokens ?? null,
          completionTokens: usage?.completion_tokens ?? usage?.output_tokens ?? null,
          costUSD: cost
        });

        await client.query(
          `UPDATE public.${SRC_TABLE}
              SET is_ai_predicted = 'Y', updated_at = now()
            WHERE ${SRC_ID_COL} = $1`,
          [src_id]
        );

        processed++;
        results.push({ id: src_id, action, status: "ok", usage, cost_usd: cost });
      } catch (e) {
        results.push({ id: row.src_id, status: "error", error: String(e?.message || e) });
      }
    }

    await client.query("COMMIT");
    res.json({ ok: true, processed, took_ms: Date.now() - started, results });
  } catch (e) {
    await client.query("ROLLBACK");
    next(e);
  } finally {
    client.release();
  }
});

// 1a) Peek pending counts (helps avoid wasted calls)
const PENDING_PRED = "COALESCE(UPPER(TRIM(is_ai_predicted)),'N')='N'";

router.get("/predict/pending/_peek", async (req, res) => {
  try {
    const { system = null, lang = null } = req.query;

    const vals = [];
    const parts = [PENDING_PRED];
    if (system) { vals.push(system); parts.push(`LOWER(system) = LOWER($${vals.length})`); }
    if (lang)   { vals.push(lang);   parts.push(`LOWER(lang)   = LOWER($${vals.length})`); }
    const where = `WHERE ${parts.join(" AND ")}`;

    const countSql = `SELECT COUNT(*)::int AS pending_count FROM public.${SRC_TABLE} ${where}`;
    const { rows: rc } = await pool.query(countSql, vals);
    const pending_count = rc?.[0]?.pending_count ?? 0;

    const sampleSql = `
      SELECT ${SRC_ID_COL} AS id, period, system, lang, created_at
        FROM public.${SRC_TABLE}
       ${where}
       ORDER BY created_at DESC
       LIMIT 10
    `;
    const { rows: sample } = await pool.query(sampleSql, vals);

    return res.status(200).json({ ok: true, pending_count, sample });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// 1b) Bulk processor — NO period filter (uses row.period). Progress guard added.
router.post("/predict/pending/all", async (req, res) => {
  const batchSize = Math.max(1, Math.min(50, Number(req.body?.batch_size ?? 5)));
  const maxRows   = Math.max(1, Math.min(5000, Number(req.body?.max_rows ?? 100)));
  const tone      = req.body?.tone   ?? "concise";
  const debug     = !!req.body?.debug;
  const noLock    = !!req.body?.no_lock;

  const MAX_EMPTY_BATCHES = Number(process.env.AI_MAX_EMPTY_BATCHES ?? 1); // <— guard
  let emptyBatchStreak = 0;

  const started = Date.now();
  const allResults = [];
  let totalProcessed = 0;
  let totalErrors = 0;
  let batches = 0;
  let totalFlipped = 0;

  // context rows for planet status/movements
  const systemForContext = (req.body?.system && req.body.system !== "*" ? req.body.system : "western");
  const clientOnce = await pool.connect();
  let rawY=null, rawD=null, rawT=null;
  try {
    await clientOnce.query("BEGIN");
    rawY = await fetchLatestRawRow(clientOnce, { system: systemForContext, period: 'yesterday' });
    rawD = await fetchLatestRawRow(clientOnce, { system: systemForContext, period: 'today'     });
    rawT = await fetchLatestRawRow(clientOnce, { system: systemForContext, period: 'tomorrow'  });
    await clientOnce.query("COMMIT");
  } catch {
    await clientOnce.query("ROLLBACK");
  } finally {
    clientOnce.release();
  }
  const planet_status    = rawD ? derivePlanetStatusFromRaw(rawD.text) : [];
  const planet_movements = (rawY && rawD && rawT) ? buildMovements(rawY.text, rawD.text, rawT.text) : { since_yesterday:[], into_tomorrow:[] };

  // helper to build WHERE + params (case-insensitive), NO period filter
  const buildFilters = (body) => {
    const where = ["COALESCE(UPPER(TRIM(is_ai_predicted)),'N')='N'"];
    const vals = [];
    let idx = 1;
    if (body.system && body.system !== "*" && body.system !== "all") {
      where.push(`LOWER(system)=LOWER($${idx++})`);
      vals.push(body.system);
    }
    if (body.lang && body.lang !== "*" && body.lang !== "all") {
      where.push(`LOWER(lang)=LOWER($${idx++})`);
      vals.push(body.lang);
    }
    return { where: where.join(" AND "), vals, next: idx };
  };

  const selectBatch = async (client, limit) => {
    const { where, vals, next } = buildFilters(req.body || {});
    const params = vals.slice();
    params.push(limit);
    const limitParam = `$${next}`;

    const baseSql = `
      SELECT ${SRC_ID_COL} AS src_id, text, period, lang, system, created_at
        FROM public.${SRC_TABLE}
       WHERE ${where}
       ORDER BY created_at
       LIMIT ${limitParam}
    `;
    const sql = noLock ? baseSql : baseSql + " FOR UPDATE SKIP LOCKED";

    const countSql = `SELECT COUNT(*)::int AS n FROM public.${SRC_TABLE} WHERE ${where}`;
    const { rows: cr } = await client.query(countSql, vals);
    const matchCount = cr?.[0]?.n ?? 0;

    const r = await client.query(sql, params);
    return { rows: r.rows, matchCount, where, vals: params };
  };

  while (totalProcessed < maxRows) {
    const client = await pool.connect();
    let processedThisBatch = 0;
    let flippedThisBatch = 0;
    const batchResults = [];
    let batchDebug = null;

    try {
      await client.query("BEGIN");

      const sel = await selectBatch(client, Math.min(batchSize, maxRows - totalProcessed));
      const pendings = sel.rows;

      if (debug) {
        batchDebug = {
          where: sel.where,
          params: sel.vals,
          pending_match_count_in_tx: sel.matchCount,
          selected_count: pendings.length,
          locking: noLock ? "NO LOCK" : "FOR UPDATE SKIP LOCKED",
          empty_batch_streak: emptyBatchStreak
        };
        console.log("[BULK DEBUG]", batchDebug);
      }

      if (pendings.length === 0) {
        await client.query("ROLLBACK");
        client.release();
        if (debug) allResults.push({ batch: batches + 1, processed: 0, flipped: 0, results: [], debug: batchDebug });
        break;
      }

      console.log(`[BULK] locked ${pendings.length} pending rows`);

      for (const row of pendings) {
        const { src_id, period: rowPeriod, lang: rowLang, system: rowSystem } = row;
        try {
          const periods = [String(rowPeriod || "today")];

          const { systemMsg, userMsg } = buildHardRulesPrompt({
            periods,
            system: rowSystem || systemForContext || "western",
            lang:   rowLang || "en",
            tone,
            planet_status,
            planet_movements
          });

          // ---- NEW: Responses API call (JSON) ----
          const { text: llmText, usage, model } = await callOpenAIJson({
            systemMsg,
            userMsg,
            model: process.env.HORO_MODEL || "gpt-4o-mini",
            temperature: 0.6
          });

          const cost  = estimateCostUSD(usage);

          const predictionText = sanitizeLLM(llmText);
          let parsed = safeParseMaybeTwice(predictionText);
          parsed = ensureAllSigns(parsed, periods);
          parsed = trimToWordLimits(parsed, periods);
          const finalText = JSON.stringify(parsed);

          const action = await upsertPredictionByFk(client, {
            srcId: src_id,
            text: finalText,
            period: rowPeriod || "today",
            lang: rowLang || "en",
            modelName: model || (process.env.HORO_MODEL || "gpt-4o-mini"),
            promptTokens: usage?.prompt_tokens ?? usage?.input_tokens ?? null,
            completionTokens: usage?.completion_tokens ?? usage?.output_tokens ?? null,
            costUSD: cost
          });

          const flagUpd = await client.query(
            `UPDATE public.${SRC_TABLE}
                SET is_ai_predicted = 'Y', updated_at = now()
              WHERE ${SRC_ID_COL} = $1
                AND COALESCE(UPPER(TRIM(is_ai_predicted)),'N') <> 'Y'`,
            [src_id]
          );

          processedThisBatch++;
          flippedThisBatch += flagUpd.rowCount ?? 0;
          totalProcessed++;
          totalFlipped += flagUpd.rowCount ?? 0;

          batchResults.push({
            id: src_id,
            status: "ok",
            action,
            usage, cost_usd: cost,
            period: rowPeriod, lang: rowLang, system: rowSystem
          });

          if (totalProcessed >= maxRows) break;
        } catch (rowErr) {
          totalErrors++;
          batchResults.push({ id: src_id, status: "error", error: String(rowErr?.message || rowErr) });
        }
      }

      await client.query("COMMIT");
      batches++;

      // ---- Progress guard: stop if we made no progress this batch -------------
      if (processedThisBatch === 0 && flippedThisBatch === 0) {
        emptyBatchStreak++;
      } else {
        emptyBatchStreak = 0;
      }
      if (emptyBatchStreak > MAX_EMPTY_BATCHES) {
        if (debug) {
          allResults.push({
            batch: batches,
            processed: processedThisBatch,
            flipped: flippedThisBatch,
            results: batchResults,
            debug: { ...batchDebug, stopped_reason: "no_progress_guard" }
          });
        } else {
          allResults.push({ batch: batches, processed: processedThisBatch, flipped: flippedThisBatch, results: batchResults });
        }
        try { client.release(); } catch {}
        break;
      }
      // -------------------------------------------------------------------------

      allResults.push({
        batch: batches,
        processed: processedThisBatch,
        flipped: flippedThisBatch,
        results: batchResults,
        ...(debug && { debug: batchDebug })
      });

      if (totalProcessed >= maxRows) break;
    } catch (batchErr) {
      await client.query("ROLLBACK");
      batchResults.push({ status: "batch_error", error: String(batchErr?.message || batchErr) });
      allResults.push({ batch: batches + 1, processed: 0, results: batchResults });
      client.release();
      break;
    } finally {
      try { client.release(); } catch {}
    }
  }

  return res
    .status(200)
    .type("application/json")
    .send(JSON.stringify({
      ok: true,
      processed: totalProcessed,
      flipped: totalFlipped,
      errors: totalErrors,
      batches,
      took_ms: Date.now() - started,
      details: allResults
    }));
});

// 2) Single run — defaults to HARD RULES; add "hard": false to use legacy buildMessages
router.post('/predict/generate', async (req, res) => {
  const {
    audience = 'generic',
    period   = 'today',
    system   = 'western',
    lang     = 'en',
    tone     = 'concise',
    sign     = 'all',
    hard     = true
  } = req.body || {};

  const client  = await pool.connect();
  const started = Date.now();

  try {
    await client.query('BEGIN');

    const rawY = await fetchLatestRawRow(client, { system, period: 'yesterday' });
    const rawD = await fetchLatestRawRow(client, { system, period: 'today' });
    const rawT = await fetchLatestRawRow(client, { system, period: 'tomorrow' });

    let rawP = await fetchLatestPendingRawRow(client, { system, period });
    if (!rawP) rawP = await fetchLatestRawRow(client, { system, period });

    if (!rawP) {
      await client.query('ROLLBACK');
      return res.status(404).type('application/json')
        .send(JSON.stringify({ ok:false, error:`No raw row for system=${system} period=${period}` }));
    }

    const planet_status = rawD ? derivePlanetStatusFromRaw(rawD.text) : [];
    const planet_movements = (rawY && rawD && rawT)
      ? buildMovements(rawY.text, rawD.text, rawT.text)
      : { since_yesterday: [], into_tomorrow: [] };

    let systemMsg, userMsg;
    if (hard) {
      const periods = [String(period)];
      ({ systemMsg, userMsg } = buildHardRulesPrompt({
        periods,
        system, lang, tone,
        planet_status, planet_movements
      }));
    } else {
      const window     = computeWindow(period);
      const windowsAll = computeAllWindows();
      ({ systemMsg, userMsg } = await buildMessages(
        client, { audience, period, lang, tone, sign, system,
                  window, windowsAll,
                  planetStatus: planet_status, movements: planet_movements }
      ));
    }

    // ---- NEW: Responses API call (JSON) ----
    let predictionText = '{}';
    let usage = {};
    try {
      const { text: llmText, usage: u, model } = await callOpenAIJson({
        systemMsg,
        userMsg,
        model: process.env.HORO_MODEL || 'gpt-4o-mini',
        temperature: 0.6
      });
      usage = u;
      predictionText = sanitizeLLM(llmText);
    } catch (apiErr) {
      console.error('OpenAI error:', apiErr?.status, apiErr?.message);
      await client.query('ROLLBACK');
      return res.status(502).type('application/json')
        .send(JSON.stringify({ ok:false, error:`OpenAI: ${apiErr?.status || ''} ${apiErr?.message || apiErr}` }));
    }

    let finalOut = predictionText;
    if (hard) {
      const parsed = safeParseMaybeTwice(predictionText);
      const periods = [String(period)];
      const trimmed = trimToWordLimits(ensureAllSigns(parsed, periods), periods);
      finalOut = JSON.stringify(trimmed);
    }

    const cost = estimateCostUSD(usage);

    const action = await upsertPredictionByFk(client, {
      srcId: rawP.id,
      text: finalOut,
      period, lang,
      modelName: process.env.HORO_MODEL || 'gpt-4o-mini',
      promptTokens: usage?.prompt_tokens ?? usage?.input_tokens ?? null,
      completionTokens: usage?.completion_tokens ?? usage?.output_tokens ?? null,
      costUSD: cost
    });

    const flagUpd = await client.query(
      `UPDATE public.${SRC_TABLE}
         SET is_ai_predicted = 'Y', updated_at = now()
       WHERE ${SRC_ID_COL} = $1
         AND COALESCE(UPPER(TRIM(is_ai_predicted)),'N') <> 'Y'`,
      [rawP.id]
    );

    await client.query('COMMIT');

    const parsedReturn = safeParseMaybeTwice(finalOut);
    return res.status(200).type('application/json')
      .send(JSON.stringify({
        ok: true,
        action,
        took_ms: Date.now() - started,
        model: process.env.HORO_MODEL || 'gpt-4o-mini',
        usage,
        cost_usd: cost,
        prediction: parsedReturn,
        flagged_rows: flagUpd.rowCount,
        prompt_mode: hard ? "hard_rules" : "legacy"
      }));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[/predict/generate ERROR]', err);
    return res.status(500).type('application/json')
      .send(JSON.stringify({ ok:false, error: String(err?.message || err) }));
  } finally {
    client.release();
  }
});

// route inspector
router.get("/_routes", (_req, res) => {
  const paths = [];
  router.stack.forEach((layer) => {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).filter(m => layer.route.methods[m]).map(m => m.toUpperCase());
      paths.push({ methods, path: layer.route.path });
    }
  });
  res.json({ ok: true, where: "ai.batch.route", paths });
});

// --- JSON error handler ----------------------------------------------------
router.use((err, _req, res, _next) => {
  console.error('[AI ROUTER ERROR]', err);
  return res.status(500).type('application/json')
    .send(JSON.stringify({ ok: false, error: String(err?.message || err) }));
});

export default router;
