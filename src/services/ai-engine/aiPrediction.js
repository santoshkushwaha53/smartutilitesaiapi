// src/services/ai-service/aiPrediction.js
import { callAiService as predictWithService } from './aiIndex.js';


/**
 * Map old (system, period) into your new service codes
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
  // fallback: daily
  return sys === 'vedic' ? 'HORO_DAILY_VEDIC' : 'HORO_DAILY_WESTERN';
}

/**
 * Basic tone → persona mapping
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
 * UNIVERSAL prediction method for all AI services
 * You call this from any route or feature:
 *
 *   writePrediction({
 *     serviceCode: 'YOUR_SERVICE',
 *     rawJson,
 *     lang:'en',
 *     tone:'concise',
 *     system:'western',
 *     period:'today'
 *   })
 */
export async function writePrediction({
  serviceCode,     // optional → auto detect for horoscope
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
  audienceScope   // 'generic' | 'personal'
}) {
  // Auto-resolve only when serviceCode not provided
  if (!serviceCode) {
    serviceCode = resolveServiceCode({ system, period });
  }

  const personaCode = resolvePersonaCode(tone);
  const tier = 'free'; // later from subscription

  const result = await predictWithService({
    serviceCode,
    rawJson,
    tier,
    lang,
    audience: audienceScope || 'generic',
    personaCode,
    system,
    period,
    topics: ['general'],
    extraContext: {
      sign,
      window,
      callChannel,
      originTag,
      featureId,
      chatScopeId,
    },
  });

  return {
    text: result.text,
    json: result.json,
    model: result.model || model || null,
    usage: result.usage || null,
  };
}

export default { writePrediction };
