// src/apiProviders.js
import { query } from './db.js';

/**
 * Reads astro_api_provider_config and exposes helper fns
 * for "is this provider allowed for raw / prediction / feature?"
 */

const CACHE_TTL_MS = 60_000; // 1 minute
let cache = null;
let cacheAt = 0;

// Fallback config if table is empty (keeps old behaviour)
const FALLBACK_APIS = [
  {
    id: 'prokerala-astro',
    name: 'Prokerala Astrology API',
    provider: 'Prokerala',
    description: 'Planet positions, charts, raw astrology data.',
    enabled: true,
    role: 'raw-data',
    defaultForRawData: true,
    defaultForPredictions: false,
    allowedChats: [],
    allowedFeatures: ['daily-horoscope','weekly-horoscope','general-tools'],
  },
  {
    id: 'openai-oracle',
    name: 'OpenAI Oracle',
    provider: 'OpenAI',
    description: 'LLM-based mystical text predictions & guidance.',
    enabled: true,
    role: 'prediction',
    defaultForRawData: false,
    defaultForPredictions: true,
    allowedChats: ['general-chat','love-chat','career-chat'],
    allowedFeatures: ['daily-horoscope','weekly-horoscope','numerology','general-tools'],
  },
  {
    id: 'internal-engine',
    name: 'Internal Astro Engine',
    provider: 'SohumAstro Internal',
    description: 'Custom zodiac rules, fallback text & offline logic.',
    enabled: false,
    role: 'both',
    defaultForRawData: false,
    defaultForPredictions: false,
    allowedChats: [],
    allowedFeatures: [],
  },
];

async function loadConfigSnapshot() {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_TTL_MS) return cache;

  try {
    const { rows } = await query(
      `SELECT api_id,
              name,
              provider,
              description,
              enabled,
              role,
              default_for_raw_data,
              default_for_predictions,
              allowed_chats,
              allowed_features
         FROM astro_api_provider_config
        ORDER BY api_id`
    );

    if (!rows.length) {
      cache = FALLBACK_APIS;
    } else {
      cache = rows.map((r) => ({
        id: r.api_id,
        name: r.name,
        provider: r.provider,
        description: r.description,
        enabled: !!r.enabled,
        role: r.role, // 'raw-data' | 'prediction' | 'both'
        defaultForRawData: !!r.default_for_raw_data,
        defaultForPredictions: !!r.default_for_predictions,
        allowedChats: Array.isArray(r.allowed_chats) ? r.allowed_chats : [],
        allowedFeatures: Array.isArray(r.allowed_features) ? r.allowed_features : [],
      }));
    }

    cacheAt = now;
    return cache;
  } catch (e) {
    console.error('[API-CONFIG] load error, falling back:', e.message);
    cache = FALLBACK_APIS;
    cacheAt = now;
    return cache;
  }
}

export async function getApiConfigSnapshot() {
  return loadConfigSnapshot();
}

/**
 * Internal helper to find a provider row by id.
 */
async function findProviderById(id) {
  const cfg = await loadConfigSnapshot();
  return cfg.find((p) => p.id === id);
}

/**
 * Throws if a provider is disabled or has incompatible role / scopes.
 * This is SAFE to call from any route – if the table is empty we fall back
 * to the built-in defaults above (always enabled).
 */
export async function assertRawProviderEnabled(providerId, opts = {}) {
  const { featureId = null } = opts;
  const row = await findProviderById(providerId);

  if (!row) {
    throw Object.assign(new Error(`Provider "${providerId}" not found in config`), {
      code: 'PROVIDER_NOT_FOUND',
      providerId,
    });
  }

  if (!row.enabled) {
    throw Object.assign(new Error(`Provider "${providerId}" is disabled`), {
      code: 'PROVIDER_DISABLED',
      providerId,
    });
  }

  if (row.role === 'prediction') {
    throw Object.assign(
      new Error(`Provider "${providerId}" cannot be used for raw data (role=prediction)`),
      { code: 'PROVIDER_WRONG_ROLE', providerId, role: row.role }
    );
  }

  if (featureId && Array.isArray(row.allowedFeatures) && row.allowedFeatures.length) {
    if (!row.allowedFeatures.includes(featureId)) {
      throw Object.assign(
        new Error(`Provider "${providerId}" not allowed for feature "${featureId}"`),
        { code: 'PROVIDER_FEATURE_BLOCKED', providerId, featureId }
      );
    }
  }

  return row;
}

/**
 * Same, but for prediction (LLM) providers.
 */
export async function assertPredictionProviderEnabled(providerId, opts = {}) {
  const { chatScopeId = null, featureId = null } = opts;
  const row = await findProviderById(providerId);

  if (!row) {
    throw Object.assign(new Error(`Provider "${providerId}" not found in config`), {
      code: 'PROVIDER_NOT_FOUND',
      providerId,
    });
  }

  if (!row.enabled) {
    throw Object.assign(new Error(`Provider "${providerId}" is disabled`), {
      code: 'PROVIDER_DISABLED',
      providerId,
    });
  }

  if (row.role === 'raw-data') {
    throw Object.assign(
      new Error(`Provider "${providerId}" cannot be used for prediction (role=raw-data)`),
      { code: 'PROVIDER_WRONG_ROLE', providerId, role: row.role }
    );
  }

  if (chatScopeId && Array.isArray(row.allowedChats) && row.allowedChats.length) {
    if (!row.allowedChats.includes(chatScopeId)) {
      throw Object.assign(
        new Error(`Provider "${providerId}" not allowed for chat scope "${chatScopeId}"`),
        { code: 'PROVIDER_CHAT_BLOCKED', providerId, chatScopeId }
      );
    }
  }

  if (featureId && Array.isArray(row.allowedFeatures) && row.allowedFeatures.length) {
    if (!row.allowedFeatures.includes(featureId)) {
      throw Object.assign(
        new Error(`Provider "${providerId}" not allowed for feature "${featureId}"`),
        { code: 'PROVIDER_FEATURE_BLOCKED', providerId, featureId }
      );
    }
  }

  return row;
}
