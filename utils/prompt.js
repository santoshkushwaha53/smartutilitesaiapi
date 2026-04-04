// utils/prompt.js
import { query } from '../src/db.js'; // only used for legacy table
import { getAiPromptCache } from '../src/config/aiPromptCache.js';

/* ──────────────────────────────────────────────
 * Simple {{var}} templating for DB prompts
 * ────────────────────────────────────────────── */
function renderTemplate(tpl, ctx) {
  if (!tpl) return '';
  return tpl.replace(/{{\s*([\w.]+)\s*}}/g, (_, key) => {
    const val = ctx[key];
    return val == null ? '' : String(val);
  });
}

/* Helper: random A/B split for experiments */
function pickVariantCode(expRow) {
  if (!expRow) return null;
  const pA = Number(expRow.traffic_split_a ?? 0.5);
  const r = Math.random();
  return r < pA ? expRow.variant_a_prompt_code : expRow.variant_b_prompt_code;
}

/* ──────────────────────────────────────────────
 * Lookups INTO the JSON cache
 * (no DB hits here)
 * ────────────────────────────────────────────── */

function findService(cache, serviceCode) {
  return cache.services.find(s => s.service_code === serviceCode) || null;
}

function findAstroConfig(cache, serviceCode, tradition) {
  if (!tradition) return null;
  // Prefer service-specific row; else default (service_code NULL, is_default true)
  let best = null;
  for (const row of cache.astroConfigs) {
    if (row.tradition !== tradition) continue;
    if (row.service_code === serviceCode) {
      if (!best || best.service_code === null) best = row;
    } else if (!row.service_code && row.is_default && !best) {
      best = row;
    }
  }
  return best;
}

function findRuntimeFlags(cache, serviceCode, tier) {
  let best = null;
  for (const row of cache.runtimeFlags) {
    if (row.service_code !== serviceCode) continue;
    if (row.tier && row.tier !== tier) continue;
    if (!best) best = row;
    else if (best.tier === null && row.tier) best = row; // prefer tier-specific
  }
  return best;
}

function findPersonaBinding(cache, serviceCode, tier, languageCode) {
  // If you created app_persona_binding and added to cache, handle here
  const bindings = cache.personaBindings || [];
  let best = null;
  for (const row of bindings) {
    if (row.service_code !== serviceCode) continue;
    if (row.language_code !== languageCode) continue;
    if (row.tier && row.tier !== tier) continue;
    if (!best) best = row;
    else if (best.tier === null && row.tier) best = row;
  }
  return best?.persona_code || null;
}

function findPersona(cache, personaCode) {
  if (!personaCode) return null;
  return cache.personas.find(p => p.persona_code === personaCode) || null;
}

function findActiveExperiment(cache, serviceCode) {
  const now = new Date();
  return (
    cache.experiments.find(exp => {
      if (exp.service_code !== serviceCode) return false;
      if (!exp.is_active) return false;
      if (exp.start_date && new Date(exp.start_date) > now) return false;
      if (exp.end_date && new Date(exp.end_date) < now) return false;
      return true;
    }) || null
  );
}

function findPromptTemplate(cache, {
  serviceCode,
  role,
  languageCode,
  tradition,
  personaCode,
  promptCode,
}) {
  let candidates = cache.prompts.filter(p =>
    p.service_code === serviceCode &&
    p.role === role &&
    p.language_code === languageCode &&
    p.is_active
  );

  if (tradition) {
    candidates = candidates.filter(p => !p.tradition || p.tradition === tradition);
  }
  if (personaCode) {
    candidates = candidates.filter(p => !p.persona_code || p.persona_code === personaCode);
  }
  if (promptCode) {
    candidates = candidates.filter(p => p.prompt_code === promptCode);
  }

  if (!candidates.length) return null;

  // Highest version first
  candidates.sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
  return candidates[0];
}

