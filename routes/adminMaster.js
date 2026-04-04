// routes/adminMaster.js (ESM version)
import express from 'express';
import pkg from 'pg';

const { Pool } = pkg;

const router = express.Router();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/* ========== HELPERS ========== */

async function runQuery(res, label, sql, params, mapper) {
  try {
    const { rows } = await pool.query(sql, params);
    const data = mapper ? mapper(rows) : rows;
    return res.json(data);
  } catch (err) {
    console.error(label, err);
    return res.status(500).json({
      error: err.message || `Error in ${label}`,
    });
  }
}

/**
 * Central DB error handler for constraint violations etc.
 */
function handleDbError(res, err, context) {
  console.error(context, err);

  // Unique constraint violations
  if (err.code === '23505') {
    switch (err.constraint) {
      case 'app_module_master_module_code_key':
        return res.status(409).json({
          error: 'Module code already exists',
          field: 'module_code',
        });

      case 'app_sub_module_master_module_id_sub_module_code_key':
        return res.status(409).json({
          error: 'Sub-module code already exists for this module',
          field: 'sub_module_code',
        });

      case 'app_topic_master_topic_code_key':
        return res.status(409).json({
          error: 'Topic code already exists',
          field: 'topic_code',
        });

      // example: one mapping per API+provider+model
      case 'app_api_model_config_api_id_provider_code_model_id_key':
        return res.status(409).json({
          error: 'This API is already mapped to that provider/model',
          field: 'model_id',
        });
    }
  }

  // Foreign key constraint violations
  if (err.code === '23503') {
    switch (err.constraint) {
      case 'app_api_master_module_id_fkey':
        return res.status(409).json({
          error:
            'Cannot delete this module because APIs are registered under it.',
          details:
            'Please delete or reassign the APIs in API_MASTER before deleting this module.',
        });

      case 'app_api_model_config_api_id_fkey':
        return res.status(409).json({
          error:
            'Cannot delete this API because model mappings exist for it.',
          details:
            'Please delete or update rows in API_MODEL_CONFIG before deleting this API.',
        });
    }
  }

  // Fallback
  return res.status(500).json({
    error: err.message || 'Unexpected database error',
  });
}

/* ===========================================================
 *                     API MODEL CONFIG
 * ===========================================================
 */

// GET all API model configs
// routes/adminMaster.js (or similar)

router.get('/api-models', async (req, res) => {
  await runQuery(
    res,
    'GET /api-models',
    'SELECT * FROM usp_api_model_get_all()',
    [],
    (rows) =>
      rows.map((r) => ({
        // 🔑 primary key – REQUIRED so edit works
        id: Number(r.id),

        // FK + labels
        api_id: Number(r.api_id),
        api_code: r.api_code || null,
        api_name: r.api_name || null,

        // model settings
        provider_code: r.provider_code,
        model_id: r.model_id,
        max_tokens:
          r.max_tokens !== null && r.max_tokens !== undefined
            ? Number(r.max_tokens)
            : null,
        temperature:
          r.temperature !== null && r.temperature !== undefined
            ? Number(r.temperature)
            : null,
        is_enabled: !!r.is_enabled,
        sort_order:
          r.sort_order !== null && r.sort_order !== undefined
            ? Number(r.sort_order)
            : 0,
      }))
  );
});


// CREATE API model mapping
router.post('/api-models', async (req, res) => {
  const body = req.body || {};
  const {
    api_id,
    provider_code,
    model_id,
    max_tokens,
    temperature,
    is_enabled,
    sort_order,
  } = body;

  if (!api_id || !provider_code || !model_id) {
    return res.status(400).json({
      error: 'api_id, provider_code and model_id are required',
    });
  }

  try {
    const { rows } = await pool.query(
      'SELECT * FROM usp_api_model_insert($1,$2,$3,$4,$5,$6,$7)',
      [
        api_id,
        provider_code,
        model_id,
        max_tokens || null,
        temperature ?? null,
        typeof is_enabled === 'boolean' ? is_enabled : true,
        sort_order || 0,
      ]
    );

    const r = rows[0];
    return res.status(201).json({
      id: r.api_model_id,
      api_id: r.api_id,
      provider_code: r.provider_code,
      model_id: r.model_id,
      max_tokens: r.max_tokens,
      temperature: r.temperature,
      is_enabled: r.is_enabled,
      sort_order: r.sort_order,
    });
  } catch (err) {
    return handleDbError(res, err, 'POST /api-models');
  }
});

