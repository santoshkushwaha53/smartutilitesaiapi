// routes/settings.route.js
import express from 'express';
import { getSetting, setSetting, toggleBool, clearSettingsCache } from '../src/settings.js';
import { query } from '../src/db.js';

const router = express.Router();

// GET one setting
router.get('/:namespace/:key', async (req, res) => {
  const { namespace, key } = req.params;
  const val = await getSetting(namespace, key, null);
  res.json({ namespace, key, value: val });
});

// LIST settings (optional filters)
router.get('/', async (req, res) => {
  const { namespace } = req.query;
  const params = [];
  let sql = 'SELECT namespace, key, value, type, updated_at FROM public.app_settings';
  if (namespace) {
    sql += ' WHERE namespace=$1';
    params.push(namespace);
  }
  sql += ' ORDER BY namespace, key';
  const r = await query(sql, params);
  res.json({ settings: r.rows });
});

// UPSERT a setting
router.post('/', async (req, res) => {
  const { namespace = 'global', key, value, type = 'string', value_json = null, updated_by = 'api' } = req.body || {};
  if (!key) return res.status(400).json({ error: 'key is required' });
  const result = await setSetting(namespace, key, { value: String(value ?? ''), type, value_json, updated_by });
  res.json({ ok: true, namespace, key, result });
});

// TOGGLE a boolean setting
router.post('/toggle', async (req, res) => {
  const { namespace = 'global', key } = req.body || {};
  if (!key) return res.status(400).json({ error: 'key is required' });
  const enabled = await toggleBool(namespace, key);
  res.json({ ok: true, namespace, key, enabled });
});

// Clear cache (useful after bulk SQL changes)
router.post('/cache/clear', (_req, res) => {
  clearSettingsCache();
  res.json({ ok: true });
});

export default router;
