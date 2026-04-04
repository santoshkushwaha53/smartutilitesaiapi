// routes/misc-settings/misc-settings.routes.js
import express from 'express';
import { query } from '../../src/db.js';
import { requireAuth } from '../../src/middleware/auth.js';

const router = express.Router();

/* =========================================================
   PUBLIC: MANIFEST (no auth)
   GET /api/misc-settings/manifest
   ========================================================= */
router.get('/manifest', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT version, updated_at
         FROM public.app_settings_meta
        WHERE meta_key = 'misc_settings'`
    );

    return res.json({
      ok: true,
      version: rows?.[0]?.version ?? 1,
      updated_at: rows?.[0]?.updated_at ?? new Date().toISOString(),
    });
  } catch (e) {
    console.error('manifest error:', e);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

/* =========================================================
   PUBLIC: SYNC (no auth, global + country only)
   GET /api/misc-settings/sync
   ========================================================= */
router.get('/sync', async (req, res) => {
  try {
    const country = req.query.country
      ? String(req.query.country).trim().toUpperCase()
      : null;

    const sinceVersion = req.query.sinceVersion
      ? Number(req.query.sinceVersion)
      : 0;

    const meta = await query(
      `SELECT version, updated_at
         FROM public.app_settings_meta
        WHERE meta_key = 'misc_settings'`
    );

    const currentVersion = meta.rows?.[0]?.version ?? 1;
    const metaUpdatedAt = meta.rows?.[0]?.updated_at ?? new Date().toISOString();

    if (sinceVersion && sinceVersion >= currentVersion) {
      return res.json({
        ok: true,
        version: currentVersion,
        updated_at: metaUpdatedAt,
        changes: [],
      });
    }

    const sql = `
      WITH candidates AS (
        SELECT
          s.*,
          CASE
            WHEN $1::text IS NOT NULL
                 AND s.scope_type = 'country'
                 AND COALESCE(s.scope_id,'') = $1::text THEN 1
            WHEN s.scope_type = 'global' THEN 2
            ELSE 9
          END AS precedence
        FROM public.app_misc_settings s
        WHERE
          s.is_enabled = TRUE
          AND (s.valid_from IS NULL OR s.valid_from <= now())
          AND (s.valid_to   IS NULL OR s.valid_to   >= now())
          AND s.scope_type IN ('global','country')
      )
      SELECT DISTINCT ON (setting_key)
        setting_key,
        value_type,
        value,
        version AS row_version,
        updated_at
      FROM candidates
      ORDER BY setting_key, precedence ASC, updated_at DESC, setting_id DESC;
    `;

    const { rows } = await query(sql, [country]);

    const changes = rows.map(r => ({
      key: r.setting_key,
      type: r.value_type,
      value: r.value,
      row_version: r.row_version,
      updated_at: r.updated_at,
    }));

    return res.json({
      ok: true,
      version: currentVersion,
      updated_at: metaUpdatedAt,
      changes,
    });
  } catch (e) {
    console.error('sync error:', e);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

/* =========================================================
   SECURE: DOWNLOAD (auth required)
   GET /api/misc-settings/download
   ========================================================= */
router.get('/download', requireAuth, async (req, res) => {
  try {
    const requesterEmail = (req.user?.email || '').trim().toLowerCase();
    const requesterRole = String(req.user?.role || 'user').toLowerCase();
    const isAdmin = requesterRole === 'admin';

    const scopeType = req.query.scopeType ? String(req.query.scopeType).trim() : null;
    const scopeIdRaw = req.query.scopeId ? String(req.query.scopeId).trim() : null;
    const scopeId = scopeIdRaw ? scopeIdRaw.toLowerCase() : null;

    const country = req.query.country
      ? String(req.query.country).trim().toUpperCase()
      : null;

    const includeDisabledReq = String(req.query.includeDisabled || '0') === '1';
    const downloadReq = String(req.query.download || '0') === '1';

    const includeDisabled = isAdmin ? includeDisabledReq : false;
    const download = isAdmin ? downloadReq : false;

    if (includeDisabledReq && !isAdmin) {
      return res.status(403).json({ ok: false, error: 'forbidden_include_disabled' });
    }
    if (downloadReq && !isAdmin) {
      return res.status(403).json({ ok: false, error: 'forbidden_download' });
    }

    if (scopeType === 'user') {
      if (!scopeId) {
        return res.status(400).json({ ok: false, error: 'scopeId_required_for_user_scope' });
      }
      const isSelf = requesterEmail && scopeId === requesterEmail;
      if (!isAdmin && !isSelf) {
        return res.status(403).json({ ok: false, error: 'forbidden_scope' });
      }
    }

    const keys = req.query.keys
      ? String(req.query.keys).split(',').map(s => s.trim()).filter(Boolean)
      : null;

    const sql = `
      WITH candidates AS (
        SELECT
          s.*,
          CASE
            WHEN $1::text IS NOT NULL AND $2::text IS NOT NULL
                 AND s.scope_type = $1::text
                 AND COALESCE(s.scope_id,'') = $2::text THEN 1
            WHEN $3::text IS NOT NULL
                 AND s.scope_type = 'country'
                 AND COALESCE(s.scope_id,'') = $3::text THEN 2
            WHEN s.scope_type = 'global' THEN 3
            ELSE 9
          END AS precedence
        FROM public.app_misc_settings s
        WHERE
          (${includeDisabled ? 'TRUE' : 's.is_enabled = TRUE'})
          AND (s.valid_from IS NULL OR s.valid_from <= now())
          AND (s.valid_to   IS NULL OR s.valid_to   >= now())
          AND (
            $4::text[] IS NULL
            OR s.setting_key = ANY($4::text[])
          )
      )
      SELECT DISTINCT ON (setting_key)
        setting_key,
        scope_type,
        scope_id,
        value_type,
        value,
        title,
        description,
        is_enabled,
        valid_from,
        valid_to,
        version,
        created_at,
        updated_at
      FROM candidates
      ORDER BY setting_key, precedence ASC, updated_at DESC, setting_id DESC;
    `;

    const params = [
      scopeType,
      scopeId || '',
      country,
      keys && keys.length ? keys : null,
    ];

    const { rows } = await query(sql, params);

    const values = {};
    for (const r of rows) values[r.setting_key] = r.value;

    const payload = {
      ok: true,
      count: rows.length,
      settings: rows,
      values,
    };

    if (download) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="app_misc_settings_${Date.now()}.json"`
      );
      return res.send(JSON.stringify(payload, null, 2));
    }

    return res.json(payload);
  } catch (err) {
    console.error('misc-settings/download error:', err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

export default router;