/* ──────────────────────────────────────────────
 * NEW: Fetch prompt from cached templates
 * ────────────────────────────────────────────── */
async function fetchNewPromptTemplate({
  serviceCode,
  role,
  languageCode = 'en',
  tradition = null,
  personaCode = null,
  promptCode = null,
  ctx = {},
}) {
  const cache = await getAiPromptCache();

  const tmplRow = findPromptTemplate(cache, {
    serviceCode,
    role,
    languageCode,
    tradition,
    personaCode,
    promptCode,
  });

  if (!tmplRow) return null;

  const effectivePersonaCode = personaCode || tmplRow.persona_code || null;

  if (effectivePersonaCode) {
    const persona = findPersona(cache, effectivePersonaCode);
    if (persona) {
      ctx = {
        ...ctx,
        personaCode: effectivePersonaCode,
        persona_tone_keywords: persona.tone_keywords,
        persona_reading_style: persona.reading_style,
        persona_formality: persona.formality_level,
        persona_length_multiplier: persona.max_output_length_multiplier,
      };
    }
  }

  return renderTemplate(tmplRow.template_text, ctx);
}

/* ──────────────────────────────────────────────
 * LEGACY: old llm_prompt_template table (still DB)
 * ────────────────────────────────────────────── */
async function fetchLegacyPrompt({ purpose, period, lang, tone, isSystem }) {
  const { rows } = await query(
    `
    SELECT template
    FROM public.llm_prompt_template
    WHERE purpose   = $1
      AND period    = $2
      AND lang      = $3
      AND tone      = $4
      AND is_system = $5
      AND is_active
    ORDER BY updated_at DESC
    LIMIT 1
    `,
    [purpose, period, lang, tone, isSystem]
  );
  return rows?.[0]?.template || null;
}

/* ──────────────────────────────────────────────
 * Hardcoded defaults (final fallback)
 * ────────────────────────────────────────────── */
function defaultSystem({ period, lang, tone }) {
  return [
    `You are an expert astrologer.`,
    `Return STRICT JSON that matches the schema.`,
    `Style: ${tone}. Audience: generic. Language: ${lang}. Period: ${period}.`,
    `Include 8 categories (general,love,relationships,career,money,health,wellness,luck).`,
    `Each category must have: score_percent (0-100 int), summary (2-3 sentences), tips (2 items),`,
    `do (3 items), dont (3 items), lucky_color (simple term), lucky_number (1 digit).`,
    `Also include: planet_status[] with {body,sign,degree,retrograde,note},`,
    `and planet_movements with since_yesterday[] and into_tomorrow[].`,
    `Avoid medical/financial prescriptions; keep guidance general and uplifting.`
  ].join(' ');
}

function defaultUser({ period, lang, tone, sign, system, window, planetStatus, movements }) {
  return JSON.stringify({
    sign,
    system,
    period,
    window,
    planet_status: planetStatus,
    planet_movements: movements,
    categories: ['general','love','relationships','career','money','health','wellness','luck'],
    requirements: {
      each_category: {
        score_percent: '0-100 integer',
        summary: '2-3 sentences',
        tips: '2 items',
        do: '3 items',
        dont: '3 items',
        lucky_color: 'simple color word',
        lucky_number: 'digit 1-9'
      }
    }
  });
}

/* ──────────────────────────────────────────────
 * PUBLIC: buildMessages(opts)
 * ────────────────────────────────────────────── */
