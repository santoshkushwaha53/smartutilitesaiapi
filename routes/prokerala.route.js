// routes/prokerala.route.js

// Express router for calling raw Prokerala APIs and caching/logging the responses.
import express from 'express';
import pool, { query } from '../src/db.js';
import { callProkerala } from '../utils/prokerala.js';
import { hashRequest } from '../utils/hash.js';
import { assertRawProviderEnabled } from '../src/apiProviders.js';
import { logApiCallStart, logApiCallEnd } from '../src/apiCallLog.js';

const router = express.Router();

// Only allow Prokerala endpoints that start with these prefixes
// Example: v2/astrology/panchang, v2/horoscope/daily
const ALLOWED_PREFIX = /^v2\/(astrology|horoscope)\//i;

// Safely stringify any object, fallback if something goes wrong
const safeStringify = (obj) => {
  try {
    return JSON.stringify(obj ?? {});
  } catch {
    return JSON.stringify({ error: 'stringify_failed' });
  }
};

// Derive a "context timestamp" for the astro event:
// 1) Explicit context_ts from request body
// 2) Else params.datetime (if present)
// 3) Else params.profile.datetime (if present)
// 4) Else null
function deriveContextTs(context_ts, params) {
  if (context_ts) return context_ts;
  if (params?.datetime) return params.datetime;
  if (params?.profile?.datetime) return params.profile.datetime;
  return null;
}

// Cache TTL rule: currently only adds TTL limit for panchang-type calls
// You can extend this later for other calc types if needed.
function cacheTTLClause(calc_type) {
  if (calc_type?.toLowerCase().startsWith('panchang')) {
    // Only reuse cached panchang response if it is not older than 24 hours
    return "AND created_at >= now() - interval '24 hours'";
  }
  return '';
}

