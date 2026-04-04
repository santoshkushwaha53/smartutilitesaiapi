// src/services/daily-western.service.js
import { callAiService } from './ai-engine.js';

export async function getDailyWestern({ sign, dateISO, tier = 'free' }) {
  const { parsed } = await callAiService({
    serviceCode: 'HORO_DAILY_WESTERN',
    tier,
    languageCode: 'en',
    tradition: 'western',
    context: { sign, dateISO },
    mode: 'single',
  });

  // parsed will follow DAILY_SIGN_JSON schema
  return parsed;
}
