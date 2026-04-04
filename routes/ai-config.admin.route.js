// routes/ai-config.admin.route.js
import { Router } from 'express';
import { query } from '../src/db.js';

const router = Router();

/* ---------------------------------------------------
 * 1) SERVICES – coming from app_horoscope_services_points
 *    + app_horoscope_tier_multipliers (+ optionally models)
 * --------------------------------------------------- */

router.get('/ai-config/services', async (req, res) => {
  try {
    /* ----------------------------------------------
     * 1) Load base services  (REAL TABLE)
     * ---------------------------------------------- */
   const result = await query(`
  WITH mult AS (
    SELECT
      COALESCE(MAX(CASE WHEN tier = 'free' THEN multiplier END), 1) AS free_mult,
      COALESCE(MAX(CASE WHEN tier = 'lite' THEN multiplier END), 1) AS lite_mult,
      COALESCE(MAX(CASE WHEN tier = 'pro'  THEN multiplier END), 1) AS pro_mult
    FROM app_horoscope_tier_multipliers
  )
  SELECT
    s.id,
    s.name,
    s.category,
    s.free_chats      AS "freeQuestions",
    'summary'::text   AS "dataLevel",
    'json'::text      AS "responseFormat",
    jsonb_build_object(
      'free', jsonb_build_object(
        'model',  COALESCE(mf.model_id, ''),
        'points', (s.base_points * mult.free_mult)::int
      ),
      'lite', jsonb_build_object(
        'model',  COALESCE(ml.model_id, ''),
        'points', (s.base_points * mult.lite_mult)::int
      ),
      'pro', jsonb_build_object(
        'model',  COALESCE(mp.model_id, ''),
        'points', (s.base_points * mult.pro_mult)::int
      )
    ) AS tiers
  FROM app_horoscope_services s
  CROSS JOIN mult
  LEFT JOIN app_horoscope_service_models mf
    ON mf.service_id = s.id AND mf.tier = 'free'
  LEFT JOIN app_horoscope_service_models ml
    ON ml.service_id = s.id AND ml.tier = 'lite'
  LEFT JOIN app_horoscope_service_models mp
    ON mp.service_id = s.id AND mp.tier = 'pro'
  ORDER BY s.id;
`);

res.json(result.rows);

    /* ----------------------------------------------
     * 2) Load tier multipliers (REAL TABLE)
     * ---------------------------------------------- */
    let multipliers = { free: 1, lite: 1, pro: 1 };
    try {
      const r = await query(`
        SELECT tier, multiplier
        FROM app_horoscope_tier_multipliers;
      `);
      r.rows.forEach(x => multipliers[x.tier] = Number(x.multiplier));
    } catch (e) {
      console.warn("Tier multipliers table missing → using default 1x");
    }

    /* ----------------------------------------------
     * 3) Optional: load default model assignment table
     *    (MAY OR MAY NOT EXIST)
     * ---------------------------------------------- */
    let modelMap = {};

    try {
      const modelRows = await query(`
        SELECT service_id, tier, model_id
        FROM app_horoscope_service_models;
      `);

      modelRows.rows.forEach(m => {
        modelMap[`${m.service_id}:${m.tier}`] = m.model_code;
      });

    } catch (e) {
      console.warn("No app_horoscope_service_models table → models empty");
    }

    /* ----------------------------------------------
     * 4) Build final payload
     * ---------------------------------------------- */
    const services = base.rows.map(s => ({
      id: s.id,
      name: s.name,
      category: s.category,
      tiers: {
        free: {
          model: modelMap[`${s.id}:free`] || "",
          points: Math.round(Number(s.base_points) * (multipliers.free || 1))
        },
        lite: {
          model: modelMap[`${s.id}:lite`] || "",
          points: Math.round(Number(s.base_points) * (multipliers.lite || 1))
        },
        pro: {
          model: modelMap[`${s.id}:pro`] || "",
          points: Math.round(Number(s.base_points) * (multipliers.pro || 1))
        },
      },
      freeQuestions: Number(s.free_chats),
      dataLevel: "summary",        // future: make dynamic
      responseFormat: "json"       // future: make dynamic
    }));

    return res.json(services);

  } catch (err) {
    console.error("ERROR: /ai-config/services", err);
    return res.status(500).json({ error: "Failed to load services" });
  }
});


/* ---------------------------------------------------
 * 2) PROVIDERS – astro_api_provider_config + app_ai_provider_models
 * --------------------------------------------------- */

