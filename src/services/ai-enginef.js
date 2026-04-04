// src/services/ai-engine.js
import OpenAI from 'openai';
import { getAiPromptCache } from '../config/aiPromptCache.js';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

console.log('[ai-engine] loaded, default model =', DEFAULT_MODEL);

/* ──────────────────────────────────────────────
 * Small helpers
 * ────────────────────────────────────────────── */
function interpolate(template = '', vars = {}) {
  if (!template) return '';
  return template.replace(/{{\s*([\w.]+)\s*}}/g, (_, key) => {
    const val = vars[key];
    return val === undefined || val === null ? '' : String(val);
  });
}

function pickRuntimeFlags(cache, serviceCode, tier) {
  if (!cache.runtimeFlags) return null;
  // exact tier match first
  let found = cache.runtimeFlags.find(
    (r) => r.service_code === serviceCode && r.tier === tier
  );
  if (!found) {
    // then generic (tier = null)
    found = cache.runtimeFlags.find(
      (r) => r.service_code === serviceCode && (r.tier === null || r.tier === undefined)
    );
  }
  return found || null;
}

function pickAstroConfig(cache, serviceRow) {
  if (!cache.astroConfigs || !serviceRow) return null;

  // 1) service-specific match
  let cfg = cache.astroConfigs.find(
    (c) => c.service_code === serviceRow.service_code
  );
  if (cfg) return cfg;

  // 2) default for that tradition
  cfg = cache.astroConfigs.find(
    (c) =>
      c.tradition === serviceRow.tradition &&
      (c.is_default === true || c.is_default === 't')
  );
  return cfg || null;
}

function pickPersona(cache, personaCode) {
  if (!cache.personas) return null;
  if (personaCode) {
    const p = cache.personas.find((x) => x.persona_code === personaCode);
    if (p) return p;
  }
  // fallback: any "soft_guide" if present
  const soft = cache.personas.find((x) => x.persona_code === 'soft_guide');
  return soft || cache.personas[0] || null;
}

function pickServiceModel(cache, serviceCode, tier) {
  if (!cache.serviceModels) return null;
  const rows = cache.serviceModels.filter(
    (m) =>
      m.service_code === serviceCode &&
      (m.tier === tier || m.tier === null || m.tier === 'ALL')
  );
  if (!rows.length) return null;
  // lowest priority_order first
  rows.sort((a, b) => (a.priority_order || 0) - (b.priority_order || 0));
  return rows[0];
}

function pickSchema(cache, serviceCode, schemaCodeFromModel) {
  if (!cache.schemas) return null;
  if (schemaCodeFromModel) {
    const s1 = cache.schemas.find((s) => s.schema_code === schemaCodeFromModel);
    if (s1) return s1;
  }
  // else: any schema bound to this service
  const s2 = cache.schemas.find((s) => s.service_code === serviceCode);
  return s2 || null;
}

/* ──────────────────────────────────────────────
 * MAIN: callAiService
 * ────────────────────────────────────────────── */
/**
 * opts = {
 *   serviceCode,
 *   tier,
 *   lang,
 *   personaCode,
 *   audience,        // 'generic' | 'personal'
 *   system,          // 'western' | 'vedic' | 'mixed'
 *   period,          // 'today','weekly', etc.
 *   topics,          // ['general', ...]
 *   extraContext: { rawJson, sign, window, callChannel, ... }
 * }
 */
