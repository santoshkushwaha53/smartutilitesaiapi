// routes/.../settings.routes.js (your file)

import express from 'express';
import { query } from '../../src/db.js';
import { requireAuth } from '../../src/middleware/auth.js'; // <-- use your middleware

const router = express.Router();

/* =========================
   Validation helpers
   ========================= */
const ALLOWED_LANG = new Set(['en', 'hi', 'es', 'fr', 'de']);
const ALLOWED_THEME = new Set(['cosmic', 'dark', 'light', 'auto']);
const ALLOWED_BC = new Set(['western', 'vedic']);

function isObj(x) {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

function normalizeRow(r) {
  return {
    userId: r.user_id,
    language: r.language ?? null,
    theme: r.theme ?? null,
    birthChart: r.birth_chart ?? null,
    notifications: r.notification_prefs ?? null,
    version: r.version ?? null,
    updatedAt: r.updated_at ?? null,
  };
}

function validatePatch(patch) {
  const errors = [];
  if (!isObj(patch)) return { ok: false, errors: ['patch must be an object'] };

  if (patch.language !== undefined) {
    if (typeof patch.language !== 'string' || !ALLOWED_LANG.has(patch.language)) {
      errors.push(`language must be one of: ${Array.from(ALLOWED_LANG).join(', ')}`);
    }
  }

  if (patch.theme !== undefined) {
    if (typeof patch.theme !== 'string' || !ALLOWED_THEME.has(patch.theme)) {
      errors.push(`theme must be one of: ${Array.from(ALLOWED_THEME).join(', ')}`);
    }
  }

  if (patch.birthChart !== undefined) {
    if (typeof patch.birthChart !== 'string' || !ALLOWED_BC.has(patch.birthChart)) {
      errors.push(`birthChart must be one of: ${Array.from(ALLOWED_BC).join(', ')}`);
    }
  }

  if (patch.notifications !== undefined) {
    if (!isObj(patch.notifications)) {
      errors.push('notifications must be an object');
    } else {
      const n = patch.notifications;
      for (const k of ['daily', 'weekly', 'mercury', 'moon', 'transit', 'compatibility']) {
        if (n[k] !== undefined && typeof n[k] !== 'boolean') {
          errors.push(`notifications.${k} must be boolean`);
        }
      }
      if (n.notifyHour !== undefined) {
        const h = Number(n.notifyHour);
        if (!Number.isFinite(h) || h < 0 || h > 23) {
          errors.push('notifications.notifyHour must be 0..23');
        }
      }
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
}

/* =========================
   Ensure row exists
   ========================= */
async function ensureRow(userId) {
  const found = await query(
    `select user_id, language, theme, birth_chart, notification_prefs, version, updated_at
     from public.app_user_settings
     where user_id=$1`,
    [userId]
  );
  if (found.rows.length) return found.rows[0];

  const created = await query(
    `insert into public.app_user_settings (user_id, version, updated_at)
     values ($1, $2, now())
     returning user_id, language, theme, birth_chart, notification_prefs, version, updated_at`,
    [userId, 1]
  );
  return created.rows[0];
}

/* =========================
   ✅ Use requireAuth and read user identity from req.user
   - userId should be EMAIL in your system
   ========================= */
function getUserId(req) {
  // prefer email (stable) then id
  const email = String(req?.user?.email || '').trim().toLowerCase();
  if (email) return email;

  const id = String(req?.user?.id || '').trim();
  return id;
}

/* =========================
   GET /api/me/settings
   ========================= */
router.get('/me/settings', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'invalid_token_payload' });

    const row = await ensureRow(userId);
    return res.json({ ok: true, settings: normalizeRow(row) });
  } catch {
    return res.status(500).json({ ok: false, error: 'settings_get_failed' });
  }
});

/* =========================
   PATCH /api/me/settings
   ========================= */
router.patch('/me/settings', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'invalid_token_payload' });

    const patch = req.body?.patch;
    const clientVersion = Number(req.body?.clientVersion || 0);

    const v = validatePatch(patch);
    if (!v.ok) return res.status(400).json({ ok: false, error: 'invalid_patch', detail: v.errors });

    const current = await ensureRow(userId);
    const serverVersion = Number(current.version || 1);

    if (clientVersion && clientVersion < serverVersion - 50) {
      return res.status(409).json({ ok: false, error: 'version_too_old', serverVersion });
    }

    const sets = [];
    const vals = [];
    let i = 1;

    if (patch.language !== undefined) { sets.push(`language=$${i++}`); vals.push(patch.language); }
    if (patch.theme !== undefined) { sets.push(`theme=$${i++}`); vals.push(patch.theme); }
    if (patch.birthChart !== undefined) { sets.push(`birth_chart=$${i++}`); vals.push(patch.birthChart); }

    if (patch.notifications !== undefined) {
      sets.push(`notification_prefs = coalesce(notification_prefs,'{}'::jsonb) || $${i++}::jsonb`);
      vals.push(JSON.stringify(patch.notifications));
    }

    if (!sets.length) return res.json({ ok: true, settings: normalizeRow(current) });

    sets.push(`version = coalesce(version, 0) + 1`);
    sets.push(`updated_at = now()`);

    vals.push(userId);

    const upd = await query(
      `update public.app_user_settings
       set ${sets.join(', ')}
       where user_id=$${i}
       returning user_id, language, theme, birth_chart, notification_prefs, version, updated_at`,
      vals
    );

    return res.json({ ok: true, settings: normalizeRow(upd.rows[0]) });
  } catch {
    return res.status(500).json({ ok: false, error: 'settings_patch_failed' });
  }
});

export default router;
