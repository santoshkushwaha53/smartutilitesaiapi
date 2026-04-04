// routes/subscriptions.route.js  (drop-in)
import { Router } from 'express';
import subsSvc from '../src/services/subscriptions.service.js';

const router = Router();
console.log('[SUBS] subscriptions.router loaded');

const requireAuth = (req, res, next) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

// Probe: GET /api/subscription/ping  → { ok:true }
router.get('/ping', (_req, res) => res.json({ ok: true }));

// FULL: GET /api/subscription
router.get('/', requireAuth, async (req, res) => {
  try {
    const data = await subsSvc.details(req.user.id);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to fetch subscription' });
  }
});

// SUMMARY: GET /api/subscription/summary
router.get('/summary', requireAuth, async (req, res) => {
  try {
    const data = await subsSvc.details(req.user.id);
    const s = data?.subscription ?? null;
    res.json({
      hasActiveSubscription: !!data?.hasActiveSubscription,
      planType: s?.planType ?? null,
      isFree: s?.isFree ?? null,
      startAt: s?.activeFrom ?? null,
      endAt: s?.activeUntil ?? null,
      daysRemaining: s?.daysRemaining ?? null,
      points: s?.planPoints ?? 0,
      pointsBalance: data?.pointsBalance ?? 0,
      remainingPointsToExpire: data?.remainingPointsToExpire ?? null,
      grantedBy: s?.grantedBy ?? null
    });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to fetch subscription summary' });
  }
});

export default router;