// UPDATE API model mapping
router.put('/api-models/:id', async (req, res) => {
  const id = Number(req.params.id || 0);
  const body = req.body || {};
  const {
    api_id,
    provider_code,
    model_id,
    max_tokens,
    temperature,
    is_enabled,
    sort_order,
  } = body;

  if (!api_id || !provider_code || !model_id) {
    return res.status(400).json({
      error: 'api_id, provider_code and model_id are required',
    });
  }

  try {
    const { rows } = await pool.query(
      'SELECT * FROM usp_api_model_update($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        id,
        api_id,
        provider_code,
        model_id,
        max_tokens || null,
        temperature ?? null,
        typeof is_enabled === 'boolean' ? is_enabled : null,
        sort_order || null,
      ]
    );

    const r = rows[0];
    return res.json({
      id: r.api_model_id,
      api_id: r.api_id,
      provider_code: r.provider_code,
      model_id: r.model_id,
      max_tokens: r.max_tokens,
      temperature: r.temperature,
      is_enabled: r.is_enabled,
      sort_order: r.sort_order,
    });
  } catch (err) {
    return handleDbError(res, err, 'PUT /api-models');
  }
});

// DELETE API model mapping
router.delete('/api-models/:id', async (req, res) => {
  const id = Number(req.params.id || 0);

  try {
    await pool.query('SELECT usp_api_model_delete($1)', [id]);
    return res.json({ ok: true });
  } catch (err) {
    return handleDbError(res, err, 'DELETE /api-models');
  }
});

/* ===========================================================
 *                       MODULES
 * ===========================================================
 */

// GET all modules
router.get('/modules', async (req, res) => {
  await runQuery(
    res,
    'GET /modules',
    'SELECT * FROM usp_module_get_all()',
    [],
    (rows) =>
      rows.map((r) => ({
        id: r.module_id,
        module_code: r.module_code,
        module_name: r.module_name,
        description: r.description,
        is_enabled: r.is_enabled,
        sort_order: r.sort_order,
      }))
  );
});

// CREATE module
router.post('/modules', async (req, res) => {
  const { module_code, module_name, description, is_enabled, sort_order } =
    req.body;

  try {
    const { rows } = await pool.query(
      'SELECT * FROM usp_module_insert($1,$2,$3,$4,$5)',
      [
        module_code,
        module_name,
        description || null,
        typeof is_enabled === 'boolean' ? is_enabled : true,
        sort_order || 0,
      ]
    );

    const r = rows[0];
    return res.status(201).json({
      id: r.module_id,
      module_code: r.module_code,
      module_name: r.module_name,
      description: r.description,
      is_enabled: r.is_enabled,
      sort_order: r.sort_order,
    });
  } catch (err) {
    return handleDbError(res, err, 'POST /modules');
  }
});

// UPDATE module
router.put('/modules/:id', async (req, res) => {
  const id = Number(req.params.id || 0);
  const { module_code, module_name, description, is_enabled, sort_order } =
    req.body;

  try {
    const { rows } = await pool.query(
      'SELECT * FROM usp_module_update($1,$2,$3,$4,$5,$6)',
      [
        id,
        module_code,
        module_name,
        description || null,
        typeof is_enabled === 'boolean' ? is_enabled : null,
        sort_order || null,
      ]
    );

    const r = rows[0];
    return res.json({
      id: r.module_id,
      module_code: r.module_code,
      module_name: r.module_name,
      description: r.description,
      is_enabled: r.is_enabled,
      sort_order: r.sort_order,
    });
  } catch (err) {
    return handleDbError(res, err, 'PUT /modules');
  }
});

// DELETE module
router.delete('/modules/:id', async (req, res) => {
  const id = Number(req.params.id || 0);

  try {
    await pool.query('SELECT usp_module_delete($1)', [id]);
    return res.json({ ok: true });
  } catch (err) {
    return handleDbError(res, err, 'DELETE /modules');
  }
});

/* ===========================================================
 *                     SUB-MODULES
 * ===========================================================
 */

// GET all sub-modules
router.get('/sub-modules', async (req, res) => {
  await runQuery(
    res,
    'GET /sub-modules',
    'SELECT * FROM usp_sub_module_get_all()',
    [],
    (rows) =>
      rows.map((r) => ({
        id: r.sub_module_id,
        module_id: r.module_id,
        module_code: r.module_code,
        module_name: r.module_name,
        sub_module_code: r.sub_module_code,
        sub_module_name: r.sub_module_name,
        description: r.description,
        is_enabled: r.is_enabled,
        sort_order: r.sort_order,
      }))
  );
});

// CREATE sub-module
router.post('/sub-modules', async (req, res) => {
  const {
    module_id,
    sub_module_code,
    sub_module_name,
    description,
    is_enabled,
    sort_order,
  } = req.body;

  try {
    const { rows } = await pool.query(
      'SELECT * FROM usp_sub_module_insert($1,$2,$3,$4,$5,$6)',
      [
        module_id,
        sub_module_code,
        sub_module_name,
        description || null,
        typeof is_enabled === 'boolean' ? is_enabled : true,
        sort_order || 0,
      ]
    );

    const r = rows[0];
    return res.status(201).json({
      id: r.sub_module_id,
      module_id: r.module_id,
      sub_module_code: r.sub_module_code,
      sub_module_name: r.sub_module_name,
      description: r.description,
      is_enabled: r.is_enabled,
      sort_order: r.sort_order,
    });
  } catch (err) {
    return handleDbError(res, err, 'POST /sub-modules');
  }
});