router.get('/ai-config/providers', async (req, res) => {
  try {
    const providersResult = await query(
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
      WHERE enabled = true
      ORDER BY name;
      `
    );

    // updated: use model_id instead of model_code, no id
    let modelsResult = { rows: [] };
    try {
      modelsResult = await query(
        `
        SELECT
          model_id,
          provider_api_id,
          display_name,
          max_tokens,
          creativity,
          cost_per_1k,
          avg_latency_ms
        FROM app_ai_provider_models;
        `
      );
    } catch {
      modelsResult = { rows: [] };
    }

    const modelsByProvider = modelsResult.rows.reduce((acc, row) => {
      const key = row.provider_api_id;
      if (!acc[key]) acc[key] = [];
      acc[key].push(row);
      return acc;
    }, {});

    const payload = providersResult.rows.map((p) => {
      const modelRows = modelsByProvider[p.api_id] || [];
      const models = modelRows.map((m) => m.model_id);

      const avgCreativity = modelRows[0]?.creativity ?? 0.7;
      const maxTokens     = modelRows[0]?.max_tokens ?? 4096;
      const costPer1k     = modelRows[0]?.cost_per_1k ?? 0;
      const avgLatency    = modelRows[0]?.avg_latency_ms ?? 1000;

      return {
        id: p.api_id,
        name: p.name,
        models,
        creativity: Number(avgCreativity),
        maxTokens: Number(maxTokens),
        costPer1k: Number(costPer1k),
        avgLatency: Number(avgLatency),
        role: p.role,
        provider: p.provider,
        allowedChats: p.allowed_chats || [],
        allowedFeatures: p.allowed_features || [],
      };
    });

    res.json(payload);
  } catch (err) {
    console.error('Error in GET /ai-config/providers', err);
    res.status(500).json({ error: 'Failed to load providers' });
  }
});


/* ---------------------------------------------------
 * 3) PROMPTS – from app_ai_prompt_templates
 * --------------------------------------------------- */

router.get('/ai-config/prompts', async (req, res) => {
  try {
    const result = await query(
      `
      SELECT
        id,
        service_id,
        persona,
        language,
        system_prompt,
        user_template,
        version,
        status
      FROM app_ai_prompt_templates
      ORDER BY service_id, persona, language;
      `
    );

    const prompts = result.rows.map((row) => ({
      id: row.id,
      service: row.service_id ?? 'daily',  // what your Angular UI expects
      persona: row.persona,
      language: row.language,
      systemPrompt: row.system_prompt,
      userTemplate: row.user_template,
      version: row.version,
      status: row.status,
    }));

    res.json(prompts);
  } catch (err) {
    console.error('Error in GET /ai-config/prompts', err);
    res.status(500).json({ error: 'Failed to load prompts' });
  }
});



/* ---------------------------------------------------
 * 4) DATA CONFIGS – from app_ai_data_configs
 * --------------------------------------------------- */

router.get('/ai-config/data-configs', async (req, res) => {
  try {
    const result = await query(
      `
      SELECT
        id,
        service,
        level,
        description
      FROM app_ai_data_configs
      ORDER BY service;
      `
    );

    const dataConfigs = result.rows.map((row) => ({
      id: row.id,
      service: row.service,
      level: row.level,
      description: row.description,
    }));

    res.json(dataConfigs);
  } catch (err) {
    console.error('Error in GET /ai-config/data-configs', err);
    res.status(500).json({ error: 'Failed to load data configs' });
  }
});

/* ---------------------------------------------------
 * 5) JSON SCHEMA – app_ai_json_schema + app_ai_json_schema_fields
 * --------------------------------------------------- */

router.get('/ai-config/json-schema', async (req, res) => {
  try {
    // we treat 'global' as the main schema – you can change this later
    const schemaResult = await query(
      `
      SELECT schema_id, root_object
      FROM app_ai_json_schema
      WHERE schema_id = 'global';
      `
    );

    if (schemaResult.rows.length === 0) {
      return res.json({
        rootObject: 'horoscope_response',
        fields: [],
      });
    }

    const schemaRow = schemaResult.rows[0];

    const fieldsResult = await query(
      `
      SELECT
        name,
        type,
        description,
        example
      FROM app_ai_json_schema_fields
      WHERE schema_id = $1
      ORDER BY sort_order, id;
      `,
      [schemaRow.schema_id]
    );

    const fields = fieldsResult.rows.map((f) => ({
      name: f.name,
      type: f.type,
      description: f.description,
      example: f.example,
    }));

    res.json({
      rootObject: schemaRow.root_object,
      fields,
    });
  } catch (err) {
    console.error('Error in GET /ai-config/json-schema', err);
    res.status(500).json({ error: 'Failed to load JSON schema' });
  }
});

/* ---------------------------------------------------
 * 6) EXPERIMENTS – from app_ai_experiments
 * --------------------------------------------------- */

router.get('/ai-config/experiments', async (req, res) => {
  try {
    const result = await query(
      `
      SELECT
        id,
        name,
        service_id,
        variant_a_model,
        variant_a_prompt,
        variant_b_model,
        variant_b_prompt,
        split,
        metric,
        status,
        result_variant_a,
        result_variant_b
      FROM app_ai_experiments
      ORDER BY created_at DESC;
      `
    );

    const experiments = result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      service: row.service_id ?? 'daily',   // what the Angular UI expects
      variantA: {
        model: row.variant_a_model,
        prompt: row.variant_a_prompt,
      },
      variantB: {
        model: row.variant_b_model,
        prompt: row.variant_b_prompt,
      },
      split: Number(row.split),
      metric: row.metric,
      status: row.status,
      results: {
        variantA: row.result_variant_a != null ? Number(row.result_variant_a) : 0,
        variantB: row.result_variant_b != null ? Number(row.result_variant_b) : 0,
      },
    }));

    res.json(experiments);
  } catch (err) {
    console.error('Error in GET /ai-config/experiments', err);
    res.status(500).json({ error: 'Failed to load experiments' });
  }
});

/* ---------------------------------------------------
 * 1) SERVICES – coming from app_horoscope_services
 *    + app_horoscope_tier_multipliers (+ optionally models)
 * --------------------------------------------------- */

router.get('/ai-config/services', async (req, res) => {
  try {
    /* ----------------------------------------------
     * 1) Load base services  (REAL TABLE)
     * ---------------------------------------------- */
    const base = await query(`
      SELECT
        id,
        name,
        category,
        base_points,
        free_chats,
        is_active
      FROM app_horoscope_services
      WHERE is_active = true
      ORDER BY name;
    `);

    /* ----------------------------------------------
     * 2) Load tier multipliers (REAL TABLE)
     * ---------------------------------------------- */
    let multipliers = { free: 1, lite: 1, pro: 1 };
    try {
      const r = await query(`
        SELECT tier, multiplier
        FROM app_horoscope_tier_multipliers;
      `);
      r.rows.forEach((x) => (multipliers[x.tier] = Number(x.multiplier)));
    } catch (e) {
      console.warn('Tier multipliers table missing → using default 1x');
    }

    /* ----------------------------------------------
     * 3) Optional: load default model assignment table
     *    (MAY OR MAY NOT EXIST)
     *    NOTE: uses model_id, not model_code
     * ---------------------------------------------- */
    let modelMap = {};

    try {
      const modelRows = await query(`
        SELECT service_id, tier, model_id
        FROM app_horoscope_service_models;
      `);

      modelRows.rows.forEach((m) => {
        modelMap[`${m.service_id}:${m.tier}`] = m.model_id;
      });
    } catch (e) {
      console.warn('No app_horoscope_service_models table → models empty');
    }

    /* ----------------------------------------------
     * 4) Build final payload
     * ---------------------------------------------- */
    const services = base.rows.map((s) => ({
      id: s.id,
      name: s.name,
      category: s.category,
      tiers: {
        free: {
          model: modelMap[`${s.id}:free`] || '',
          points: Math.round(Number(s.base_points) * (multipliers.free || 1)),
        },
        lite: {
          model: modelMap[`${s.id}:lite`] || '',
          points: Math.round(Number(s.base_points) * (multipliers.lite || 1)),
        },
        pro: {
          model: modelMap[`${s.id}:pro`] || '',
          points: Math.round(Number(s.base_points) * (multipliers.pro || 1)),
        },
      },
      freeQuestions: Number(s.free_chats),
      dataLevel: 'summary', // future: make dynamic
      responseFormat: 'json', // future: make dynamic
    }));

    return res.json(services);
  } catch (err) {
    console.error('ERROR: /ai-config/services', err);
    return res.status(500).json({ error: 'Failed to load services' });
  }
});

/* ===================================================
 * 1B) SERVICE METADATA UPSERT – app_horoscope_services
 *      PUT /ai-config/services/:id
 *      - updates base_points + free_chats using tiers + multipliers
 * =================================================== */

router.put('/ai-config/services/:id', async (req, res) => {
  const { id } = req.params;
  const body = req.body || {};

  try {
    const {
      name,
      category,
      dataLevel,
      freeQuestions,
      responseFormat,
      tiers,
    } = body;

    // Load multipliers so we can derive base_points from tier points
    let multipliers = { free: 1, lite: 1, pro: 1 };
    try {
      const r = await query(`
        SELECT tier, multiplier
        FROM app_horoscope_tier_multipliers;
      `);
      r.rows.forEach((x) => (multipliers[x.tier] = Number(x.multiplier) || 1));
    } catch (e) {
      console.warn('Tier multipliers table missing → using default 1x');
    }

    // Safely extract points for the tiers (if present)
    const freePoints = Number(tiers?.free?.points ?? 0);
    const litePoints = Number(tiers?.lite?.points ?? 0);
    const proPoints = Number(tiers?.pro?.points ?? 0);

    // Derive base_points from whichever tier has a non-zero value.
    // Priority: pro → free → lite
    let basePoints = 0;
    if (proPoints > 0 && multipliers.pro) {
      basePoints = Math.round(proPoints / multipliers.pro);
    } else if (freePoints > 0 && multipliers.free) {
      basePoints = Math.round(freePoints / multipliers.free);
    } else if (litePoints > 0 && multipliers.lite) {
      basePoints = Math.round(litePoints / multipliers.lite);
    }

    if (!Number.isFinite(basePoints)) basePoints = 0;

    const safeName = (name || '').trim() || id;
    const safeCategory = category || 'Misc';
    const freeChats = Number(freeQuestions ?? 0);

    // Upsert into app_horoscope_services – no assumption about extra columns
    await query(
      `
      INSERT INTO app_horoscope_services
        (id, name, category, base_points, free_chats, is_active)
      VALUES
        ($1, $2, $3, $4, $5, TRUE)
      ON CONFLICT (id)
      DO UPDATE SET
        name        = EXCLUDED.name,
        category    = EXCLUDED.category,
        base_points = EXCLUDED.base_points,
        free_chats  = EXCLUDED.free_chats,
        is_active   = TRUE;
      `,
      [id, safeName, safeCategory, basePoints, freeChats]
    );

    // Respond with what we *intend* the config to be (client uses this)
    return res.json({
      id,
      name: safeName,
      category: safeCategory,
      tiers: {
        free: {
          model: tiers?.free?.model || '',
          points:
            freePoints ||
            Math.round(basePoints * (multipliers.free || 1)) ||
            0,
        },
        lite: {
          model: tiers?.lite?.model || '',
          points:
            litePoints ||
            Math.round(basePoints * (multipliers.lite || 1)) ||
            0,
        },
        pro: {
          model: tiers?.pro?.model || '',
          points:
            proPoints ||
            Math.round(basePoints * (multipliers.pro || 1)) ||
            0,
        },
      },
      freeQuestions: freeChats,
      dataLevel: dataLevel || 'summary',
      responseFormat: responseFormat || 'json',
    });
  } catch (err) {
    console.error('PUT /ai-config/services/:id error', err);
    return res
      .status(500)
      .json({ error: 'Failed to upsert service configuration' });
  }
});

/* ===================================================
 * 1C) SERVICE MODEL UPSERT – app_horoscope_service_models
 *      POST /ai-config/services/:id/models
 *      - replaces rows for service_id with new tier→model_id mapping
 * =================================================== */

// ---------------------------------------------------
// NEW: Assign / update models for a service
// POST /api/admin/ai-config/services/:id/models
// Body: { tiers: { free: {model}, lite: {model}, pro: {model} } }
// ---------------------------------------------------
router.post('/ai-config/services/:id/models', async (req, res) => {
  const { id: serviceId } = req.params;
  const tiersPayload = (req.body && req.body.tiers) || {};

  try {
    if (!serviceId) {
      return res.status(400).json({ error: 'Missing service id in URL' });
    }

    // 1) Gather tier → model entries (only those that have a non-empty model)
    const tierNames = ['free', 'lite', 'pro'];
    const entries = tierNames
      .map((tier) => {
        const raw = tiersPayload?.[tier]?.model
          ? String(tiersPayload[tier].model).trim()
          : '';

        if (!raw) return null;

        // 🔸 If you want, add a friendly-name → real model_id map here
        // const FRIENDLY_MODEL_MAP = {
        //   'gemini-pro': 'google_gemini_pro',
        //   'perplexity-sonar': 'perplexity_sonar_l',
        //   'gpt-4-turbo': 'openai_gpt4_turbo',
        // };
        // const modelId = FRIENDLY_MODEL_MAP[raw] || raw;

        const modelId = raw; // assumes raw is already a valid model_id

        return { tier, model: modelId };
      })
      .filter((x) => x !== null);

    if (!entries.length) {
      return res.status(400).json({
        error: 'No valid tier models provided – expected tiers.free|lite|pro.model',
      });
    }

    // 2) Ensure service exists (avoids PK issues on service_id)
    const serviceCheck = await query(
      `
      SELECT id, name, category, base_points, free_chats
      FROM app_horoscope_services
      WHERE id = $1;
      `,
      [serviceId]
    );

    if (serviceCheck.rowCount === 0) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const serviceRow = serviceCheck.rows[0];

    // 3) Check that all model_ids exist in app_ai_provider_models
    const modelIds = [...new Set(entries.map((e) => e.model))];

    if (modelIds.length > 0) {
      const modelResult = await query(
        `
        SELECT model_id
        FROM app_ai_provider_models
        WHERE model_id = ANY($1);
        `,
        [modelIds]
      );

      const found = new Set(modelResult.rows.map((r) => r.model_id));
      const missing = modelIds.filter((m) => !found.has(m));

      if (missing.length > 0) {
        return res.status(400).json({
          error: 'Some model_ids do not exist in app_ai_provider_models',
          missing,
        });
      }
    }

    // 4) Upsert rows in app_horoscope_service_models
    //    If (service_id, tier) exists → UPDATE; else → INSERT
    for (const { tier, model } of entries) {
      await query(
        `
        INSERT INTO app_horoscope_service_models (service_id, tier, model_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (service_id, tier)
        DO UPDATE SET
          model_id = EXCLUDED.model_id;
        `,
        [serviceId, tier, model]
      );
    }

    // 5) Re-build a single service payload similar to GET /ai-config/services
    //    (no logic change to points, just reusing base_points & multipliers)
    let multipliers = { free: 1, lite: 1, pro: 1 };
    try {
      const r = await query(`
        SELECT tier, multiplier
        FROM app_horoscope_tier_multipliers;
      `);
      r.rows.forEach((x) => {
        multipliers[x.tier] = Number(x.multiplier);
      });
    } catch (e) {
      console.warn('Tier multipliers table missing → using default 1x');
    }

    // Load models JUST for this service
    let modelMap = {};
    try {
      const modelRows = await query(
        `
        SELECT service_id, tier, model_id
        FROM app_horoscope_service_models
        WHERE service_id = $1;
        `,
        [serviceId]
      );

      modelRows.rows.forEach((m) => {
        modelMap[`${m.service_id}:${m.tier}`] = m.model_id;
      });
    } catch (e) {
      console.warn('No app_horoscope_service_models rows for service', serviceId);
    }

    const payload = {
      id: serviceRow.id,
      name: serviceRow.name || serviceId,
      category: serviceRow.category || 'Misc',
      tiers: {
        free: {
          model: modelMap[`${serviceRow.id}:free`] || '',
          points: Math.round(Number(serviceRow.base_points) * (multipliers.free || 1)),
        },
        lite: {
          model: modelMap[`${serviceRow.id}:lite`] || '',
          points: Math.round(Number(serviceRow.base_points) * (multipliers.lite || 1)),
        },
        pro: {
          model: modelMap[`${serviceRow.id}:pro`] || '',
          points: Math.round(Number(serviceRow.base_points) * (multipliers.pro || 1)),
        },
      },
      // we keep same style as before: freeQuestions from DB, and
      // dataLevel/responseFormat are *not* persisted in this route
      freeQuestions: Number(serviceRow.free_chats || 0),
      dataLevel: 'summary',
      responseFormat: 'json',
    };

    return res.json(payload);
  } catch (err) {
    console.error('POST /ai-config/services/:id/models error', err);
    return res.status(500).json({
      error: 'Failed to upsert service models',
      detail: err.message || String(err),
    });
  }
});



/* ---------------------------------------------------
 * 2) PROVIDERS – astro_api_provider_config + app_ai_provider_models
 * --------------------------------------------------- */

router.get('/ai-config/providers', async (req, res) => {
  try {
    const providersResult = await query(
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
      WHERE enabled = true
      ORDER BY name;
      `
    );

    // updated: use model_id instead of model_code, no id
    let modelsResult = { rows: [] };
    try {
      modelsResult = await query(
        `
        SELECT
          model_id,
          provider_api_id,
          display_name,
          max_tokens,
          creativity,
          cost_per_1k,
          avg_latency_ms
        FROM app_ai_provider_models;
        `
      );
    } catch {
      modelsResult = { rows: [] };
    }

    const modelsByProvider = modelsResult.rows.reduce((acc, row) => {
      const key = row.provider_api_id;
      if (!acc[key]) acc[key] = [];
      acc[key].push(row);
      return acc;
    }, {});

    const payload = providersResult.rows.map((p) => {
      const modelRows = modelsByProvider[p.api_id] || [];
      const models = modelRows.map((m) => m.model_id);

      const avgCreativity = modelRows[0]?.creativity ?? 0.7;
      const maxTokens = modelRows[0]?.max_tokens ?? 4096;
      const costPer1k = modelRows[0]?.cost_per_1k ?? 0;
      const avgLatency = modelRows[0]?.avg_latency_ms ?? 1000;

      return {
        id: p.api_id,
        name: p.name,
        models,
        creativity: Number(avgCreativity),
        maxTokens: Number(maxTokens),
        costPer1k: Number(costPer1k),
        avgLatency: Number(avgLatency),
        role: p.role,
        provider: p.provider,
        allowedChats: p.allowed_chats || [],
        allowedFeatures: p.allowed_features || [],
      };
    });

    res.json(payload);
  } catch (err) {
    console.error('Error in GET /ai-config/providers', err);
    res.status(500).json({ error: 'Failed to load providers' });
  }
});

/* ---------------------------------------------------
 * 3) PROMPTS – from app_ai_prompt_templates
 * --------------------------------------------------- */

router.get('/ai-config/prompts', async (req, res) => {
  try {
    const result = await query(
      `
      SELECT
        id,
        service_id,
        persona,
        language,
        system_prompt,
        user_template,
        version,
        status
      FROM app_ai_prompt_templates
      ORDER BY service_id, persona, language;
      `
    );

    const prompts = result.rows.map((row) => ({
      id: row.id,
      service: row.service_id ?? 'daily', // what your Angular UI expects
      persona: row.persona,
      language: row.language,
      systemPrompt: row.system_prompt,
      userTemplate: row.user_template,
      version: row.version,
      status: row.status,
    }));

    res.json(prompts);
  } catch (err) {
    console.error('Error in GET /ai-config/prompts', err);
    res.status(500).json({ error: 'Failed to load prompts' });
  }
});

/* ---------------------------------------------------
 * 4) DATA CONFIGS – from app_ai_data_configs
 * --------------------------------------------------- */

router.get('/ai-config/data-configs', async (req, res) => {
  try {
    const result = await query(
      `
      SELECT
        id,
        service,
        level,
        description
      FROM app_ai_data_configs
      ORDER BY service;
      `
    );

    const dataConfigs = result.rows.map((row) => ({
      id: row.id,
      service: row.service,
      level: row.level,
      description: row.description,
    }));

    res.json(dataConfigs);
  } catch (err) {
    console.error('Error in GET /ai-config/data-configs', err);
    res.status(500).json({ error: 'Failed to load data configs' });
  }
});

/* ---------------------------------------------------
 * 5) JSON SCHEMA – app_ai_json_schema + app_ai_json_schema_fields
 * --------------------------------------------------- */

router.get('/ai-config/json-schema', async (req, res) => {
  try {
    // we treat 'global' as the main schema – you can change this later
    const schemaResult = await query(
      `
      SELECT schema_id, root_object
      FROM app_ai_json_schema
      WHERE schema_id = 'global';
      `
    );

    if (schemaResult.rows.length === 0) {
      return res.json({
        rootObject: 'horoscope_response',
        fields: [],
      });
    }

    const schemaRow = schemaResult.rows[0];

    const fieldsResult = await query(
      `
      SELECT
        name,
        type,
        description,
        example
      FROM app_ai_json_schema_fields
      WHERE schema_id = $1
      ORDER BY sort_order, id;
      `,
      [schemaRow.schema_id]
    );

    const fields = fieldsResult.rows.map((f) => ({
      name: f.name,
      type: f.type,
      description: f.description,
      example: f.example,
    }));

    res.json({
      rootObject: schemaRow.root_object,
      fields,
    });
  } catch (err) {
    console.error('Error in GET /ai-config/json-schema', err);
    res.status(500).json({ error: 'Failed to load JSON schema' });
  }
});

/* ---------------------------------------------------
 * 6) EXPERIMENTS – from app_ai_experiments
 * --------------------------------------------------- */

router.get('/ai-config/experiments', async (req, res) => {
  try {
    const result = await query(
      `
      SELECT
        id,
        name,
        service_id,
        variant_a_model,
        variant_a_prompt,
        variant_b_model,
        variant_b_prompt,
        split,
        metric,
        status,
        result_variant_a,
        result_variant_b
      FROM app_ai_experiments
      ORDER BY created_at DESC;
      `
    );

    const experiments = result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      service: row.service_id ?? 'daily', // what the Angular UI expects
      variantA: {
        model: row.variant_a_model,
        prompt: row.variant_a_prompt,
      },
      variantB: {
        model: row.variant_b_model,
        prompt: row.variant_b_prompt,
      },
      split: Number(row.split),
      metric: row.metric,
      status: row.status,
      results: {
        variantA:
          row.result_variant_a != null ? Number(row.result_variant_a) : 0,
        variantB:
          row.result_variant_b != null ? Number(row.result_variant_b) : 0,
      },
    }));

    res.json(experiments);
  } catch (err) {
    console.error('Error in GET /ai-config/experiments', err);
    res.status(500).json({ error: 'Failed to load experiments' });
  }
});