export async function callAiService(opts) {
  const {
    serviceCode,
    tier = 'free',
    lang = 'en',
    personaCode,
    audience = 'generic',
    system,
    period,
    topics = ['general'],
    extraContext = {},
  } = opts || {};

  console.log('[ai-engine] callAiService()', {
    serviceCode,
    tier,
    lang,
    personaCode,
    audience,
    system,
    period,
  });

  const cache = await getAiPromptCache();

  /* ----- 1) service row ----- */
  const service = (cache.services || []).find(
    (s) => s.service_code === serviceCode
  );
  if (!service) {
    console.warn('[ai-engine] service not found in cache:', serviceCode);
  }

  /* ----- 2) persona / astro / flags ----- */
  const persona = pickPersona(cache, personaCode);
  const astroConfig = pickAstroConfig(cache, service);
  const flags = pickRuntimeFlags(cache, serviceCode, tier);

  /* ----- 3) prompts: system + user ----- */
  const allPrompts = cache.prompts || [];
  const systemPrompts = allPrompts.filter(
    (p) =>
      p.service_code === serviceCode &&
      p.role === 'system' &&
      p.language_code === lang &&
      p.is_active
  );
  const userPrompts = allPrompts.filter(
    (p) =>
      p.service_code === serviceCode &&
      p.role === 'user' &&
      p.language_code === lang &&
      p.is_active
  );

  const systemPromptRow = systemPrompts[0] || null;
  const userPromptRow = userPrompts[0] || null;

  if (!systemPromptRow || !userPromptRow) {
    console.warn('[ai-engine] missing prompt template for', {
      serviceCode,
      lang,
      hasSystem: !!systemPromptRow,
      hasUser: !!userPromptRow,
    });
  }

  /* ----- 4) model + schema ----- */
  const modelCfg = pickServiceModel(cache, serviceCode, tier);
  const modelId = modelCfg?.model_id || DEFAULT_MODEL;

  const schemaRow = pickSchema(cache, serviceCode, modelCfg?.schema_code);
  // ==========================================================
// PATCH: Only require text.format.name when NOT using schema
// ==========================================================
if (!schemaRow) {
  // service is text-mode, require text.format.name if provided
  if (opts.text && !opts.text?.format?.name) {
    throw new Error("Missing required parameter: 'text.format.name'.");
  }
}

  const schemaJson = schemaRow?.schema_json || null;
  const strictSchema =
    schemaRow && (schemaRow.strict === true || schemaRow.strict === 't');

  console.log('[ai-engine] resolved config', {
    serviceCode,
    modelId,
    hasSchema: !!schemaJson,
    strictSchema,
  });

  /* ----- 5) build variables for interpolation ----- */
  const { rawJson, sign, window, callChannel, originTag, featureId, chatScopeId } =
    extraContext;

  const vars = {
    // service
    serviceCode: service?.service_code || serviceCode,
    serviceName: service?.display_name || serviceCode,
    tradition: service?.tradition || system || 'mixed',
    scope: service?.scope || 'sign_based',
    granularity: service?.granularity || period || 'daily',
    output_shape: service?.output_shape || 'long_form_text',

    // persona
    persona: persona?.persona_code || personaCode || '',
    personaName: persona?.display_name || '',
    tone_keywords: persona?.tone_keywords || '',
    reading_style: persona?.reading_style || '',
    formality_level: persona?.formality_level || '',

    // astro config
    zodiac_system: astroConfig?.zodiac_system || '',
    ayanamsha: astroConfig?.ayanamsha || '',
    house_system: astroConfig?.house_system || '',
    planets_allowed: Array.isArray(astroConfig?.planets_allowed)
      ? astroConfig.planets_allowed.join(', ')
      : '',
    aspects_to_consider: astroConfig?.aspects_to_consider || '',
    style_keywords: astroConfig?.style_keywords || '',
    bhava_focus: astroConfig?.bhava_focus || '',
    house_focus: astroConfig?.house_focus || '',
    avoid_topics: astroConfig?.avoid_topics || '',

    // call context
    lang,
    audience,
    system,
    period,
    topicsCsv: topics.join(','),
    sign,
    dateISO: window?.start || '',

    // meta
    callChannel: callChannel || '',
    originTag: originTag || '',
    featureId: featureId || '',
    chatScopeId: chatScopeId || '',

    // raw payload
    rawJson: rawJson ? JSON.stringify(rawJson).slice(0, 8000) : '',
  };

  const systemTemplate =
    systemPromptRow?.template_text ||
    'You are an astrology assistant. Return helpful, safe output.';
  const userTemplate =
    userPromptRow?.template_text ||
    'Generate a response for {{serviceCode}} in JSON with fields that match the agreed schema.';

  const systemText = interpolate(systemTemplate, vars);
  const userText = interpolate(userTemplate, vars);

  const inputMessages = [
    { role: 'system', content: systemText },
    { role: 'user', content: userText },
  ];

  /* ----- 6) call OpenAI Responses API ----- */
    try {
    let resp;

    if (schemaJson) {
      // 🎯 CASE 1: Strict JSON schema mode
      resp = await openai.responses.create({
        model: modelId,
        input: inputMessages,
        temperature:
          modelCfg?.temperature !== undefined
            ? Number(modelCfg.temperature)
            : 0.2,
        max_output_tokens: modelCfg?.max_tokens_output ?? undefined,

        // ✅ Correct Responses API format
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: schemaRow?.schema_code || serviceCode || 'HoroscopeSchema',
            schema: schemaJson,
            strict: strictSchema ?? true,
          },
        },
      });
    } else {
      // 🎯 CASE 2: Fallback – generic JSON object
      resp = await openai.responses.create({
        model: modelId,
        input: inputMessages,
        temperature:
          modelCfg?.temperature !== undefined
            ? Number(modelCfg.temperature)
            : 0.3,
        max_output_tokens: modelCfg?.max_tokens_output ?? undefined,

        // ✅ Only ask for a JSON object
        response_format: {
          type: 'json_object',
        },
      });
    }

    // 🔹 Extract the first text content block
    const content = resp.output?.[0]?.content?.[0];
    const textOut = content?.text ?? '';

    let jsonOut = null;
    try {
      jsonOut = textOut ? JSON.parse(textOut) : null;
    } catch {
      jsonOut = null;
    }

    const usage = resp.usage || null;

    return {
      ok: true,
      responseText: textOut,
      responseJson: jsonOut,
      modelId,
      usage,
      rawResponse: resp,

      userPromptText: userText,
      systemPromptText: systemText,
      usedPromptCodes: {
        system: systemPromptRow?.prompt_code || null,
        user: userPromptRow?.prompt_code || null,
      },
      providerCode: 'openai',
      schemaCode: schemaRow?.schema_code || null,
    };
  } catch (err) {
    console.error('[ai-engine] OpenAI call failed', err?.response?.data || err);
    throw err;
  }

}

export default { callAiService };
