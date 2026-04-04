// routes/chips.admin.route.js
import express from 'express';
import pool from '../src/db.js';

const router = express.Router();

// ------- GET all chips -------
// ------- GET all chips -------
// path under mount: /api/admin/chips
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.chip_id,
              c.chip_code,
              c.title,
              c.subtitle,
              c.icon,
              c.base_points_cost,
              c.is_premium_only,
              c.is_active,
              c.priority,
              COALESCE(
                json_agg(m.screen_code)
                FILTER (WHERE m.screen_code IS NOT NULL),
                '[]'
              ) AS modules
         FROM chip_master c
    LEFT JOIN chip_screen_map m
           ON m.chip_id = c.chip_id
     GROUP BY c.chip_id
     ORDER BY c.priority, c.title`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching chips:', err);
    res.status(500).json({ error: 'Failed to fetch chips' });
  }
});
async function replaceChipModules(client, chipId, modules) {
  // modules: string[]
  await client.query(
    'DELETE FROM chip_screen_map WHERE chip_id = $1',
    [chipId]
  );

  if (!Array.isArray(modules) || modules.length === 0) return;

  let priority = 0;
  for (const code of modules) {
    if (!code) continue;
    priority++;

    await client.query(
      `INSERT INTO chip_screen_map
         (chip_id, screen_code, priority, is_active)
       VALUES ($1, $2, $3, TRUE)`,
      [chipId, code, priority]
    );
  }
}


// ------- CREATE chip -------
router.post('/', async (req, res) => {
  const {
    chip_code,
    title,
    subtitle,
    icon,
    base_points_cost,
    is_premium_only,
    is_active,
    priority,
    modules // <-- string[]
  } = req.body;

  if (!chip_code || !title) {
    return res.status(400).json({ error: 'chip_code and title are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO chip_master
       (chip_code, title, subtitle, icon, base_points_cost,
        is_premium_only, is_active, priority)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        chip_code,
        title,
        subtitle || null,
        icon || null,
        base_points_cost ?? 0,
        !!is_premium_only,
        is_active !== false,
        priority ?? 0
      ]
    );

    const chip = result.rows[0];

    if (Array.isArray(modules)) {
      await replaceChipModules(client, chip.chip_id, modules);
    }

    // reload with modules list
    const full = await client.query(
      `SELECT c.*,
              COALESCE(
                json_agg(m.screen_code)
                FILTER (WHERE m.screen_code IS NOT NULL),
                '[]'
              ) AS modules
         FROM chip_master c
    LEFT JOIN chip_screen_map m
           ON m.chip_id = c.chip_id
        WHERE c.chip_id = $1
     GROUP BY c.chip_id`,
      [chip.chip_id]
    );

    await client.query('COMMIT');
    res.status(201).json(full.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating chip:', err);
    res.status(500).json({ error: 'Failed to create chip' });
  } finally {
    client.release();
  }
});

// ------- UPDATE chip -------
router.put('/:chipId', async (req, res) => {
  const { chipId } = req.params;
  const {
    chip_code,
    title,
    subtitle,
    icon,
    base_points_cost,
    is_premium_only,
    is_active,
    priority,
    modules
  } = req.body;

  if (!chip_code || !title) {
    return res.status(400).json({ error: 'chip_code and title are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `UPDATE chip_master
          SET chip_code       = $1,
              title           = $2,
              subtitle        = $3,
              icon            = $4,
              base_points_cost= $5,
              is_premium_only = $6,
              is_active       = $7,
              priority        = $8,
              updated_at      = NOW()
        WHERE chip_id = $9
        RETURNING *`,
      [
        chip_code,
        title,
        subtitle || null,
        icon || null,
        base_points_cost ?? 0,
        !!is_premium_only,
        is_active !== false,
        priority ?? 0,
        chipId
      ]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Chip not found' });
    }

    if (Array.isArray(modules)) {
      await replaceChipModules(client, chipId, modules);
    }

    const full = await client.query(
      `SELECT c.*,
              COALESCE(
                json_agg(m.screen_code)
                FILTER (WHERE m.screen_code IS NOT NULL),
                '[]'
              ) AS modules
         FROM chip_master c
    LEFT JOIN chip_screen_map m
           ON m.chip_id = c.chip_id
        WHERE c.chip_id = $1
     GROUP BY c.chip_id`,
      [chipId]
    );

    await client.query('COMMIT');
    res.json(full.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating chip:', err);
    res.status(500).json({ error: 'Failed to update chip' });
  } finally {
    client.release();
  }
});

// GET chips for a specific screen
router.get('/by-screen/:screenCode', async (req, res) => {
  const { screenCode } = req.params;
  try {
    const result = await pool.query(
      `SELECT c.*
         FROM chip_master c
         JOIN chip_screen_map m
           ON m.chip_id = c.chip_id
        WHERE m.screen_code = $1
          AND c.is_active = TRUE
          AND m.is_active = TRUE
        ORDER BY m.priority, c.priority, c.title`,
      [screenCode]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching chips for screen:', err);
    res.status(500).json({ error: 'Failed to fetch screen chips' });
  }
});

// ------- DELETE chip (only if no questions) -------
// path: DELETE /api/admin/chips/:chipId
router.delete('/:chipId', async (req, res) => {
  const { chipId } = req.params;

  try {
    // check if there are questions for this chip
    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS cnt
         FROM chip_question_template
        WHERE chip_id = $1`,
      [chipId]
    );

    if (countRes.rows[0].cnt > 0) {
      return res
        .status(400)
        .json({ error: 'Cannot delete chip: questions still exist' });
    }

    const del = await pool.query(
      `DELETE FROM chip_master
        WHERE chip_id = $1
        RETURNING *`,
      [chipId]
    );

    if (del.rows.length === 0) {
      return res.status(404).json({ error: 'Chip not found' });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Error deleting chip:', err);
    res.status(500).json({ error: 'Failed to delete chip' });
  }
});

