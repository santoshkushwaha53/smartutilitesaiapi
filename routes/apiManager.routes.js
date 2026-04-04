import { Router } from 'express';
import { getApiConfig, postApiConfig } from '../src/controllers/apiManager.controller.js';

const router = Router();

router.get('/ping', (_req, res) => {
  res.json({ ok: true, scope: 'api-manager', ts: Date.now() });
});

router.get('/api-config', getApiConfig);
router.post('/api-config', postApiConfig);

export default router;
