// src/settings.js
import { query } from './db.js';

const CACHE_TTL_MS = 30_000; // 30s soft cache
const cache = new Map();     // key: `${ns}:${key}` → { expires, record }

function coerce(value, type) {
  if (value == null) return null;
  switch ((type || 'string').toLowerCase()) {
    case 'bool':
    case 'boolean':
      return ['1','true','yes','on'].includes(String(value).toLowerCase());
    case 'int':
    case 'integer':
      return Number.parseInt(value, 10);
    case 'float':
    case 'number':
      return Number.parseFloat(value);
    case 'json':
      try { return JSON.parse(value); } catch { return null; }
    default:
      return String(value);
  }
}

function cacheKey(namespace, key) {
  return `${namespace}:${key}`;
}

export async function getSetting(namespace, key, fallback = null) {
  const ck = cacheKey(namespace, key);
  const now = Date.now();
  const hit = cache.get(ck);
  if (hit && hit.expires > now) {
    const { value, type, value_json } = hit.record;
    return type === 'json' ? (value_json ?? coerce(value, 'json')) : coerce(value, type);
  }

  const r = await query(
    'SELECT value, value_json, type FROM public.app_settings WHERE namespace=$1 AND key=$2',
    [namespace, key]
  );
  if (!r.rows.length) return fallback;

  const rec = r.rows[0];
  cache.set(ck, { expires: now + CACHE_TTL_MS, record: rec });
  return rec.type === 'json' ? (rec.value_json ?? coerce(rec.value, 'json')) : coerce(rec.value, rec.type);
}

export async function setSetting(namespace, key, { value, type = 'string', value_json = null, updated_by = 'system' }) {
  // Text value is the canonical source; mirror JSON if provided
  const r = await query(
    `INSERT INTO public.app_settings(namespace, key, value, value_json, type, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (namespace, key)
     DO UPDATE SET value=EXCLUDED.value, value_json=EXCLUDED.value_json, type=EXCLUDED.type,
                   updated_by=EXCLUDED.updated_by, updated_at=now()
     RETURNING value, value_json, type`,
    [namespace, key, value, value_json, type, updated_by]
  );
  cache.delete(cacheKey(namespace, key)); // bust cache
  return r.rows[0];
}

export async function toggleBool(namespace, key) {
  const current = await getSetting(namespace, key, 'false');
  const newVal = (!(['1','true','yes','on'].includes(String(current).toLowerCase()))).toString();
  await setSetting(namespace, key, { value: newVal, type: 'bool', updated_by: 'toggle' });
  return newVal === 'true';
}

export function clearSettingsCache() {
  cache.clear();
}