/* ===================================================
 *  A) PROMPTS CRUD – app_ai_prompt_templates
 * =================================================== */

// CREATE prompt
router.post('/ai-config/prompts', async (req, res) => {
  try {
    const {
      service,
      persona,
      language,
      systemPrompt,
      userTemplate,
      version,
      status,
    } = req.body;

    const result = await query(
      `
      INSERT INTO app_ai_prompt_templates
        (service, persona, language, system_prompt, user_template, version, status)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7)
      RETURNING
        id, service, persona, language, system_prompt, user_template, version, status;
      `,
      [
        service,
        persona,
        language,
        systemPrompt,
        userTemplate,
        version,
        status,
      ]
    );

    const row = result.rows[0];
    res.status(201).json({
      id: row.id,
      service: row.service,
      persona: row.persona,
      language: row.language,
      systemPrompt: row.system_prompt,
      userTemplate: row.user_template,
      version: row.version,
      status: row.status,
    });
  } catch (err) {
    console.error('POST /ai-config/prompts error', err);
    res.status(500).json({ error: 'Failed to create prompt' });
  }
});

// UPDATE prompt
router.put('/ai-config/prompts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      service,
      persona,
      language,
      systemPrompt,
      userTemplate,
      version,
      status,
    } = req.body;

    const result = await query(
      `
      UPDATE app_ai_prompt_templates
      SET
        service       = $1,
        persona       = $2,
        language      = $3,
        system_prompt = $4,
        user_template = $5,
        version       = $6,
        status        = $7
      WHERE id = $8
      RETURNING
        id, service, persona, language, system_prompt, user_template, version, status;
      `,
      [
        service,
        persona,
        language,
        systemPrompt,
        userTemplate,
        version,
        status,
        id,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Prompt not found' });
    }

    const row = result.rows[0];
    res.json({
      id: row.id,
      service: row.service,
      persona: row.persona,
      language: row.language,
      systemPrompt: row.system_prompt,
      userTemplate: row.user_template,
      version: row.version,
      status: row.status,
    });
  } catch (err) {
    console.error('PUT /ai-config/prompts/:id error', err);
    res.status(500).json({ error: 'Failed to update prompt' });
  }
});

