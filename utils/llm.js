// utils/llm.js
import { callAiService } from '../src/services/ai-engine/aiIndex.js';

/**
 * Map old (system, period) into your new service codes
 * using your app_ai_service_master seed data.
 */
function resolveServiceCode({ system, period }) {
  const sys = String(system || 'western').toLowerCase();
  const per = String(period || 'today').toLowerCase();

  if (per === 'today') {
    return sys === 'vedic' ? 'HORO_DAILY_VEDIC' : 'HORO_DAILY_WESTERN';
  }
  if (per === 'weekly') {
    return sys === 'vedic' ? 'HORO_WEEKLY_VEDIC' : 'HORO_WEEKLY_WESTERN';
  }
  // fallback: daily style
  return sys === 'vedic' ? 'HORO_DAILY_VEDIC' : 'HORO_DAILY_WESTERN';
}

/**
 * Basic tone → persona mapping (you can tweak later)
 */
function resolvePersonaCode(tone) {
  const t = String(tone || '').toLowerCase();
  if (t.includes('devotional') || t.includes('vedic')) return 'astro_pandit';
  if (t.includes('business')) return 'business_mentor';
  if (t.includes('therapy') || t.includes('soft')) return 'astro_therapist';
  if (t.includes('story')) return 'cosmic_storyteller';
  return 'soft_guide';
}

/**
 * Global helper: given raw JSON (Prokerala / whatever),
 * ask the engine to generate prediction in JSON.
 */
export async function writePredictionFromRaw({
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
  audienceScope, // 'generic' | 'personal'
}) {
  const serviceCode = resolveServiceCode({ system, period });
  const personaCode = resolvePersonaCode(tone);
  const tier = 'free'; // later: derive from user’s plan

  try {
    const result = await callAiService({
      serviceCode,
      tier,
      lang,
      personaCode,
      audience: audienceScope || 'generic',
      system,
      period,
      topics: ['general'],
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

    return {
      text: result.responseText,
      json: result.responseJson,
      model: result.modelId || model || null,
      usage: result.usage || null,
    };
  } catch (err) {
    console.error('[llm.writePredictionFromRaw] engine failed', err);
    return {
      text: '[unavailable] ' + (err?.message || 'prediction_failed'),
      json: null,
      model: model ? `${model} (error)` : null,
      usage: null,
    };
  }
}

export default { writePredictionFromRaw };
