// routes/admin.apiCalls.route.js
import express from 'express';
import { query } from '../src/db.js';

const router = express.Router();

/**
 * GET /api/admin/api-calls
 * Optional query params:
 *   from, to (ISO date), providerId, featureId, callChannel, ok, originTag
 */
router.get('/api-calls', async (req, res) => {
  try {
    const {
      from,
      to,
      providerId,
      featureId,
      callChannel,
      ok,
      originTag
    } = req.query;

    const clauses = [];
    const vals = [];
    let i = 1;

    if (from) {
      clauses.push(`started_at >= $${i++}`);
      vals.push(from);
    }
    if (to) {
      clauses.push(`started_at <= $${i++}`);
      vals.push(to);
    }
    if (providerId) {
      clauses.push(`provider_id = $${i++}`);
      vals.push(providerId);
    }
    if (featureId) {
      clauses.push(`feature_id = $${i++}`);
      vals.push(featureId);
    }
    if (callChannel) {
      clauses.push(`call_channel = $${i++}`);
      vals.push(callChannel);
    }
    if (ok === 'true' || ok === 'false') {
      clauses.push(`ok = $${i++}`);
      vals.push(ok === 'true');
    }
    if (originTag) {
      clauses.push(`origin_tag = $${i++}`);
      vals.push(originTag);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const sql = `
      SELECT
        id,
        provider_id,
        provider_name,
        feature_id,
        chat_scope_id,
        audience_scope,
        external_endpoint,
        http_method,
        status_code,
        ok,
        started_at,
        finished_at,
        duration_ms,
        error_text,
        created_at,
        request_source,
        request_for,
        request_length,
        response_length,
        call_channel,
        origin_tag
      FROM astro_api_call_log
      ${where}
      ORDER BY started_at DESC
      LIMIT 500;
    `;

    const { rows } = await query(sql, vals);
    res.json(rows);
  } catch (e) {
    console.error('[API-CALLS] error', e);
    res.status(500).json({ error: e.message });
  }
});

export default router;