// UPDATE sub-module
router.put('/sub-modules/:id', async (req, res) => {
  const id = Number(req.params.id || 0);
  const {
    module_id,
    sub_module_code,
    sub_module_name,
    description,
    is_enabled,
    sort_order,
  } = req.body;

  try {
    const { rows } = await pool.query(
      'SELECT * FROM usp_sub_module_update($1,$2,$3,$4,$5,$6,$7)',
      [
        id,
        module_id,
        sub_module_code,
        sub_module_name,
        description || null,
        typeof is_enabled === 'boolean' ? is_enabled : null,
        sort_order || null,
      ]
    );

    const r = rows[0];
    return res.json({
      id: r.sub_module_id,
      module_id: r.module_id,
      sub_module_code: r.sub_module_code,
      sub_module_name: r.sub_module_name,
      description: r.description,
      is_enabled: r.is_enabled,
      sort_order: r.sort_order,
    });
  } catch (err) {
    return handleDbError(res, err, 'PUT /sub-modules');
  }
});

// DELETE sub-module
router.delete('/sub-modules/:id', async (req, res) => {
  const id = Number(req.params.id || 0);

  try {
    await pool.query('SELECT usp_sub_module_delete($1)', [id]);
    return res.json({ ok: true });
  } catch (err) {
    return handleDbError(res, err, 'DELETE /sub-modules');
  }
});

/* ===========================================================
 *                       TOPICS
 * ===========================================================
 */

// GET topics
router.get('/topics', async (req, res) => {
  await runQuery(
    res,
    'GET /topics',
    'SELECT * FROM usp_topic_get_all()',
    [],
    (rows) =>
      rows.map((r) => ({
        id: r.topic_id,
        topic_code: r.topic_code,
        topic_name: r.topic_name,
        description: r.description,
        is_enabled: r.is_enabled,
        sort_order: r.sort_order,
      }))
  );
});

// CREATE topic
router.post('/topics', async (req, res) => {
  const { topic_code, topic_name, description, is_enabled, sort_order } =
    req.body;

  try {
    const { rows } = await pool.query(
      'SELECT * FROM usp_topic_insert($1,$2,$3,$4,$5)',
      [
        topic_code,
        topic_name,
        description || null,
        typeof is_enabled === 'boolean' ? is_enabled : true,
        sort_order || 0,
      ]
    );

    const r = rows[0];
    return res.status(201).json({
      id: r.topic_id,
      topic_code: r.topic_code,
      topic_name: r.topic_name,
      description: r.description,
      is_enabled: r.is_enabled,
      sort_order: r.sort_order,
    });
  } catch (err) {
    return handleDbError(res, err, 'POST /topics');
  }
});

// UPDATE topic
// UPDATE topic
router.put('/topics/:id', async (req, res) => {
  const id = Number(req.params.id || 0);

  // ✅ safe destructuring
  const body = req.body || {};
  const { topic_code, topic_name, description, is_enabled, sort_order } = body;

  // ✅ basic validation
  if (!topic_code || !topic_name) {
    return res.status(400).json({
      error: 'Topic code and topic name are required',
      fields: ['topic_code', 'topic_name'],
    });
  }

  try {
    const { rows } = await pool.query(
      'SELECT * FROM usp_topic_update($1,$2,$3,$4,$5,$6)',
      [
        id,
        topic_code,
        topic_name,
        description || null,
        typeof is_enabled === 'boolean' ? is_enabled : null,
        sort_order || null,
      ]
    );

    const r = rows[0];
    return res.json({
      id: r.topic_id,
      topic_code: r.topic_code,
      topic_name: r.topic_name,
      description: r.description,
      is_enabled: r.is_enabled,
      sort_order: r.sort_order,
    });
  } catch (err) {
    return handleDbError(res, err, 'PUT /topics');
  }
});

// DELETE topic
router.delete('/topics/:id', async (req, res) => {
  const id = Number(req.params.id || 0);

  try {
    await pool.query('SELECT usp_topic_delete($1)', [id]);
    return res.json({ ok: true });
  } catch (err) {
    return handleDbError(res, err, 'DELETE /topics');
  }
});
/* ===========================================================
 *                     API MASTER
 * ===========================================================
 */

