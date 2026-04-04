// src/services/ai-engine/aiEngine.js
import OpenAI from 'openai';
import { getAiPromptCache } from '../../config/aiPromptCache.js';

/* ──────────────────────────────────────────────
 * OpenAI client + default model
 * ────────────────────────────────────────────── */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

console.log('[ai-engine] loaded, default model =', DEFAULT_MODEL);

/* ──────────────────────────────────────────────
 * Small helpers
 * ────────────────────────────────────────────── */

/**
 * Simple string interpolation:
 * Replaces {{varName}} in a template with values from vars.
 *
 * Example:
 *  template = "Hello {{name}}"
 *  vars = { name: "Santosh" }
 *  -> "Hello Santosh"
 */
function interpolate(template = '', vars = {}) {
  if (!template) return '';
  return template.replace(/{{\s*([\w.]+)\s*}}/g, (_, key) => {
    const val = vars[key];
    return val === undefined || val === null ? '' : String(val);
  });
}

/**
 * Pick runtime flags for a (service_code, tier) from cache.
 */
function pickRuntimeFlags(cache, serviceCode, tier) {
  if (!cache.runtimeFlags) return null;

  // 1) Try exact match: service + tier
  let found = cache.runtimeFlags.find(
    (r) => r.service_code === serviceCode && r.tier === tier
  );

  // 2) Fallback: service + null tier (applies to all tiers)
  if (!found) {
    found = cache.runtimeFlags.find(
      (r) =>
        r.service_code === serviceCode &&
        (r.tier === null || r.tier === undefined)
    );
  }
  return found || null;
}

/**
 * Pick astro configuration for this service:
 */
function pickAstroConfig(cache, serviceRow) {
  if (!cache.astroConfigs || !serviceRow) return null;

  // 1) Config explicitly tied to this service_code
  let cfg = cache.astroConfigs.find(
    (c) => c.service_code === serviceRow.service_code
  );
  if (cfg) return cfg;

  // 2) Fallback: default config for the same tradition (vedic/western)
  cfg = cache.astroConfigs.find(
    (c) =>
      c.tradition === serviceRow.tradition &&
      (c.is_default === true || c.is_default === 't')
  );
  return cfg || null;
}

/**
 * Pick persona (tone / style) to use in the prompt.
 */
function pickPersona(cache, personaCode) {
  if (!cache.personas) return null;

  if (personaCode) {
    const p = cache.personas.find((x) => x.persona_code === personaCode);
    if (p) return p;
  }

  // Fallback: hard-coded default persona
  const soft = cache.personas.find((x) => x.persona_code === 'soft_guide');
  return soft || cache.personas[0] || null;
}

/**
 * Pick which OpenAI model to use for (service_code, tier).
 */
function pickServiceModel(cache, serviceCode, tier) {
  if (!cache.serviceModels) return null;

  // Filter rows by service + tier (or tier=ALL / null)
  const rows = cache.serviceModels.filter(
    (m) =>
      m.service_code === serviceCode &&
      (m.tier === tier || m.tier === null || m.tier === 'ALL')
  );
  if (!rows.length) return null;

  // Lower priority_order = higher priority model
  rows.sort((a, b) => (a.priority_order || 0) - (b.priority_order || 0));
  return rows[0];
}

/**
 * Pick JSON schema configuration for the service.
 */
function pickSchema(cache, serviceCode, schemaCodeFromModel) {
  if (!cache.schemas) return null;

  // 1) If model explicitly points to a schema_code, use that
  if (schemaCodeFromModel) {
    const s1 = cache.schemas.find((s) => s.schema_code === schemaCodeFromModel);
    if (s1) return s1;
  }

  // 2) Otherwise, find schema attached to this service_code
  const s2 = cache.schemas.find((s) => s.service_code === serviceCode);
  return s2 || null;
}

