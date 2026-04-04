import { Router } from 'express';
import pointsSvc from '../src/services/points.service.js';

const router = Router();
const requireAuth = (req, res, next) => (req.user?.id ? next() : res.status(401).json({ error: 'Unauthorized' }));

router.get('/points/ping', (_req, res) => res.json({ ok: true, now: new Date().toISOString() }));

router.get('/points/balance', requireAuth, async (req, res) => {
  try { res.json(await pointsSvc.balance(req.user.id)); }
  catch (e) { res.status(400).json({ ok: false, error: e.message || 'Failed' }); }
});

router.get('/points/history', requireAuth, async (req, res) => {
  try {
    const limit = Number(req.query.limit ?? 50);
    const data = await pointsSvc.history(req.user.id, isFinite(limit) ? limit : 50);
    res.json({ ok: true, items: data });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || 'Failed' });
  }
});

router.post('/points/credit', requireAuth, async (req, res) => {
  try {
    const amount = Number(req.body?.amount);
    const reason = String(req.body?.reason ?? 'manual');
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ ok: false, error: 'Invalid amount' });
    const data = await pointsSvc.credit(req.user.id, amount, reason);
    res.json(data);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || 'Credit failed' });
  }
});

router.post('/points/spend', requireAuth, async (req, res) => {
  try {
    const cost = Number(req.body?.cost);
    const reason = String(req.body?.reason ?? 'generic');
    const location = req.body?.location ?? null;
    const question = req.body?.question ?? null;   // ← read it
    const clientTs = req.body?.clientTs ?? null;
    const requestId = req.body?.requestId ?? null;
    if (!Number.isFinite(cost) || cost <= 0) return res.status(400).json({ ok: false, error: 'Invalid cost' });

    const data = await pointsSvc.spend(req.user.id, cost, reason, { location, question, clientTs, requestId });
    res.json(data);
  } catch (e) {
    const msg = e?.message || 'Spend failed';
    if (msg.includes('INSUFFICIENT')) return res.status(402).json({ ok: false, error: 'INSUFFICIENT', message: 'Not enough points' });
    res.status(400).json({ ok: false, error: msg });
  }
});

export default router;