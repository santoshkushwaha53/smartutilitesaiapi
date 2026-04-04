import express from 'express';
import { query } from '../src/db.js';
import { estimateCostUSD } from '../utils/pricing.js';

const router = express.Router();

router.post('/prediction/recompute-costs', async (_req, res) => {
  try {
    const r = await query(`SELECT id, model_name, prompt_tokens, completion_tokens
                           FROM astro_prediction
                           WHERE cost_usd IS NULL`);
    let updated = 0;
    for (const row of r.rows) {
      const cost = estimateCostUSD(row.model_name, {
        input_tokens: row.prompt_tokens || 0,
        output_tokens: row.completion_tokens || 0
      });
      if (cost != null) {
        await query('UPDATE astro_prediction SET cost_usd=$1 WHERE id=$2', [cost, row.id]);
        updated++;
      }
    }
    res.json({ updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
