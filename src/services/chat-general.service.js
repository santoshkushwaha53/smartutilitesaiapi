// src/services/chat-general.service.js
import { callAiService } from './ai-engine.js';

export async function chatGeneralAstro({
  userId,
  sessionId,
  userMessage,
  tier = 'free',
  languageCode = 'en',
}) {
  const context = {
    userId,
    sessionId,
    userMessage,
  };

  const { parsed } = await callAiService({
    serviceCode: 'CHAT_GENERAL_ASTRO',
    tier,
    languageCode,
    tradition: 'mixed',
    context,
    mode: 'chat', // for now behaves same as 'single'
  });

  // parsed.replyText from CHAT_GENERAL_ASTRO_JSON
  return parsed;
}
