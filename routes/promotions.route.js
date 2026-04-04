// API/routes/promotions.route.js
import { Router } from 'express';
import svc from '../src/services/promotions.service.js'; // ← existing
import { query } from '../src/db.js';                    // ← ADD: for email→user lookup
import { z } from 'zod';                                 // ← ADD: basic payload validation

const router = Router();

// Use your real auth middleware if you have one that sets req.user.id
const requireAuth = (req, res, next) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

// ---------- helpers (ADD) ----------
const redeemEmailSchema = z.object({
  code: z.string().min(4, 'Code must be at least 4 characters'),
  email: z.string().email('Valid email required'),
});

async function findUserIdByEmail(email) {
  if (!email) return null;
  // prefer app_userlogin, then fallback to app_user
  const r1 = await query(`SELECT id FROM app_userlogin WHERE lower(email)=lower($1) LIMIT 1`, [email]);
  if (r1.rows?.[0]?.id) return r1.rows[0].id;
  const r2 = await query(`SELECT id FROM app_user WHERE lower(email)=lower($1) LIMIT 1`, [email]);
  return r2.rows?.[0]?.id ?? null;
}

// ---------- existing routes ----------
router.get('/promo/lookup', async (req, res) => {
  try {
    const code = String(req.query.code || '');
    const userId = req.user?.id || null;
    const data = await svc.lookup(code, userId);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Lookup failed' });
  }
});

router.post('/promo/redeem', requireAuth, async (req, res) => {
  try {
    const code = String(req.body.code || '');
    const data = await svc.redeem(req.user.id, code);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Redeem failed' });
  }
});

// ---------- NEW: redeem via email (no auth) ----------
router.post('/promo/redeem-email', async (req, res) => {
  try {
    // If already authenticated, just use existing flow
    if (req.user?.id) {
      const code = String(req.body.code || '');
      const data = await svc.redeem(req.user.id, code);
      return res.json(data);
    }

    const { code, email } = redeemEmailSchema.parse(req.body || {});
    const userId = await findUserIdByEmail(email);
    if (!userId) {
      return res.status(401).json({ ok: false, error: 'Unauthorized', message: 'Login required or provide a valid registered email.' });
    }

    const data = await svc.redeem(userId, String(code || ''));
    return res.json(data);
  } catch (err) {
    if (err?.issues) {
      return res.status(400).json({ ok: false, error: 'Invalid payload', details: err.issues });
    }
    return res.status(400).json({ ok: false, error: err.message || 'Redeem failed' });
  }
});

router.patch('/promo/:id/suspend', requireAuth, async (req, res) => {
  try {
    await svc.suspend(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Suspend failed' });
  }
});

router.patch('/promo-codes/:code/block', requireAuth, async (req, res) => {
  try {
    await svc.blockCode(req.params.code);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Block failed' });
  }
});

export default router;