// GET all APIs
router.get('/api-master', async (req, res) => {
  await runQuery(
    res,
    'GET /api-master',
    'SELECT * FROM public.app_ai_api_master ORDER BY api_id',
    [],
    (rows) =>
      rows.map((r) => ({
        id: r.api_id,
        api_code: r.api_code,
        display_name: r.display_name,
        category: r.category,
        base_url: r.base_url,
        http_method: r.http_method,
        provider_name: r.provider_name,
        system_owner: r.system_owner,
        is_enabled: r.is_enabled,
        is_internal: r.is_internal,
        max_rps: r.max_rps,
        timeout_ms: r.timeout_ms,
        notes: r.notes,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }))
  );
});


// CREATE API
router.post('/api-master', async (req, res) => {
  const body = req.body || {};

  const {
    api_code,
    display_name,
    category,
    base_url,
    http_method,
    provider_name,
    system_owner,
    is_enabled,
    is_internal,
    max_rps,
    timeout_ms,
    notes,
  } = body;

  // basic validation – require key fields
  if (!api_code || !display_name || !http_method || !provider_name) {
    return res.status(400).json({
      error:
        'api_code, display_name, http_method and provider_name are required',
    });
  }

  try {
    const { rows } = await pool.query(
      `
        INSERT INTO public.app_ai_api_master (
          api_code,
          display_name,
          category,
          base_url,
          http_method,
          provider_name,
          system_owner,
          is_enabled,
          is_internal,
          max_rps,
          timeout_ms,
          notes
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        RETURNING *
      `,
      [
        api_code,
        display_name,
        category || null,
        base_url || null,
        http_method,
        provider_name,
        system_owner || null,
        typeof is_enabled === 'boolean' ? is_enabled : true,
        typeof is_internal === 'boolean' ? is_internal : false,
        max_rps ?? null,
        timeout_ms ?? null,
        notes || null,
      ]
    );

    const r = rows[0];
    return res.status(201).json({
      id: r.api_id,
      api_code: r.api_code,
      display_name: r.display_name,
      category: r.category,
      base_url: r.base_url,
      http_method: r.http_method,
      provider_name: r.provider_name,
      system_owner: r.system_owner,
      is_enabled: r.is_enabled,
      is_internal: r.is_internal,
      max_rps: r.max_rps,
      timeout_ms: r.timeout_ms,
      notes: r.notes,
      created_at: r.created_at,
      updated_at: r.updated_at,
    });
  } catch (err) {
    return handleDbError(res, err, 'POST /api-master');
  }
});

// UPDATE API
router.put('/api-master/:id', async (req, res) => {
  const id = Number(req.params.id || 0);
  const body = req.body || {};

  const {
    api_code,
    display_name,
    category,
    base_url,
    http_method,
    provider_name,
    system_owner,
    is_enabled,
    is_internal,
    max_rps,
    timeout_ms,
    notes,
  } = body;

  if (!api_code || !display_name || !http_method || !provider_name) {
    return res.status(400).json({
      error:
        'api_code, display_name, http_method and provider_name are required',
    });
  }

  try {
    const { rows } = await pool.query(
      `
        UPDATE public.app_ai_api_master
        SET
          api_code      = $2,
          display_name  = $3,
          category      = $4,
          base_url      = $5,
          http_method   = $6,
          provider_name = $7,
          system_owner  = $8,
          is_enabled    = COALESCE($9, is_enabled),
          is_internal   = COALESCE($10, is_internal),
          max_rps       = $11,
          timeout_ms    = $12,
          notes         = $13,
          updated_at    = NOW()
        WHERE api_id = $1
        RETURNING *
      `,
      [
        id,
        api_code,
        display_name,
        category || null,
        base_url || null,
        http_method,
        provider_name,
        system_owner || null,
        typeof is_enabled === 'boolean' ? is_enabled : null,
        typeof is_internal === 'boolean' ? is_internal : null,
        max_rps ?? null,
        timeout_ms ?? null,
        notes || null,
      ]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'API not found' });
    }

    const r = rows[0];
    return res.json({
      id: r.api_id,
      api_code: r.api_code,
      display_name: r.display_name,
      category: r.category,
      base_url: r.base_url,
      http_method: r.http_method,
      provider_name: r.provider_name,
      system_owner: r.system_owner,
      is_enabled: r.is_enabled,
      is_internal: r.is_internal,
      max_rps: r.max_rps,
      timeout_ms: r.timeout_ms,
      notes: r.notes,
      created_at: r.created_at,
      updated_at: r.updated_at,
    });
  } catch (err) {
    return handleDbError(res, err, 'PUT /api-master');
  }
});

// DELETE API
router.delete('/api-master/:id', async (req, res) => {
  const id = Number(req.params.id || 0);

  try {
    await pool.query(
      'DELETE FROM public.app_ai_api_master WHERE api_id = $1',
      [id]
    );
    return res.json({ ok: true });
  } catch (err) {
    return handleDbError(res, err, 'DELETE /api-master');
  }
});

export default router;