export async function buildMessages(opts) {
  const {
    // NEW-style
    serviceCode = 'HORO_DAILY_WESTERN',
    tier = 'free',
    languageCode = opts.lang || 'en',
    tradition: explicitTradition = null,
    personaCode: explicitPersona = null,

    // legacy
    period,
    lang = languageCode,
    tone = 'soft',
    sign,
    system,
    window,
    planetStatus,
    movements,
  } = opts;

  const cache = await getAiPromptCache();

  const serviceMeta = findService(cache, serviceCode);
  const runtimeFlags = findRuntimeFlags(cache, serviceCode, tier);
  const personaFromBinding = findPersonaBinding(cache, serviceCode, tier, languageCode);
  const experiment = findActiveExperiment(cache, serviceCode);

  const tradition =
    explicitTradition ||
    serviceMeta?.tradition ||
    null;

  const astroConfig = findAstroConfig(cache, serviceCode, tradition);
  const personaCode =
    explicitPersona ||
    personaFromBinding ||
    null;

  const chosenPromptCode = experiment ? pickVariantCode(experiment) : null;

  const ctx = {
    // core
    serviceCode,
    tier,
    languageCode,
    tradition,
    period,
    lang,
    tone,
    sign,
    system,
    window,
    planet_status: planetStatus,
    planet_movements: movements,

    // from service meta
    service_display_name: serviceMeta?.display_name,
    service_scope: serviceMeta?.scope,
    service_granularity: serviceMeta?.granularity,
    service_output_shape: serviceMeta?.output_shape,
    service_expected_length: serviceMeta?.expected_length,
    service_complexity_level: serviceMeta?.complexity_level,
    service_use_case: serviceMeta?.use_case,
    service_is_chat: serviceMeta?.is_chat_service,

    // from astro config
    zodiac_system: astroConfig?.zodiac_system,
    ayanamsha: astroConfig?.ayanamsha,
    house_system: astroConfig?.house_system,
    planets_allowed: astroConfig?.planets_allowed,
    aspects_to_consider: astroConfig?.aspects_to_consider,
    astro_style_keywords: astroConfig?.style_keywords,
    astro_bhava_focus: astroConfig?.bhava_focus,
    astro_house_focus: astroConfig?.house_focus,
    astro_avoid_topics: astroConfig?.avoid_topics,

    // runtime flags
    runtime_allow_followup: runtimeFlags?.allow_followup_questions,
    runtime_include_disclaimer: runtimeFlags?.include_disclaimer,
    runtime_allow_user_context: runtimeFlags?.allow_user_context,
    runtime_max_context_turns: runtimeFlags?.max_context_turns,
    runtime_truncate_strategy: runtimeFlags?.truncate_strategy,
    runtime_include_birth_chart_context: runtimeFlags?.include_birth_chart_context,
    runtime_include_daily_context: runtimeFlags?.include_daily_context,
    runtime_include_auspicious_context: runtimeFlags?.include_auspicious_context,
  };

  // 1) NEW config-based prompts from JSON cache
  let systemPrompt = await fetchNewPromptTemplate({
    serviceCode,
    role: 'system',
    languageCode,
    tradition,
    personaCode,
    promptCode: chosenPromptCode,
    ctx,
  });

  let userPrompt = await fetchNewPromptTemplate({
    serviceCode,
    role: 'user',
    languageCode,
    tradition,
    personaCode,
    promptCode: chosenPromptCode,
    ctx,
  });

  // 2) Legacy DB prompts if new is missing
  if (!systemPrompt || !userPrompt) {
    const systemLegacy = await fetchLegacyPrompt({
      purpose: 'horoscope_prediction',
      period,
      lang,
      tone,
      isSystem: true,
    });
    const userLegacy = await fetchLegacyPrompt({
      purpose: 'horoscope_prediction',
      period,
      lang,
      tone,
      isSystem: false,
    });

    if (!systemPrompt) systemPrompt = systemLegacy;
    if (!userPrompt)   userPrompt   = userLegacy;
  }

  // 3) Final hardcoded fallback
  if (!systemPrompt) {
    systemPrompt = defaultSystem({ period, lang, tone });
  }
  if (!userPrompt) {
    userPrompt = defaultUser({
      period,
      lang,
      tone,
      sign,
      system,
      window,
      planetStatus,
      movements,
    });
  }

  return { system: systemPrompt, user: userPrompt };
}