// DELETE prompt
router.delete('/ai-config/prompts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await query(
      `DELETE FROM app_ai_prompt_templates WHERE id = $1`,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Prompt not found' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /ai-config/prompts/:id error', err);
    res.status(500).json({ error: 'Failed to delete prompt' });
  }
});

/* ===================================================
 *  B) PROVIDER SETTINGS UPDATE – app_ai_provider_models
 *  (we update all models for a provider)
 * =================================================== */

router.put('/ai-config/providers/:id', async (req, res) => {
  try {
    const { id } = req.params; // provider api_id
    const { creativity, maxTokens, costPer1k, avgLatency } = req.body;

    // Update all rows for this provider
    await query(
      `
      UPDATE app_ai_provider_models
      SET
        creativity     = $1,
        max_tokens     = $2,
        cost_per_1k    = $3,
        avg_latency_ms = $4
      WHERE provider_api_id = $5;
      `,
      [creativity, maxTokens, costPer1k, avgLatency, id]
    );

    // Return fresh providers payload using existing GET code
    const providersResult = await query(
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
      WHERE enabled = true
      ORDER BY name;
      `
    );

    const modelsResult = await query(
      `
      SELECT
        model_id,
        provider_api_id,
        max_tokens,
        creativity,
        cost_per_1k,
        avg_latency_ms
      FROM app_ai_provider_models;
      `
    );

    const modelsByProvider = modelsResult.rows.reduce((acc, row) => {
      const key = row.provider_api_id;
      if (!acc[key]) acc[key] = [];
      acc[key].push(row);
      return acc;
    }, {});

    const payload = providersResult.rows.map((p) => {
      const modelRows = modelsByProvider[p.api_id] || [];
      const models = modelRows.map((m) => m.model_id);
      const first = modelRows[0];

      return {
        id: p.api_id,
        name: p.name,
        models,
        creativity: Number(first?.creativity ?? creativity ?? 0.7),
        maxTokens: Number(first?.max_tokens ?? maxTokens ?? 4096),
        costPer1k: Number(first?.cost_per_1k ?? costPer1k ?? 0),
        avgLatency: Number(first?.avg_latency_ms ?? avgLatency ?? 1000),
        role: p.role,
        provider: p.provider,
        allowedChats: p.allowed_chats || [],
        allowedFeatures: p.allowed_features || [],
      };
    });

    res.json(payload);
  } catch (err) {
    console.error('PUT /ai-config/providers/:id error', err);
    res.status(500).json({ error: 'Failed to update provider settings' });
  }
});

/* ===================================================
 *  C) DATA CONFIGS – app_ai_data_configs
 *  PUT expects an array of { id?, service, level, description }
 * =================================================== */

router.put('/ai-config/data-configs', async (req, res) => {
  const configs = Array.isArray(req.body) ? req.body : [];
  try {
    // upsert by service
    for (const cfg of configs) {
      await query(
        `
        INSERT INTO app_ai_data_configs(service, level, description)
        VALUES ($1, $2, $3)
        ON CONFLICT (service)
        DO UPDATE SET
          level       = EXCLUDED.level,
          description = EXCLUDED.description;
        `,
        [cfg.service, cfg.level, cfg.description]
      );
    }

    const result = await query(
      `
      SELECT id, service, level, description
      FROM app_ai_data_configs
      ORDER BY service;
      `
    );
    res.json(result.rows);
  } catch (err) {
    console.error('PUT /ai-config/data-configs error', err);
    res.status(500).json({ error: 'Failed to update data configs' });
  }
});

/* ===================================================
 *  D) JSON SCHEMA – app_ai_json_schema + app_ai_json_schema_fields
 * =================================================== */

router.put('/ai-config/json-schema', async (req, res) => {
  const { rootObject, fields } = req.body || {};
  const schemaId = 'global';

  const client = await query.client();
  try {
    await client.query('BEGIN');

    await client.query(
      `
      INSERT INTO app_ai_json_schema(schema_id, root_object)
      VALUES ($1, $2)
      ON CONFLICT (schema_id)
      DO UPDATE SET
        root_object = EXCLUDED.root_object;
      `,
      [schemaId, rootObject]
    );

    await client.query(
      `DELETE FROM app_ai_json_schema_fields WHERE schema_id = $1`,
      [schemaId]
    );

    if (Array.isArray(fields)) {
      let sort = 0;
      for (const f of fields) {
        await client.query(
          `
          INSERT INTO app_ai_json_schema_fields
            (schema_id, name, type, description, example, sort_order)
          VALUES
            ($1, $2, $3, $4, $5, $6);
          `,
          [schemaId, f.name, f.type, f.description, f.example, sort++]
        );
      }
    }

    await client.query('COMMIT');

    res.json({ rootObject, fields: fields || [] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PUT /ai-config/json-schema error', err);
    res.status(500).json({ error: 'Failed to update JSON schema' });
  } finally {
    client.release();
  }
});

/* ===================================================
 *  E) EXPERIMENTS CRUD – app_ai_experiments
 * =================================================== */

// CREATE experiment
router.post('/ai-config/experiments', async (req, res) => {
  try {
    const { name, service, variantA, variantB, split, metric, status } =
      req.body;

    const result = await query(
      `
      INSERT INTO app_ai_experiments
        (name, service,
         variant_a_model, variant_a_prompt,
         variant_b_model, variant_b_prompt,
         split, metric, status)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING
        id,
        name,
        service,
        variant_a_model,
        variant_a_prompt,
        variant_b_model,
        variant_b_prompt,
        split,
        metric,
        status,
        result_variant_a,
        result_variant_b;
      `,
      [
        name,
        service,
        variantA?.model,
        variantA?.prompt,
        variantB?.model,
        variantB?.prompt,
        split,
        metric,
        status,
      ]
    );

    const row = result.rows[0];
    res.status(201).json({
      id: row.id,
      name: row.name,
      service: row.service,
      variantA: {
        model: row.variant_a_model,
        prompt: row.variant_a_prompt,
      },
      variantB: {
        model: row.variant_b_model,
        prompt: row.variant_b_prompt,
      },
      split: Number(row.split),
      metric: row.metric,
      status: row.status,
      results: {
        variantA: Number(row.result_variant_a || 0),
        variantB: Number(row.result_variant_b || 0),
      },
    });
  } catch (err) {
    console.error('POST /ai-config/experiments error', err);
    res.status(500).json({ error: 'Failed to create experiment' });
  }
});

// UPDATE experiment
router.put('/ai-config/experiments/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      service,
      variantA,
      variantB,
      split,
      metric,
      status,
      results,
    } = req.body;

    const result = await query(
      `
      UPDATE app_ai_experiments
      SET
        name             = $1,
        service          = $2,
        variant_a_model  = $3,
        variant_a_prompt = $4,
        variant_b_model  = $5,
        variant_b_prompt = $6,
        split            = $7,
        metric           = $8,
        status           = $9,
        result_variant_a = $10,
        result_variant_b = $11
      WHERE id = $12
      RETURNING
        id,
        name,
        service,
        variant_a_model,
        variant_a_prompt,
        variant_b_model,
        variant_b_prompt,
        split,
        metric,
        status,
        result_variant_a,
        result_variant_b;
      `,
      [
        name,
        service,
        variantA?.model,
        variantA?.prompt,
        variantB?.model,
        variantB?.prompt,
        split,
        metric,
        status,
        results?.variantA ?? 0,
        results?.variantB ?? 0,
        id,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Experiment not found' });
    }

    const row = result.rows[0];
    res.json({
      id: row.id,
      name: row.name,
      service: row.service,
      variantA: {
        model: row.variant_a_model,
        prompt: row.variant_a_prompt,
      },
      variantB: {
        model: row.variant_b_model,
        prompt: row.variant_b_prompt,
      },
      split: Number(row.split),
      metric: row.metric,
      status: row.status,
      results: {
        variantA: Number(row.result_variant_a || 0),
        variantB: Number(row.result_variant_b || 0),
      },
    });
  } catch (err) {
    console.error('PUT /ai-config/experiments/:id error', err);
    res.status(500).json({ error: 'Failed to update experiment' });
  }
});

// DELETE experiment
router.delete('/ai-config/experiments/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await query(
      `DELETE FROM app_ai_experiments WHERE id = $1`,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Experiment not found' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /ai-config/experiments/:id error', err);
    res.status(500).json({ error: 'Failed to delete experiment' });
  }
});


export default router;
