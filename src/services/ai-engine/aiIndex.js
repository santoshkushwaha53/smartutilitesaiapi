// src/services/ai-engine/aiIndex.js

/**
 * 🌌 Global AI "oracle" wrapper for SohumAstroAI.
 *
 * ▶ Primary function (recommended):
 *      writePrediction(payload)
 *
 *    Used by:
 *      - Horoscope (/api/horoscope/get, /ai/get)
 *      - Future: tarot, numerology, chat, etc.
 *
 * ▶ Legacy / advanced:
 *      callAiService(opts)
 *
 *    Direct low-level call to the AI engine. Still exported for
 *    existing code, but for new APIs you should use writePrediction().
 */

// 🔹 Internal engine that knows about prompts, schemas, models, cache, etc.
import { callAiService } from './aiEngine.js';

/**
 * Standard payload contract for ALL prediction calls.
 *
 * payload = {
 *   serviceCode: string,          // e.g. 'HORO_DAILY_VEDIC', 'CHAT_GENERAL'
 *   tier?: 'free' | 'lite' | 'pro' | string,
 *   lang?: string,
 *   personaCode?: string,
 *   audience?: 'generic' | 'personal',
 *   system?: string,
 *   period?: string,
 *   topics?: string[],
 *   rawJson?: any,                // raw provider JSON (Prokerala, etc.)
 *   sign?: string | null,
 *   window?: { start: string, end: string } | null,
 *   callChannel?: string,         // 'backend' | 'user' | 'cron' | etc.
 *   originTag?: string,           // e.g. 'horoscope-get-generic'
 *   featureId?: string,           // e.g. 'daily-horoscope'
 *   chatScopeId?: string | null,  // for chat sessions (future)
 * }
 *
 * RETURNS:
 *   {
 *     ok: boolean,
 *     text: string,               // main text body
 *     json: any | null,           // parsed JSON (if schema/json mode)
 *     model: string | null,       // model id actually used
 *     usage: any | null,          // tokens / cost info
 *     raw: any,                   // raw OpenAI response
 *     userPromptText: string,
 *     systemPromptText: string,
 *     usedPromptCodes: { system: string|null, user: string|null },
 *     providerCode: string | null,
 *     schemaCode: string | null,
 *   }
 */
export async function writePrediction(payload = {}) {
  const {
    serviceCode,
    tier = 'free',
    lang = 'en',
    personaCode,
    audience = 'generic',
    system,
    period,
    topics = ['general'],

    rawJson,
    sign,
    window,
    callChannel,
    originTag,
    featureId,
    chatScopeId,
  } = payload;

  if (!serviceCode) {
    throw new Error('writePrediction: serviceCode is required');
  }
  // =====================================================
  // PATCH: auto-assign text.format.name ONLY for text-mode
  // =====================================================
  const DEFAULT_TEXT_FORMATS = {
    HORO_DAILY_WESTERN: 'HORO_DAILY_WESTERN_SYS_V1',
    HORO_DAILY_VEDIC: 'HORO_DAILY_VEDIC_SYS_V1',
    HORO_WEEKLY_WESTERN: 'HORO_WEEKLY_WESTERN_SYS_V1',
    HORO_WEEKLY_VEDIC: 'HORO_WEEKLY_VEDIC_SYS_V1',
    AUSPICIOUS_ALL_SIGNS: 'AUSPICIOUS_ALL_SIGNS_SYS_V1',
    AUSPICIOUS_ONE_SIGN: 'AUSPICIOUS_ONE_SIGN_SYS_V1',
    BIRTH_CHART_SUMMARY: 'BIRTH_CHART_SUMMARY_SYS_V1',
    BIRTH_CHART_DETAILED: 'BIRTH_CHART_DETAILED_SYS_V1',
    MATCHMAKING_VEDIC: 'MATCHMAKING_VEDIC_SYS_V1',
    CHAT_GENERAL_ASTRO: 'CHAT_GENERAL_ASTRO_SYS_V1',
  };

  // textFormatName is optional → only used for text services
  const autoFormat =
    DEFAULT_TEXT_FORMATS[serviceCode] || null;

  const textBlock =
    autoFormat
      ? {
          text: {
            format: { name: autoFormat },
          },
        }
      : {};

  // 🔁 Delegate to the core AI engine
  const result = await callAiService({
    serviceCode,
    tier,
    lang,
    personaCode,
    audience,
    system,
    period,
    topics,
    extraContext: {
      rawJson,
      sign,
      window,
      callChannel,
      originTag,
      featureId,
      chatScopeId,
    },
  });

  // 🔙 Normalize the shape for all callers
  return {
    ok: !!result.ok,
    text: result.responseText || '',
    json: result.responseJson ?? null,
    model: result.modelId || null,
    usage: result.usage || null,

    raw: result.rawResponse,
    userPromptText: result.userPromptText,
    systemPromptText: result.systemPromptText,
    usedPromptCodes: result.usedPromptCodes || {},
    providerCode: result.providerCode || null,
    schemaCode: result.schemaCode || null,
  };
}

/**
 * 🔁 Re-export the low-level engine call for legacy / advanced usage.
 * This keeps existing imports working:
 *
 *   import { callAiService } from '../src/services/ai-engine/aiIndex.js';
 */
export { callAiService } from './aiEngine.js';

/**
 * 🧩 Default export: bundle both for convenience
 *
 *   import aiEngine from '../src/services/ai-engine/aiIndex.js';
 *   await aiEngine.writePrediction(...);
 */
export default {
  writePrediction,
  callAiService,
};
