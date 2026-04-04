// src/services/aiApiLog.service.js
import crypto from 'node:crypto';
import { query } from '../db.js';

function safeJson(v) {
  try {
    return JSON.parse(JSON.stringify(v ?? {}));
  } catch {
    return {};
  }
}

function now() {
  return new Date();
}

export function newRequestId() {
  return crypto.randomUUID();
}

/**
 * Common logging method for ANY AI call (OpenAI, etc.)
 *
 * @param {object} p
 * @param {string} p.userId              email
 * @param {string|null} p.sessionId      optional (from header)
 * @param {string|null} p.requestId      optional (if not passed, generate)
 * @param {string} p.provider            'openai'
 * @param {string} p.apiType             'chat' | 'responses' | 'embeddings'
 * @param {string} p.apiSource           'web' | 'mobile' | 'admin' | 'cron'
 * @param {string} p.endpoint            '/v1/chat/completions'
 * @param {string} p.model               'gpt-4o-mini'
 * @param {string} p.promptText          short prompt summary (recommended)
 * @param {number} p.promptTokens
 * @param {number} p.inputTokens
 * @param {number} p.outputTokens
 * @param {number} p.totalTokens
 * @param {Date}   p.startedAt
 * @param {Date}   p.endedAt
 * @param {number} p.executionMs
 * @param {number|null} p.costUsd
 * @param {string} p.status              'success' | 'failed'
 * @param {number} p.httpStatus
 * @param {object} p.requestPayload
 * @param {object} p.responsePayload
 * @param {object} p.metadata            feature info etc.
 */
export async function logAiApiCall(p) {
  const requestId = p.requestId || newRequestId();

  await query(
    `
    INSERT INTO public.ai_api_call_log (
      user_id, session_id, request_id,
      provider, api_type, api_source, endpoint, model,
      prompt_text, prompt_tokens, input_tokens, output_tokens, total_tokens,
      started_at, ended_at, execution_ms,
      cost_usd, status, http_status,
      request_payload, response_payload, metadata
    ) VALUES (
      $1,$2,$3,
      $4,$5,$6,$7,$8,
      $9,$10,$11,$12,$13,
      $14,$15,$16,
      $17,$18,$19,
      $20::jsonb,$21::jsonb,$22::jsonb
    )
    `,
    [
      p.userId ? String(p.userId) : null,
      p.sessionId ? String(p.sessionId) : null,
      requestId,

      String(p.provider || 'openai'),
      String(p.apiType || 'chat'),
      String(p.apiSource || 'web'),
      String(p.endpoint || ''),
      String(p.model || ''),

      String(p.promptText || ''),
      Number(p.promptTokens || 0),
      Number(p.inputTokens || 0),
      Number(p.outputTokens || 0),
      Number(p.totalTokens || 0),

      p.startedAt || now(),
      p.endedAt || now(),
      Number(p.executionMs || 0),

      p.costUsd ?? null,
      String(p.status || 'success'),
      Number(p.httpStatus || 200),

      safeJson(p.requestPayload),
      safeJson(p.responsePayload),
      safeJson(p.metadata)
    ]
  );

  return requestId;
}