/* ──────────────────────────────────────────────
 * MAIN: callAiService
 * ────────────────────────────────────────────── */

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

  // 🔹 0) Load everything from your in-memory JSON cache
  const cache = await getAiPromptCache();

  /* ----- 1) Resolve "service" row from cache ----- */
  const service = (cache.services || []).find(
    (s) => s.service_code === serviceCode
  );
  if (!service) {
    console.warn('[ai-engine] service not found in cache:', serviceCode);
  }

  /* ----- 2) From cache: persona, astro config, runtime flags ----- */
  const persona = pickPersona(cache, personaCode);
  const astroConfig = pickAstroConfig(cache, service);
  const flags = pickRuntimeFlags(cache, serviceCode, tier);
  // flags is available if you later want to tweak behavior

  /* ──────────────────────────────────────────────
   * 3) BUILD PROMPTS FROM JSON CACHE
   * ────────────────────────────────────────────── */

  const allPrompts = cache.prompts || [];

  // SYSTEM prompts: role='system', per service + language
  const systemPrompts = allPrompts.filter(
    (p) =>
      p.service_code === serviceCode &&
      p.role === 'system' &&
      p.language_code === lang &&
      p.is_active
  );

  // USER prompts: role='user', per service + language
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

  /* ----- 4) From cache: model + JSON schema to use ----- */
  const modelCfg = pickServiceModel(cache, serviceCode, tier);
  const modelId = modelCfg?.model_id || DEFAULT_MODEL;

  const schemaRow = pickSchema(cache, serviceCode, modelCfg?.schema_code);

  // 🔹 NEW: safely parse & patch schema_json
  let schemaJson = null;
  let strictSchema = false;
  let useSchema = false;

  if (schemaRow && schemaRow.schema_json) {
    try {
      // Parse string → object if needed
      schemaJson =
        typeof schemaRow.schema_json === 'string'
          ? JSON.parse(schemaRow.schema_json)
          : schemaRow.schema_json;

      strictSchema =
        schemaRow.strict === true ||
        schemaRow.strict === 't' ||
        schemaRow.strict === 'true';

      if (
        schemaJson &&
        typeof schemaJson === 'object' &&
        !Array.isArray(schemaJson)
      ) {
        // 🔧 For strict schemas, OpenAI requires additionalProperties=false at root
        if (strictSchema) {
          const hasAdditional = Object.prototype.hasOwnProperty.call(
            schemaJson,
            'additionalProperties'
          );
          if (!hasAdditional || schemaJson.additionalProperties !== false) {
            schemaJson.additionalProperties = false;
            console.log(
              '[ai-engine] patched schemaJson.additionalProperties=false for',
              schemaRow.schema_code
            );
          }
        }

        useSchema = true;
      }
    } catch (e) {
      console.warn(
        '[ai-engine] failed to parse schema_json, disabling schema for',
        schemaRow?.schema_code,
        e
      );
      schemaJson = null;
      strictSchema = false;
      useSchema = false;
    }
  }

  console.log('[ai-engine] resolved config', {
    serviceCode,
    modelId,
    hasSchema: !!schemaJson,
    strictSchema,
    useSchema,
  });

  /* ----- 5) Build interpolation variables for prompt templates ----- */

  const {
    rawJson,
    sign,
    window,
    callChannel,
    originTag,
    featureId,
    chatScopeId,
  } = extraContext;

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

    // call context (request context)
    lang,
    audience,
    system,
    period,
    topicsCsv: topics.join(','), // often used in prompts: "topics: {{topicsCsv}}"
    sign,
    dateISO: window?.start || '',

    // meta
    callChannel: callChannel || '',
    originTag: originTag || '',
    featureId: featureId || '',
    chatScopeId: chatScopeId || '',

    // raw payload (truncated to avoid huge tokens)
    rawJson: rawJson ? JSON.stringify(rawJson).slice(0, 8000) : '',
  };

  // Default fallbacks if DB templates are missing
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

  /* ──────────────────────────────────────────────
   * 6) Call OpenAI Responses API
   * ────────────────────────────────────────────── */

  try {
    const temp =
      modelCfg?.temperature !== undefined && modelCfg?.temperature !== null
        ? Number(modelCfg.temperature)
        : useSchema
        ? 0.2
        : 0.3;

    const baseRequest = {
      model: modelId,
      input: inputMessages,
      temperature: temp,
      max_output_tokens: modelCfg?.max_tokens_output ?? undefined,
    };

    // 🔧 Build text.format in the new API shape
    let textFormat;
    if (useSchema && schemaJson) {
      // strict JSON schema mode
      textFormat = {
        type: 'json_schema',
        name: schemaRow?.schema_code || serviceCode || 'HoroscopeSchema',
        schema: schemaJson,
        strict: strictSchema === true,
      };
    } else {
      // free-form JSON object
      textFormat = {
        type: 'json_object',
      };
    }

    const openAiRequest = {
      ...baseRequest,
      text: {
        format: textFormat,
      },
    };

    // 🔍 LOG: exact payload we send to OpenAI
    console.log(
      '[ai-engine] OpenAI payload:',
      JSON.stringify(openAiRequest, null, 2)
    );

    const resp = await openai.responses.create(openAiRequest);

    // 🔹 Extract the first text content block
    const firstOutput = resp.output?.[0];
    const firstContent = firstOutput?.content?.[0];

    let textOut = '';
    if (firstContent) {
      // Support both older shape (text:string) and new (text:{value})
      if (typeof firstContent.text === 'string') {
        textOut = firstContent.text;
      } else if (
        firstContent.text &&
        typeof firstContent.text.value === 'string'
      ) {
        textOut = firstContent.text.value;
      }
    }

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
      schemaCode: useSchema && schemaRow ? schemaRow.schema_code || null : null,
    };
  } catch (err) {
    console.error(
      '[ai-engine] OpenAI call failed',
      err?.response?.data || err
    );
    throw err;
  }ç
}

export default { callAiService };