// Main entry point:
// POST /api/prokerala/run
//
// This route:
//  - validates the requested Prokerala endpoint
//  - optionally returns a cached response from astro_raw_event
//  - calls Prokerala (via utils/prokerala.js)
//  - logs API call in astro_api_call_log
//  - stores raw response in astro_raw_event (for caching and debugging)
router.post('/run', async (req, res) => {
  const t0 = Date.now(); // used to measure total handler time

  try {
    // Destructure request body with defaults
    let {
      endpoint,        // e.g. "v2/astrology/panchang"
      params = {},     // query params for Prokerala
      system = null,   // 'vedic' / 'western' / custom
      calc_type = null,// logical calculation type, e.g. 'panchang_transit'
      context_ts = null, // timestamp representing "when" this calculation applies
      lang = 'en',     // language code
      profileId = null,// optional profile/user reference
      force = false,   // if true, ignore cache and always call provider
    } = req.body || {};

    // Check feature flag / provider status via API Manager
    // If Prokerala raw tools are disabled, short-circuit with 503
    try {
      await assertRawProviderEnabled('prokerala-astro', {
        featureId: 'general-tools',
      });
    } catch (cfgErr) {
      console.warn('[PROKERALA] blocked by API Manager:', cfgErr.message);
      return res.status(503).json({
        error: 'prokerala_disabled',
        message: cfgErr.message,
      });
    }

    // Basic validation for required endpoint string
    if (!endpoint || typeof endpoint !== 'string') {
      return res.status(400).json({ error: 'endpoint (string) is required' });
    }

    // Enforce that only "v2/astrology" or "v2/horoscope" paths are allowed
    if (!ALLOWED_PREFIX.test(endpoint)) {
      return res.status(400).json({
        error: 'endpoint must start with v2/astrology or v2/horoscope',
      });
    }

    // Derive a consistent "context timestamp" to store with the event
    context_ts = deriveContextTs(context_ts, params);

    // Debug log to see what datetime we received before any sandbox override
    console.log('[PROKERALA] Incoming datetime BEFORE override:', {
      context_ts,
      datetime: params?.datetime,
      profileDatetime: params?.profile?.datetime,
    });

    // Compute a stable hash of (endpoint + params) for caching
    const request_hash = hashRequest(endpoint, params);

    // Cache lookup: if "force" is false, try to reuse a previous response
    if (!force) {
      const ttlWhere = cacheTTLClause(calc_type);
      const cached = await query(
        `SELECT * FROM astro_raw_event WHERE request_hash=$1 ${ttlWhere} LIMIT 1`,
        [request_hash]
      );
      if (cached.rows.length) {
        // Return cached event directly and skip calling Prokerala
        return res.json({ fromCache: true, rawEvent: cached.rows[0] });
      }
    }

    // Approximate request size for logging
    const approxReqLen = safeStringify(params).length;

    // Start API call log (astro_api_call_log)
    const logId = await logApiCallStart({
      providerId: 'prokerala-astro',
      providerName: 'Prokerala Astrology API',
      featureId: calc_type || 'general-tools',
      chatScopeId: null,
      audienceScope: null,
      endpoint,
      method: 'POST',
      requestSource: 'routes/prokerala.run',
      requestFor: `${endpoint}:${calc_type || ''}`,
      requestLength: approxReqLen,
      callChannel: 'backend',
      originTag: 'prokerala-run',
    });

    let data = null;    // final response JSON to be stored
    let credits = null; // credits usage from response headers (if provided)

    try {
      // 🔥 Actual call to Prokerala (date override / sandbox logic is handled inside callProkerala)
      const resp = await callProkerala(endpoint, params);

      data = resp?.data;
      // Normalize string responses into an object wrapper
      if (typeof data === 'string') data = { raw: data };

      // Extract credit usage from headers (if any header is present)
      credits =
        parseInt(
          resp?.headers?.['x-credits-used'] ||
            resp?.headers?.['x-credits'] ||
            resp?.headers?.['x-credit'] ||
            '0',
          10
        ) || null;

      // Mark log as successful
      await logApiCallEnd(logId, {
        statusCode: resp?.status ?? 200,
        ok: true,
        responseLength: safeStringify(data).length,
      });
    } catch (e) {
      // On error, normalize the error body into an object
      const body = e?.response?.data;
      data =
        body && typeof body === 'object'
          ? body
          : { error: String(body || e.message || 'Unknown error') };

      // Mark log as failed
      await logApiCallEnd(logId, {
        statusCode: e?.response?.status || 500,
        ok: false,
        errorText: e?.message || String(e),
      });
    }

    // 🔹 Upsert raw event via stored procedure (includes provider_code & is_predicted)
     // 🔹 Insert raw event via stored procedure (includes provider_code & is_predicted)
    const providerCode = 'prokerala-astro';
    const isPredicted = false; // plain provider data, not ML prediction

    const saved = await query(
      `
      SELECT *
      FROM usp_astro_raw_event_insert(
        $1,        -- p_provider_code
        $2,        -- p_profile_id
        $3,        -- p_system
        $4,        -- p_calc_type
        $5,        -- p_context_ts
        $6,        -- p_endpoint
        $7::jsonb, -- p_request_params
        $8::jsonb, -- p_response_json
        $9,        -- p_credits_used
        $10,       -- p_lang
        $11,       -- p_request_hash
        $12        -- p_is_predicted
      );
      `,
      [
        providerCode,
        profileId,
        system,
        calc_type,
        context_ts,
        endpoint,
        safeStringify(params),
        safeStringify(data),
        credits,
        lang,
        request_hash,
        isPredicted,
      ]
    );
   console.log('Prokerala data save:');

    // Final response to caller: include the saved raw event and total time
    res.json({
      fromCache: false,
      rawEvent: saved.rows[0],
      ms: Date.now() - t0,
    });
  } catch (err) {
    // Top-level error handler: catches unexpected failures in this route
    console.error('Prokerala error:', err);
    res.status(err?.response?.status || 500).json({
      error: err?.response?.data || err.message || 'Unknown error',
    });
  }
});

export default router;
