import { Router } from 'express';
import * as sunCompatController from '../src/controllers/suncompat.controller.js';

const router = Router();

// Health: GET /api/v1/sun-compat/ping
router.get('/ping', (_req, res) => res.json({ ok: true, scope: 'sun-compat' }));

// Pair: GET /api/v1/sun-compat/pair?signA=leo&signB=pisces
router.get('/pair', sunCompatController.getPair);

// Optional alias (only if you still hit /api/v1/sun-compat/sun-compat/pair somewhere)
// router.get('/sun-compat/pair', sunCompatController.getPair);

// Matrix (optional): GET /api/v1/sun-compat/matrix/:slug
router.get('/matrix/:slug', sunCompatController.getMatrixForSlug);

export default router;
