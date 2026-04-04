// src/services/apiManager.service.js
import { query } from '../db.js';

/**
 * Load current config from DB.
 * Maps DB rows -> shape expected by Angular.
 */
export async function loadApiConfig() {
  const { rows } = await query(
    `
    SELECT
      api_id,
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
    ORDER BY api_id;
    `
  );

  const apis = rows.map((r) => ({
    id: r.api_id,
    name: r.name,
    provider: r.provider,
    description: r.description,
    enabled: r.enabled,
    role: r.role,
    defaultForRawData: r.default_for_raw_data,
    defaultForPredictions: r.default_for_predictions,
    allowedChats: r.allowed_chats || [],
    allowedFeatures: r.allowed_features || [],
  }));

  // Static scopes – UI uses these to render chips
  const chatScopes = [
    { id: 'love-chat',    label: 'Love & Relationships Chat' },
    { id: 'career-chat',  label: 'Career & Finance Chat' },
    { id: 'general-chat', label: 'General / Spiritual Chat' },
  ];

  const featureScopes = [
    { id: 'daily-horoscope',  label: 'Daily Horoscope' },
    { id: 'weekly-horoscope', label: 'Weekly Horoscope' },
    { id: 'tarot',            label: 'Tarot & Card Spreads' },
    { id: 'compatibility',    label: 'Compatibility Reports' },
    { id: 'numerology',       label: 'Numerology' },
    { id: 'general-tools',    label: 'General Tools / Widgets' },
  ];

  return { apis, chatScopes, featureScopes };
}

/**
 * Save full API config snapshot from UI.
 * - Runs in a transaction
 * - Ensures at most ONE default_for_raw_data = true
 * - Ensures at most ONE default_for_predictions = true
 * - Upserts rows by api_id (no duplicates)
 */
export async function saveApiConfig(apis = []) {
  if (!Array.isArray(apis)) {
    throw new Error('Invalid payload: apis must be an array');
  }

  // Normalize booleans & arrays
  const cleaned = apis.map((a) => ({
    id: String(a.id),
    name: a.name || '',
    provider: a.provider || '',
    description: a.description || '',
    enabled: !!a.enabled,
    role: a.role || 'raw-data',
    defaultForRawData: !!a.defaultForRawData,
    defaultForPredictions: !!a.defaultForPredictions,
    allowedChats: Array.isArray(a.allowedChats) ? a.allowedChats : [],
    allowedFeatures: Array.isArray(a.allowedFeatures) ? a.allowedFeatures : [],
  }));

  // Determine which ones are defaults (at most one expected for each)
  const rawDefaults = cleaned.filter((a) => a.defaultForRawData);
  const predDefaults = cleaned.filter((a) => a.defaultForPredictions);

  const rawDefaultId = rawDefaults[0]?.id || null;
  const predDefaultId = predDefaults[0]?.id || null;

  // Optional: if there are multiple defaults in payload, you can
  // either throw an error or just keep the first one.
  if (rawDefaults.length > 1 || predDefaults.length > 1) {
    console.warn('[API-MANAGER] multiple defaults in payload; using first per type');
  }

  await query('BEGIN');
  try {
    // 1) Clear existing defaults before setting the new ones
    if (rawDefaultId) {
      await query(
        `
        UPDATE astro_api_provider_config
        SET default_for_raw_data = FALSE,
            updated_at = NOW()
        WHERE default_for_raw_data = TRUE
          AND api_id <> $1;
        `,
        [rawDefaultId]
      );
    }

    if (predDefaultId) {
      await query(
        `
        UPDATE astro_api_provider_config
        SET default_for_predictions = FALSE,
            updated_at = NOW()
        WHERE default_for_predictions = TRUE
          AND api_id <> $1;
        `,
        [predDefaultId]
      );
    }

    // 2) Upsert each API row
    for (const a of cleaned) {
      await query(
        `
        INSERT INTO astro_api_provider_config (
          api_id,
          name,
          provider,
          description,
          enabled,
          role,
          default_for_raw_data,
          default_for_predictions,
          allowed_chats,
          allowed_features,
          created_at,
          updated_at
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW()
        )
        ON CONFLICT (api_id) DO UPDATE SET
          name                   = EXCLUDED.name,
          provider               = EXCLUDED.provider,
          description            = EXCLUDED.description,
          enabled                = EXCLUDED.enabled,
          role                   = EXCLUDED.role,
          default_for_raw_data   = EXCLUDED.default_for_raw_data,
          default_for_predictions= EXCLUDED.default_for_predictions,
          allowed_chats          = EXCLUDED.allowed_chats,
          allowed_features       = EXCLUDED.allowed_features,
          updated_at             = NOW();
        `,
        [
          a.id,
          a.name,
          a.provider,
          a.description,
          a.enabled,
          a.role,
          a.defaultForRawData,
          a.defaultForPredictions,
          a.allowedChats,
          a.allowedFeatures,
        ]
      );
    }

    await query('COMMIT');
  } catch (err) {
    await query('ROLLBACK');
    // Let the controller send a readable error
    throw err;
  }
}
