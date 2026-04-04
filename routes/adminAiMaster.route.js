// routes/adminAiMaster.route.js
import express from 'express';
import { query } from '../src/db.js';
// routes/adminAiMaster.route.js
import { refreshAiPromptCache,getAiPromptCacheJson } from '../src/config/aiPromptCache.js';

const router = express.Router();

// ---------------- PROVIDERS ----------------

// GET all providers (for grid, dropdowns)
router.get('/providers', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM usp_app_ai_provider_get_all();');
    res.json(rows);
  } catch (err) {
    console.error('[AI ADMIN] providers GET error:', err);
    res.status(500).json({ error: 'Failed to fetch providers' });
  }
});

// UPSERT provider
router.post('/providers', async (req, res) => {
  try {
    const {
      provider_code,
      display_name,
      base_url,
      api_family,
      auth_type,
      api_key_env_var,
      default_timeout_ms,
      status,
    } = req.body;

    const { rows } = await query(
      `SELECT * FROM usp_app_ai_provider_upsert(
        $1,$2,$3,$4,$5,$6,$7,$8
      );`,
      [
        provider_code,
        display_name,
        base_url,
        api_family,
        auth_type,
        api_key_env_var,
        default_timeout_ms,
        status,
      ]
    );

    res.json(rows[0]);
  } catch (err) {
    console.error('[AI ADMIN] providers UPSERT error:', err);
    res.status(500).json({ error: 'Failed to save provider' });
  }
});

// ---------------- SERVICES (for dropdowns / separate page) ----------------

router.get('/services', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM usp_app_ai_service_master_get_all();');
    res.json(rows);
  } catch (err) {
    console.error('[AI ADMIN] services GET error:', err);
    res.status(500).json({ error: 'Failed to fetch services' });
  }
});

router.post('/services', async (req, res) => {
  try {
    const {
      service_code,
      display_name,
      description,
      tradition,
      scope,
      granularity,
      output_shape,
      expected_length,
      complexity_level,
      use_case,
      is_chat_service,
      is_active,
    } = req.body;

    const { rows } = await query(
      `SELECT * FROM usp_app_ai_service_master_upsert(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
      );`,
      [
        service_code,
        display_name,
        description,
        tradition,
        scope,
        granularity,
        output_shape,
        expected_length,
        complexity_level,
        use_case,
        is_chat_service,
        is_active,
      ]
    );

    res.json(rows[0]);
  } catch (err) {
    console.error('[AI ADMIN] services UPSERT error:', err);
    res.status(500).json({ error: 'Failed to save service' });
  }
});

// ---------------- PERSONAS (master dropdown for prompt config) ----------------

router.get('/personas', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM usp_app_prompt_persona_get_all();');
    res.json(rows);
  } catch (err) {
    console.error('[AI ADMIN] personas GET error:', err);
    res.status(500).json({ error: 'Failed to fetch personas' });
  }
});

router.post('/personas', async (req, res) => {
  try {
    const {
      persona_code,
      display_name,
      description,
      tone_keywords,
      reading_style,
      formality_level,
      max_output_length_multiplier,
    } = req.body;

    const { rows } = await query(
      `SELECT * FROM usp_app_prompt_persona_upsert(
        $1,$2,$3,$4,$5,$6,$7
      );`,
      [
        persona_code,
        display_name,
        description,
        tone_keywords,
        reading_style,
        formality_level,
        max_output_length_multiplier,
      ]
    );

    res.json(rows[0]);
  } catch (err) {
    console.error('[AI ADMIN] personas UPSERT error:', err);
    res.status(500).json({ error: 'Failed to save persona' });
  }
});

// ---------------- SCHEMAS (used by services) ----------------

router.get('/schemas', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM usp_app_ai_schema_master_get_all();');
    res.json(rows);
  } catch (err) {
    console.error('[AI ADMIN] schemas GET error:', err);
    res.status(500).json({ error: 'Failed to fetch schemas' });
  }
});

