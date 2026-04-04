// src/services/raw-bundle-ai-predict.service.js
import OpenAI from "openai";
import pool from "../db.js"; // adjust if your db.js path differs

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TONE_BY_EXPERT = { sohum: "mystical", oracle: "balanced", maya: "practical" };
const SYSTEM_BY_TONE = {
  mystical: `You are "Sohum", a compassionate guide. Output STRICT JSON only.`,
  balanced: `You are "Oracle", calm and realistic. Output STRICT JSON only.`,
  practical: `You are "Maya", practical and action-oriented. Output STRICT JSON only.`,
};

/* ------------------------------
   UTC helpers
------------------------------ */
function utcTodayYMD() {
  return new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
}

/**
 * - if requestedDate == today => "today"
 * - if requestedDate < today  => "yesterday"
 * - if requestedDate > today  => "tomorrow"
 */
function computeDailyLabelByCompare(requestedDateYMD) {
  const today = utcTodayYMD();
  if (!requestedDateYMD) return "daily";

  if (requestedDateYMD === today) return "today";
  if (requestedDateYMD < today) return "yesterday";
  if (requestedDateYMD > today) return "tomorrow";

  return "daily";
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * ✅ Convert Postgres DATE / string / Date -> YYYY-MM-DD WITHOUT timezone shifting errors
 */
function toYMDUTC(value) {
  if (!value) return null;

  // If already YYYY-MM-DD
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  // If it's a Date (pg returns Date for DATE) - use LOCAL Y/M/D to avoid UTC shifting
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  // If it's a string like "Tue Jan 06 2026 ..."
  const dt = new Date(value);
  if (!isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);

  return null;
}

/**
 * ✅ For writing style by timeframe:
 * daily: yesterday/today/tomorrow
 * weekly/monthly/yearly: should reference the whole span
 */
function timeframeRules(meta) {
  const period = (meta.periodLabel || meta.duration || "daily").toLowerCase();

  if (period === "yesterday") {
    return {
      timeframeName: "yesterday",
      tenseRule: "PAST tense",
      allowedDayWords: ["yesterday"],
      forbiddenDayWords: ["today", "tomorrow"],
      styleHint:
        "Reflect on what already happened and what the user can learn/adjust next.",
    };
  }

  if (period === "today") {
    return {
      timeframeName: "today",
      tenseRule: "PRESENT tense",
      allowedDayWords: ["today"],
      forbiddenDayWords: ["yesterday", "tomorrow"],
      styleHint:
        "Focus on what is active right now and practical actions for the day.",
    };
  }

  if (period === "tomorrow") {
    return {
      timeframeName: "tomorrow",
      tenseRule: "FUTURE/forward-looking tense",
      allowedDayWords: ["tomorrow"],
      forbiddenDayWords: ["today", "yesterday"],
      styleHint:
        "Focus on likely themes and preparations; avoid certainty and avoid claiming facts already happened.",
    };
  }

  // weekly/monthly/yearly (and fallback)
  return {
    timeframeName: period, // weekly/monthly/yearly/daily
    tenseRule: "TIMEFRAME-AWARE (mix of present/future), but NOT 'today-only' language",
    allowedDayWords: [], // none required
    forbiddenDayWords: ["today", "tomorrow", "yesterday"],
    styleHint:
      "Describe the overall period themes and turning points across the full date range. Mention the date span once.",
  };
}

/**
 * ✅ Guard rails: prevent wrong timeframe words (super effective)
 */
function violatesTimeframeWords(text, meta) {
  const t = (text || "").toLowerCase();
  const rules = timeframeRules(meta);

  // for weekly/monthly/yearly: block "today/tomorrow/yesterday"
  for (const w of rules.forbiddenDayWords || []) {
    if (t.includes(w)) return `contains forbidden word '${w}' for period=${rules.timeframeName}`;
  }

  // for daily labels: block the other day-words
  if (rules.allowedDayWords?.length) {
    const others = ["today", "tomorrow", "yesterday"].filter(
      (w) => !rules.allowedDayWords.includes(w)
    );
    for (const w of others) {
      if (t.includes(w)) return `contains '${w}' but period=${rules.timeframeName}`;
    }
  }

  return null;
}

function buildPrompt({ rawBundle, meta }) {
  const rules = timeframeRules(meta);

  // span line for weekly/monthly/yearly
  const spanLine =
    meta.duration !== "daily" && meta.period_start && meta.period_end
      ? `date_span=${meta.period_start}..${meta.period_end}`
      : `target_date=${meta.requested_date}`;

  return [
    `You are creating astrology predictions for a consumer app UI.`,
    `Use ONLY the provided RAW bundle data for the given timeframe.`,
    `No fear. No extreme claims. Be realistic, supportive, and actionable.`,
    `Output MUST be valid JSON only.`,
    ``,
    `META: system=${meta.system} lang=${meta.lang} signId=${meta.signId}`,
    `duration=${meta.duration} period=${meta.periodLabel}`,
    spanLine,
    ``,
    `CRITICAL TIMEFRAME RULES:`,
    `- You MUST base the prediction on the provided RAW bundle for this exact timeframe.`,
    `- Writing tense must follow: ${rules.tenseRule}.`,
    `- Style: ${rules.styleHint}`,
    `- Do NOT use daily words unless allowed:`,
    `  forbidden_words=${(rules.forbiddenDayWords || []).join(",") || "none"}`,
    `  allowed_words=${(rules.allowedDayWords || []).join(",") || "none"}`,
    `- For weekly/monthly/yearly: talk about the full period (not a single day).`,
    ``,
    `Return JSON matching this exact interface:`,
    `{`,
    `  "summary": string,`,
    `  "loveText": string,`,
    `  "lovePercent": number|null,`,
    `  "color": string|null,`,
    `  "number": number|null,`,
    `  "career": string,`,
    `  "job": string,`,
    `  "business": string,`,
    `  "money": string,`,
    `  "relationships": string,`,
    `  "numerology": string,`,
    `  "health": string,`,
    `  "wellness": string,`,
    `  "luck": string,`,
    `  "careerPercent": number|null,`,
    `  "familyPercent": number|null,`,
    `  "healthPercent": number|null,`,
    `  "requested_date": string,`,
    `  "resolved_date": string,`,
    `  "categories": {`,
    `    "love": { "title": string, "bullets": string[] },`,
    `    "career": { "title": string, "bullets": string[] },`,
    `    "money": { "title": string, "bullets": string[] },`,
    `    "health": { "title": string, "bullets": string[] },`,
    `    "lucky": { "color": string|null, "number": number|null, "timeWindow": string }`,
    `  }`,
    `}`,
    ``,
    `RAW_BUNDLE_JSON:`,
    JSON.stringify(rawBundle),
  ].join("\n");
}

async function selectRawRows(
  client,
  { system, lang, duration, date, rangeStart, rangeEnd, signId, limit, force }
) {
  const params = [system, lang, duration];
  let where = `WHERE system=$1 AND lang=$2 AND duration=$3`;

  if (!force) where += ` AND ai_predicted='N'`;

  if (duration === "daily") {
    if (!date) throw new Error("date is required for duration=daily");
    params.push(date);
    where += ` AND ref_date=$4::date`;
  } else {
    if (!rangeStart || !rangeEnd)
      throw new Error("rangeStart and rangeEnd required for non-daily duration");
    params.push(rangeStart, rangeEnd);
    where += ` AND range_start=$4::date AND range_end=$5::date`;
  }

  if (signId) {
    params.push(signId);
    where += ` AND sign_id=$${params.length}`;
  }

  params.push(limit);

  const sql = `
    SELECT id, system, lang, sign_id, duration, ref_date, range_start, range_end, bundle
    FROM public.astro_sign_bundle_cache
    ${where}
    ORDER BY sign_id
    LIMIT $${params.length};
  `;

  const { rows } = await client.query(sql, params);
  return rows;
}

async function savePrediction(
  client,
  { rawRow, period, audience_scope, lang, tone, gen, promptText }
) {
  const ins = `
    INSERT INTO public.astro_prediction
      (
        raw_cache_id,
        raw_event_id,
        period,
        period_start,
        period_end,
        audience_scope,
        lang,
        tone,
        model_provider,
        model_name,
        text,
        prompt_tokens,
        completion_tokens,
        cost_usd,
        sign_id,
        system,
        raw_snapshot,
        ai_payload,
        user_prompt
      )
    VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
    ON CONFLICT (raw_cache_id, lang, tone, audience_scope)
    DO UPDATE SET
      text = EXCLUDED.text,
      ai_payload = EXCLUDED.ai_payload,
      model_provider = EXCLUDED.model_provider,
      model_name = EXCLUDED.model_name,
      prompt_tokens = EXCLUDED.prompt_tokens,
      completion_tokens = EXCLUDED.completion_tokens,
      user_prompt = EXCLUDED.user_prompt,
      updated_at = now()
    RETURNING *;
  `;

  const periodStart =
    rawRow.duration === "daily" ? rawRow.ref_date : rawRow.range_start;
  const periodEnd =
    rawRow.duration === "daily" ? rawRow.ref_date : rawRow.range_end;

  const usage = gen.usage || {};
  const aiPayload = safeJsonParse(gen.text) || null;

  const vals = [
    rawRow.id,
    null,
    period,
    periodStart,
    periodEnd,
    audience_scope,
    lang,
    tone,
    gen.provider,
    gen.model,
    gen.text,
    usage.prompt_tokens ?? usage.prompt ?? null,
    usage.completion_tokens ?? usage.completion ?? null,
    null,
    rawRow.sign_id ?? null,
    rawRow.system ?? null,
    rawRow.bundle ?? null,
    aiPayload,
    promptText ?? null,
  ];

  const saved = await client.query(ins, vals);
  return saved.rows[0];
}

/**
 * ✅ Mark ai_predicted='Y' ONLY for past DAILY dates.
 */
async function markPredictedIfPast(client, rawRow) {
  if (rawRow.duration !== "daily") return;

  const today = utcTodayYMD();
  const ref = toYMDUTC(rawRow.ref_date);

  if (ref && ref < today) {
    await client.query(
      `UPDATE public.astro_sign_bundle_cache
       SET ai_predicted='Y'
       WHERE id=$1`,
      [rawRow.id]
    );
  }
}

async function callOpenAI({ tone, expertId, prompt }) {
  const resolvedTone = SYSTEM_BY_TONE[tone]
    ? tone
    : TONE_BY_EXPERT[expertId] || "balanced";

  const model = process.env.ASTRO_PREDICT_MODEL || "gpt-4o-mini";

  const resp = await openai.chat.completions.create({
    model,
    temperature: Number(process.env.ASTRO_PREDICT_TEMP || "0.6"),
    max_tokens: Number(process.env.ASTRO_PREDICT_MAX_TOKENS || "1200"),
    messages: [
      { role: "system", content: SYSTEM_BY_TONE[resolvedTone] },
      { role: "user", content: prompt },
    ],
  });

  const choice = resp.choices?.[0];
  const text = (choice?.message?.content || "").trim();

  return {
    provider: "openai",
    model,
    text,
    usage: resp.usage || {},
    finishReason: choice?.finish_reason || "stop",
  };
}

export async function buildPredictionsFromRawBundles({
  system,
  lang,
  duration,
  date,
  rangeStart,
  rangeEnd,
  signId = null,
  limit = 12,
  force = false,
  tone = "balanced",
  expertId = "oracle",
  audience_scope = "sign",
}) {
  const client = await pool.connect();
  try {
    await client.query("SET TIME ZONE 'UTC'");

    const rows = await selectRawRows(client, {
      system,
      lang,
      duration,
      date,
      rangeStart,
      rangeEnd,
      signId,
      limit,
      force,
    });

    if (!rows.length) {
      return { status: "ok", message: "No raw rows found to predict.", count: 0 };
    }

    const results = [];
    const errors = [];

    for (const r of rows) {
      const rawCacheId = r.id;

      // ✅ daily uses route date (already UTC YMD), non-daily uses range
      const requested_date =
        duration === "daily" ? date : toYMDUTC(r.range_start);
      const resolved_date =
        duration === "daily" ? date : toYMDUTC(r.range_end);

      // ✅ compute period label for daily (yesterday/today/tomorrow)
      const periodLabel =
        duration === "daily"
          ? computeDailyLabelByCompare(requested_date)
          : duration;

      // ✅ include period span for weekly/monthly/yearly so prompt knows timeframe
      const meta = {
        system: r.system,
        lang: r.lang,
        signId: r.sign_id,
        duration: r.duration,
        periodLabel, // ✅
        requested_date,
        resolved_date,
        period_start: duration === "daily" ? requested_date : toYMDUTC(r.range_start),
        period_end: duration === "daily" ? resolved_date : toYMDUTC(r.range_end),
      };

      try {
        const prompt = buildPrompt({ rawBundle: r.bundle, meta });

        const gen = await callOpenAI({ tone, expertId, prompt });

        // ✅ Guard rail: block wrong timeframe words (today/tomorrow/yesterday misuse)
        const violation = violatesTimeframeWords(gen.text, meta);
        if (violation) {
          throw new Error(`Timeframe wording violation: ${violation}`);
        }

        const parsed = safeJsonParse(gen.text);
        if (!parsed || typeof parsed !== "object") {
          throw new Error("OpenAI response was not valid JSON UiCard");
        }

        parsed.requested_date = parsed.requested_date || requested_date;
        parsed.resolved_date = parsed.resolved_date || resolved_date;

        const finalText = JSON.stringify(parsed);

        await client.query("BEGIN");

        const saved = await savePrediction(client, {
          rawRow: r,
          period: periodLabel,
          audience_scope,
          lang,
          tone,
          gen: { ...gen, text: finalText },
          promptText: prompt,
        });

        await markPredictedIfPast(client, r);

        await client.query("COMMIT");

        results.push({
          rawCacheId,
          signId: r.sign_id,
          predictionId: saved.id,
          period: periodLabel,
          date: requested_date,
        });
      } catch (e) {
        await client.query("ROLLBACK");
        errors.push({ rawCacheId, signId: r.sign_id, error: e.message });
      }
    }

    return {
      status: "ok",
      system,
      lang,
      duration,
      filter: duration === "daily" ? { date } : { rangeStart, rangeEnd },
      requested: rows.length,
      saved: results.length,
      failed: errors.length,
      results,
      errors,
    };
  } finally {
    client.release();
  }
}