// ------- GET questions for a chip -------
// path under mount: /api/admin/chips/:chipId/questions
// GET /api/admin/chips/:chipId/questions
router.get('/:chipId/questions', async (req, res) => {
  const { chipId } = req.params;

  try {
    const result = await pool.query(
      `SELECT question_id,
              question_text,
              points_cost,
              ai_prompt_key,
              sort_order,
              is_default,
              is_active,
              module
         FROM chip_question_template
        WHERE chip_id = $1
        ORDER BY sort_order, question_id`,
      [chipId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching chip questions:', err);
    res.status(500).json({ error: 'Failed to fetch chip questions' });
  }
});

// ------- CREATE single question -------
// POST /:chipId/questions
router.post('/:chipId/questions', async (req, res) => {
  const { chipId } = req.params;
  const {
    question_text,
    points_cost,
    ai_prompt_key,
    sort_order,
    is_default,
    module
  } = req.body;

  if (!question_text) {
    return res.status(400).json({ error: 'question_text is required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO chip_question_template
       (chip_id, question_text, points_cost, ai_prompt_key, sort_order, is_default, module)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        chipId,
        question_text,
        points_cost ?? null,
        ai_prompt_key || null,
        sort_order ?? 0,
        !!is_default,
        module || null
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating question:', err);
    res.status(500).json({ error: 'Failed to create question' });
  }
});

// PUT /:chipId/questions/:questionId
router.put('/:chipId/questions/:questionId', async (req, res) => {
  const { chipId, questionId } = req.params;
  const {
    question_text,
    points_cost,
    ai_prompt_key,
    sort_order,
    is_default,
    module
  } = req.body;

  if (!question_text) {
    return res.status(400).json({ error: 'question_text is required' });
  }

  try {
    const result = await pool.query(
      `UPDATE chip_question_template
          SET question_text = $1,
              points_cost   = $2,
              ai_prompt_key = $3,
              sort_order    = $4,
              is_default    = $5,
              module        = $6,
              updated_at    = NOW()
        WHERE chip_id     = $7
          AND question_id = $8
        RETURNING *`,
      [
        question_text,
        points_cost ?? null,
        ai_prompt_key || null,
        sort_order ?? 0,
        !!is_default,
        module || null,
        chipId,
        questionId
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Question not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating question:', err);
    res.status(500).json({ error: 'Failed to update question' });
  }
});


// ------- UPDATE question -------
// path: PUT /api/admin/chips/:chipId/questions/:questionId
router.put('/:chipId/questions/:questionId', async (req, res) => {
  const { chipId, questionId } = req.params;
  const {
    question_text,
    points_cost,
    ai_prompt_key,
    sort_order,
    is_default
  } = req.body;

  if (!question_text) {
    return res.status(400).json({ error: 'question_text is required' });
  }

  try {
    const result = await pool.query(
      `UPDATE chip_question_template
          SET question_text = $1,
              points_cost   = $2,
              ai_prompt_key = $3,
              sort_order    = $4,
              is_default    = $5
        WHERE chip_id    = $6
          AND question_id = $7
        RETURNING *`,
      [
        question_text,
        points_cost ?? null,
        ai_prompt_key || null,
        sort_order ?? 0,
        !!is_default,
        chipId,
        questionId
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Question not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating question:', err);
    res.status(500).json({ error: 'Failed to update question' });
  }
});

// ------- DELETE question -------
// path: DELETE /api/admin/chips/:chipId/questions/:questionId
router.delete('/:chipId/questions/:questionId', async (req, res) => {
  const { chipId, questionId } = req.params;

  try {
    const result = await pool.query(
      `DELETE FROM chip_question_template
        WHERE chip_id = $1
          AND question_id = $2
        RETURNING *`,
      [chipId, questionId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Question not found' });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Error deleting question:', err);
    res.status(500).json({ error: 'Failed to delete question' });
  }
});

// ------- BULK upload questions (from CSV/JSON) -------
// path: POST /api/admin/chips/:chipId/questions/bulk
router.post('/:chipId/questions/bulk', async (req, res) => {
  const { chipId } = req.params;
  const { questions } = req.body;

  if (!Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'questions array is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const inserted = [];

    for (const q of questions) {
      if (!q.question_text) continue;

    // inside for (const q of questions)
const resInsert = await client.query(
  `INSERT INTO chip_question_template
   (chip_id, question_text, points_cost, ai_prompt_key, sort_order, is_default, module)
   VALUES ($1,$2,$3,$4,$5,$6,$7)
   RETURNING *`,
  [
    chipId,
    q.question_text,
    q.points_cost ?? null,
    q.ai_prompt_key || null,
    q.sort_order ?? 0,
    !!q.is_default,
    q.module || null
  ]
);

      inserted.push(resInsert.rows[0]);
    }

    await client.query('COMMIT');
    res.status(201).json({ insertedCount: inserted.length, items: inserted });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error in bulk questions upload:', err);
    res.status(500).json({ error: 'Failed to bulk insert questions' });
  } finally {
    client.release();
  }
});

export default router;
