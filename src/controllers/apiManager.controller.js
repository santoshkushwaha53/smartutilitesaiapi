// src/controllers/apiManager.controller.js
import { loadApiConfig, saveApiConfig } from '../services/apiManager.service.js';

export async function getApiConfig(_req, res) {
  try {
    const result = await loadApiConfig();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[API-MANAGER] getApiConfig error', err);
    res.status(500).json({ ok: false, error: 'Failed to load API config' });
  }
}

export async function postApiConfig(req, res) {
  try {
    const { apis } = req.body || {};
    await saveApiConfig(apis);
    res.json({ ok: true });
  } catch (err) {
    console.error('[API-MANAGER] postApiConfig error', err);

    // If DB still throws the unique-constraint error, send clearer message
    const msg = (err?.message || '').toLowerCase();

    if (msg.includes('ux_api_default_predictions')) {
      return res.status(400).json({
        ok: false,
        error:
          'Only one API can be default for predictions. Please ensure exactly one is marked as default for predictions.',
      });
    }
    if (msg.includes('ux_api_default_raw')) {
      return res.status(400).json({
        ok: false,
        error:
          'Only one API can be default for raw data. Please ensure exactly one is marked as default for raw data.',
      });
    }

    res
      .status(500)
      .json({ ok: false, error: err.message || 'Failed to save API config' });
  }
}