router.post('/schemas', async (req, res) => {
  try {
    const {
      schema_code,
      service_code,
      schema_json,          // expect JSON object
      strict,
      version,
    } = req.body;

    const { rows } = await query(
      `SELECT * FROM usp_app_ai_schema_master_upsert(
        $1,$2,$3::jsonb,$4,$5
      );`,
      [schema_code, service_code, schema_json, strict, version]
    );

    res.json(rows[0]);
  } catch (err) {
    console.error('[AI ADMIN] schemas UPSERT error:', err);
    res.status(500).json({ error: 'Failed to save schema' });
  }
});

// ---------------- PROVIDER MODELS (dropdown uses providers + services) ----------------

router.get('/provider-models', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM usp_app_ai_provider_models_get_all();');
    res.json(rows);
  } catch (err) {
    console.error('[AI ADMIN] provider-models GET error:', err);
    res.status(500).json({ error: 'Failed to fetch provider models' });
  }
});

// in routes/adminAiMaster.route.js (or similar)

router.post('/provider-models', async (req, res) => {
  try {
    const body = req.body || {};

    const {
      model_id,
      api_id,
      display_name,
      capability,
      max_input_tokens,
      max_output_tokens,
      cost_input_per_1k,
      cost_output_per_1k,
      is_default,
      is_active,
      provider_api_id,
      model_code,
      max_tokens,
      creativity,
      cost_per_1k,
      avg_latency_ms,
    } = body;

    const params = [
      model_id,
      api_id,
      display_name,
      capability,
      max_input_tokens != null ? Number(max_input_tokens) : null,
      max_output_tokens != null ? Number(max_output_tokens) : null,
      cost_input_per_1k != null ? Number(cost_input_per_1k) : null,
      cost_output_per_1k != null ? Number(cost_output_per_1k) : null,
      is_default === true || is_default === 'true',
      is_active === false || is_active === 'false' ? false : true,
      provider_api_id || null,
      model_code || null,
      max_tokens != null ? Number(max_tokens) : null,
      creativity != null ? Number(creativity) : null,
      cost_per_1k != null ? Number(cost_per_1k) : null,
      avg_latency_ms != null ? Number(avg_latency_ms) : null,
    ];

    const { rows } = await query(
      `SELECT * FROM public.usp_app_ai_provider_models_upsert(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16
      );`,
      params
    );

    res.json(rows[0]);
  } catch (err) {
    console.error('[AI ADMIN] provider-models UPSERT error:', {
      message: err.message,
      detail: err.detail,
      code: err.code,
      stack: err.stack,
    });

    res.status(500).json({
      error: err.detail || err.message || 'Failed to save provider model',
    });
  }
});

// --- PERSONA BINDINGS ---
router.get('/persona-bindings', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM public.usp_app_persona_binding_get_all();');
    res.json(rows);
  } catch (err) {
    console.error('[AI ADMIN] persona-bindings GET error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch persona bindings' });
  }
});

router.post('/persona-bindings', async (req, res) => {
  try {
    const {
      id,
      service_code,
      tier,
      language_code,
      persona_code,
      is_default,
    } = req.body || {};

    const { rows } = await query(
      `SELECT * FROM public.usp_app_persona_binding_upsert(
        $1,$2,$3,$4,$5,$6
      );`,
      [
        id ?? null,
        service_code,
        tier,
        language_code,
        persona_code,
        is_default,
      ]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[AI ADMIN] persona-bindings UPSERT error:', err);
    res.status(500).json({ error: err.message || 'Failed to save persona binding' });
  }
});

// --- PROMPT TEMPLATES ---
router.get('/prompt-templates', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM public.usp_app_prompt_template_get_all();');
    res.json(rows);
  } catch (err) {
    console.error('[AI ADMIN] prompt-templates GET error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch prompt templates' });
  }
});

router.post('/prompt-templates', async (req, res) => {
  try {
    const b = req.body || {};
    const { rows } = await query(
      `SELECT * FROM public.usp_app_prompt_template_upsert(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
      );`,
      [
        b.id ?? null,
        b.prompt_code,
        b.service_code,
        b.role,
        b.language_code,
        b.tradition,
        b.persona_code,
        b.provider_code,
        b.model_id,
        b.template_text,
        b.version,
        b.is_active,
      ]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[AI ADMIN] prompt-templates UPSERT error:', err);
    res.status(500).json({ error: err.message || 'Failed to save prompt template' });
  }
});

// --- SERVICE MODEL CONFIG ---
router.get('/service-model-config', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM public.usp_app_service_model_config_get_all();');
    res.json(rows);
  } catch (err) {
    console.error('[AI ADMIN] service-model-config GET error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch service model config' });
  }
});

