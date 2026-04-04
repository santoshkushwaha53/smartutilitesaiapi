// src/config/aiPromptCache.js
import fs from 'fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '../db.js'; // adjust if your db.js path is different

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Where you want to keep the JSON cache on disk
const CACHE_PATH = path.join(__dirname, '../../var/ai_prompts_cache.json');

let inMemoryCache = null;
let loadingPromise = null;

/* ──────────────────────────────────────────────
 * Low-level: load everything from DB
 * ────────────────────────────────────────────── */
async function loadConfigFromDb() {
  const [
    servicesRes,
    promptsRes,
    personasRes,
    astroRes,
    runtimeFlagsRes,
    experimentsRes,
    schemasRes,
    serviceModelsRes,
  ] = await Promise.all([
    // 2) SERVICE CATALOG
    query(`SELECT * FROM app_ai_service_master`),

    // 5) PROMPT TEMPLATES
    query(`SELECT * FROM app_prompt_template`),

    // 4) PERSONAS
    query(`SELECT * FROM app_prompt_persona`),

    // 8) ASTROLOGY CONFIG
    query(`SELECT * FROM app_astrology_config`),

    // 9) PROMPT RUNTIME FLAGS
    query(`SELECT * FROM app_prompt_runtime_flags`),

    // 10) PROMPT EXPERIMENTS
    query(`SELECT * FROM app_prompt_experiments`),

    // 3) SCHEMA REGISTRY  👈 NEW
    query(`SELECT * FROM app_ai_schema_master`),

    // 6) SERVICE → MODEL CONFIG 👈 NEW
    query(`SELECT * FROM app_service_model_config`),
  ]);

  const data = {
    generatedAtISO: new Date().toISOString(),

    // existing
    services: servicesRes.rows,
    prompts: promptsRes.rows,
    personas: personasRes.rows,
    astroConfigs: astroRes.rows,
    runtimeFlags: runtimeFlagsRes.rows,
    experiments: experimentsRes.rows,

    // new
    schemas: schemasRes.rows,
    serviceModels: serviceModelsRes.rows,
  };

  return data;
}

/* ──────────────────────────────────────────────
 * Save JSON atomically (tmp + rename)
 * ────────────────────────────────────────────── */
async function saveCacheToDisk(data) {
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  const tmpPath = CACHE_PATH + '.tmp';
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmpPath, CACHE_PATH);
}

/* ──────────────────────────────────────────────
 * Try to load from JSON cache
 * If corrupted -> delete and return null
 * ────────────────────────────────────────────── */
async function loadCacheFromDisk() {
  try {
    const buf = await fs.readFile(CACHE_PATH, 'utf8');
    const data = JSON.parse(buf);
    return data;
  } catch (err) {
    console.warn('[aiPromptCache] Failed to read/parse cache, will refresh:', err.message);
    try {
      await fs.unlink(CACHE_PATH);
    } catch {
      // ignore
    }
    return null;
  }
}

/* ──────────────────────────────────────────────
 * PUBLIC: get cache (lazy, singleton)
 * 1) if in memory → return
 * 2) else try JSON file
 * 3) else load from DB and write JSON
 * ────────────────────────────────────────────── */
export async function getAiPromptCache() {
  if (inMemoryCache) return inMemoryCache;

  if (!loadingPromise) {
    loadingPromise = (async () => {
      // try disk first
      let data = await loadCacheFromDisk();
      if (!data) {
        console.log('[aiPromptCache] Regenerating cache from DB...');
        data = await loadConfigFromDb();
        await saveCacheToDisk(data);
      }
      inMemoryCache = data;
      return inMemoryCache;
    })();
  }

  return loadingPromise;
}

/* ──────────────────────────────────────────────
 * PUBLIC: force refresh from DB (e.g. admin endpoint)
 * ────────────────────────────────────────────── */
export async function refreshAiPromptCache() {
  console.log('[aiPromptCache] Forced refresh from DB...');
  const data = await loadConfigFromDb();
  await saveCacheToDisk(data);
  inMemoryCache = data;
  loadingPromise = null;
  return inMemoryCache;
}

/* ──────────────────────────────────────────────
 * Optional: get raw JSON (for download in admin UI)
 * ────────────────────────────────────────────── */
export async function getAiPromptCacheJson() {
  const data = await getAiPromptCache();
  return JSON.stringify(data, null, 2);
}
