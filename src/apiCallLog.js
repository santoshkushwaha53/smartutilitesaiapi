// src/apiCallLog.js
import { query } from './db.js';

/**
 * Insert a log row when an external API call starts.
 * Returns inserted id so we can update at the end.
 */
export async function logApiCallStart(meta = {}) {
  const {
    providerId,
    providerName = null,
    featureId = null,
    chatScopeId = null,
    audienceScope = null,

    endpoint = null,
    method = null,

    requestSource = null,    // from where: 'horoscope.route /get'
    requestFor = null,       // for what: 'aries:today:general'
    requestLength = null,    // approximate char length

    callChannel = 'user',    // 'backend' | 'user'
    originTag = null         // 'horoscope-get-generic','astro-chat', etc.
  } = meta;

  const sql = `
    INSERT INTO public.astro_api_call_log (
      provider_id,
      provider_name,
      feature_id,
      chat_scope_id,
      audience_scope,
      external_endpoint,
      http_method,
      request_source,
      request_for,
      request_length,
      call_channel,
      origin_tag,
      started_at,
      created_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now(), now())
    RETURNING id;
  `;

  const vals = [
    providerId || 'openai-oracle',
    providerName,
    featureId,
    chatScopeId,
    audienceScope,
    endpoint,
    method,
    requestSource,
    requestFor,
    requestLength,
    callChannel,
    originTag
  ];

  const { rows } = await query(sql, vals);
  return rows[0]?.id;
}

/**
 * Update log row when the call finishes.
 */
export async function logApiCallEnd(id, opts = {}) {
  if (!id) return;

  const {
    statusCode = null,
    ok = null,
    errorText = null,
    responseLength = null
  } = opts;

  const sql = `
    UPDATE public.astro_api_call_log
       SET finished_at   = now(),
           duration_ms   = CAST(EXTRACT(EPOCH FROM (now() - started_at)) * 1000 AS integer),
           status_code   = COALESCE($2, status_code),
           ok            = COALESCE($3, ok),
           error_text    = COALESCE($4, error_text),
           response_length = COALESCE($5, response_length)
     WHERE id = $1;
  `;

  const vals = [
    id,
    statusCode,
    ok,
    errorText,
    responseLength
  ];

  await query(sql, vals);
}
