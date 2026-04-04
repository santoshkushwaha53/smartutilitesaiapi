// src/ai/schemaConfig.js
import { getAiPromptCache } from '../config/aiPromptCache.js';

/**
 * Find the best model + schema config for a service & tier.
 * Returns:
 *  {
 *    modelId,
 *    responseFormat,        // 'json_schema' | 'json' | 'text'
 *    schemaJson,            // the schema object or null
 *    strict
 *  }
 */
export async function getServiceSchemaConfig(serviceCode, tier = 'free') {
  const cache = await getAiPromptCache();

  // 1) pick service model config
  const candidates = cache.serviceModels
    .filter(m => m.service_code === serviceCode);

  let best = null;
  for (const row of candidates) {
    if (row.tier && row.tier !== tier) continue;
    if (!best) best = row;
    else if (!best.tier && row.tier) best = row; // prefer tier-specific
    else if (row.priority_order < best.priority_order) best = row;
  }

  if (!best) {
    throw new Error(`No model config for service=${serviceCode}, tier=${tier}`);
  }

  const {
    model_id,
    response_format,
    schema_code,
  } = best;

  let schemaJson = null;
  let strict = false;

  if (schema_code) {
    const schemaRow = cache.schemas.find(s => s.schema_code === schema_code);
    if (schemaRow) {
      schemaJson = schemaRow.schema_json; // assuming this column is JSONB
      strict = !!schemaRow.strict;
    }
  }

  return {
    modelId: model_id,
    responseFormat: response_format || 'text',
    schemaJson,
    strict,
  };
}