router.post('/service-model-config', async (req, res) => {
  try {
    const b = req.body || {};
    const { rows } = await query(
      `SELECT * FROM public.usp_app_service_model_config_upsert(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
      );`,
      [
        b.id ?? null,
        b.service_code,
        b.tier,
        b.model_id,
        b.priority_order,
        b.max_tokens_input,
        b.max_tokens_output,
        b.temperature,
        b.top_p,
        b.frequency_penalty,
        b.presence_penalty,
        b.schema_code,
        b.response_format,
        b.cache_key_pattern,
        b.cache_ttl_sec,
      ]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[AI ADMIN] service-model-config UPSERT error:', err);
    res.status(500).json({ error: err.message || 'Failed to save service model config' });
  }
});

// --- SERVICE COST RULES ---
router.get('/service-cost-rules', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM public.usp_app_service_cost_rules_get_all();');
    res.json(rows);
  } catch (err) {
    console.error('[AI ADMIN] service-cost-rules GET error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch cost rules' });
  }
});

router.post('/service-cost-rules', async (req, res) => {
  try {
    const b = req.body || {};
    const { rows } = await query(
      `SELECT * FROM public.usp_app_service_cost_rules_upsert(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
      );`,
      [
        b.id ?? null,
        b.service_code,
        b.tier,
        b.points_cost_per_call,
        b.max_calls_per_day,
        b.mode,
        b.max_tokens_input,
        b.max_tokens_output,
        b.allow_streaming,
        b.cache_key_pattern,
        b.cache_ttl_sec,
      ]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[AI ADMIN] service-cost-rules UPSERT error:', err);
    res.status(500).json({ error: err.message || 'Failed to save cost rule' });
  }
});

// --- PROMPT RUNTIME FLAGS ---
router.get('/prompt-runtime-flags', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM public.usp_app_prompt_runtime_flags_get_all();');
    res.json(rows);
  } catch (err) {
    console.error('[AI ADMIN] prompt-runtime-flags GET error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch runtime flags' });
  }
});

router.post('/prompt-runtime-flags', async (req, res) => {
  try {
    const b = req.body || {};
    const { rows } = await query(
      `SELECT * FROM public.usp_app_prompt_runtime_flags_upsert(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
      );`,
      [
        b.id ?? null,
        b.service_code,
        b.tier,
        b.allow_followup_questions,
        b.include_disclaimer,
        b.allow_user_context,
        b.max_context_turns,
        b.truncate_strategy,
        b.include_birth_chart_context,
        b.include_daily_context,
        b.include_auspicious_context,
      ]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[AI ADMIN] prompt-runtime-flags UPSERT error:', err);
    res.status(500).json({ error: err.message || 'Failed to save runtime flags' });
  }
});
// ⬇️ NEW: force-refresh prompt cache
router.post('/ai-cache/refresh', async (req, res) => {
  try {
    const data = await refreshAiPromptCache();
    res.json({
      ok: true,
      generatedAtISO: data.generatedAtISO,
    });
  } catch (err) {
    console.error('[admin-ai] ai-cache refresh failed:', err);
    res.status(500).json({
      ok: false,
      error: err?.message || 'Failed to refresh AI prompt cache',
    });
  }
});
// ⬇ NEW: download the current cache JSON
router.get('/ai-cache/download', async (req, res) => {
  try {
    const json = await getAiPromptCacheJson(); // now defined

    res.setHeader('Content-Type', 'application/json');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="ai_prompts_cache.json"'
    );
    res.send(json);
  } catch (err) {
    console.error('[admin-ai] ai-cache download failed:', err);
    res.status(500).json({
      ok: false,
      error: err?.message || 'Failed to download AI prompt cache',
    });
  }
});


export default router;
