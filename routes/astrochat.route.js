// routes/astrochat.route.js
import { Router } from 'express';
import { astroChatController } from '../src/controllers/astrochat.controller.js';
import { query } from '../src/db.js';
import {
  buildVedicProfileSummary,
  buildWesternProfileSummary
} from '../src/services/compresss_profile.js';

// 👇 use your central auth middleware
import { requireAuth } from '../src/middleware/auth.js';

const router = Router();

function toYmd(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function toIsoUtc(v) {
  if (!v) return null;
  try {
    return new Date(v).toISOString();
  } catch (e) {
    return null;
  }
}

function resolveSystem(astroInput) {
  return (astroInput?.system || 'western').toString().trim().toLowerCase();
}

/**
 * Attach astroContext from DB to req.body.astroContext
 */
async function attachAstroContext(req, res, next) {
  try {
    console.log(
      '[attachAstroContext] incoming body:',
      JSON.stringify(req.body, null, 2)
    );

    const astroInput = req.body && req.body.astroInput;
    if (!astroInput) {
      console.log(
        '[attachAstroContext] no astroInput in body → skipping enrichment'
      );
      return next();
    }

    console.log('[attachAstroContext] astroInput:', astroInput);

    const system = resolveSystem(astroInput); // normalized
    const purpose = String(astroInput.purpose || 'transit').trim();
    const userTz = String(astroInput.tz || 'UTC').trim();

    const sign = parseInt(String(astroInput.sign || ''), 10);
    if (!Number.isFinite(sign) || sign < 1 || sign > 12) {
      console.log('[attachAstroContext] invalid sign:', astroInput.sign);
      return next();
    }

    const atRaw =
      typeof astroInput.at === 'string' ? astroInput.at.trim() : '';

    const atIso = atRaw && !Number.isNaN(Date.parse(atRaw)) ? atRaw : null;

    console.log('[attachAstroContext] resolved params:', {
      system,
      purpose,
      userTz,
      sign,
      atIso
    });

    const dayRes = await query(
      `
      WITH t AS (
        SELECT COALESCE($1::timestamptz, now()) AS anchor_ts
      )
      SELECT
        (anchor_ts AT TIME ZONE 'UTC')::date::text      AS utc_day,
        (anchor_ts AT TIME ZONE $2)::date::text         AS user_day,
        anchor_ts::text                                 AS anchor_ts
      FROM t
      `,
      [atIso, userTz]
    );

    const row = dayRes.rows && dayRes.rows[0];
    const utcDay = row && row.utc_day;
    const userLocalDay = row && row.user_day;
    const anchorTs = row && row.anchor_ts;

    console.log('[attachAstroContext] dayRes:', {
      utcDay,
      userLocalDay,
      anchorTs
    });

    if (!utcDay) {
      console.log(
        '[attachAstroContext] utcDay is null → aborting enrichment'
      );
      return next();
    }

    const dbRes = await query(
      `SELECT public.astro_get_transit_by_sign_day_relaxed(
         $1::text,     -- system
         $2::int,      -- sign
         $3::date,     -- UTC day
         $4::text,     -- tz anchor
         $5::text      -- purpose
       ) AS data`,
      [system, sign, utcDay, 'UTC', purpose]
    );

    const row2 = dbRes.rows && row2.data ? dbRes.rows[0] : dbRes.rows[0];
    const payload =
      (row2 && row2.data) || {
        meta: {},
        houses: [],
        aspects: [],
        placements: []
      };

    const existingCalculatedAt =
      payload && payload.meta && payload.meta.calculatedAt
        ? payload.meta.calculatedAt
        : null;

    payload.meta = Object.assign({}, payload.meta || {}, {
      system: system,
      purpose: purpose,
      userSignNumber: sign,
      tzAnchor: 'UTC',
      dayUtc: toYmd(utcDay),
      tzUser: userTz,
      dayUserLocal: toYmd(userLocalDay),
      anchorTs: anchorTs || null,
      calculatedAtUtc: toIsoUtc(existingCalculatedAt),
      referenceMode: 'global',
      referenceCoord: payload.meta ? payload.meta.coordStrUsed || null : null
    });

    req.body.astroContext = payload;

    console.log(
      '[attachAstroContext] attached astroContext.meta:',
      payload.meta
    );

    return next();
  } catch (err) {
    console.error('attachAstroContext error', err);
    return next();
  }
}

/**
 * Attach compressed VEDIC natal profile
 * - writes both req.body.vedicProfile and unified req.body.birthProfile
 */
async function attachVedicProfile(req, res, next) {
  try {
    const astroInput = req.body && req.body.astroInput;
    const system = resolveSystem(astroInput);

    if (system !== 'vedic') {
      return next();
    }

    const bodyUser = req.body && req.body.user;
    const authUser = req.user || {};

    // ✅ Prefer authenticated email, fallback to body user.email
    const email =
      (authUser.email || authUser.id || '').toString().trim() ||
      (bodyUser && bodyUser.email
        ? String(bodyUser.email).trim()
        : '');

    if (!email) {
      console.log(
        '[attachVedicProfile] no email (neither req.user.email nor body.user.email) → skipping'
      );
      return next();
    }

    console.log(
      '[attachVedicProfile] loading vedic payload for user:',
      email
    );

    const dbRes = await query(
      `
      SELECT *
      FROM public.vw_vedic_chart_openai_payload
      WHERE user_id = $1
      ORDER BY vedic_raw_id DESC
      LIMIT 1
      `,
      [email]
    );

    if (!dbRes.rows.length) {
      console.log('[attachVedicProfile] no vedic chart found for user');
      return next();
    }

    const row = dbRes.rows[0];
    const summary = buildVedicProfileSummary(row);

    req.body.vedicProfile = summary;

    req.body.birthProfile = {
      system: 'vedic',
      summary
    };

    console.log('[attachVedicProfile] attached birthProfile (vedic):', {
      hasLagna: !!(summary && summary.lagna),
      hasMoon: !!(summary && summary.moon),
      hasSun: !!(summary && summary.sun)
    });

    return next();
  } catch (err) {
    console.error('attachVedicProfile error', err);
    return next();
  }
}

/**
 * Attach compressed WESTERN natal profile
 * - writes both req.body.westernProfile and unified req.body.birthProfile
 */
async function attachWesternBirthProfile(req, res, next) {
  try {
    const astroInput = req.body && req.body.astroInput;
    const system = resolveSystem(astroInput);

    if (system !== 'western') {
      return next();
    }

    const bodyUser = req.body && req.body.user;
    const authUser = req.user || {};

    // ✅ Prefer authenticated email, fallback to body user.email
    const email =
      (authUser.email || authUser.id || '').toString().trim() ||
      (bodyUser && bodyUser.email
        ? String(bodyUser.email).trim()
        : '');

    if (!email) {
      console.log(
        '[attachWesternBirthProfile] no email (neither req.user.email nor body.user.email) → skipping'
      );
      return next();
    }

    console.log(
      '[attachWesternBirthProfile] loading western birth chart for:',
      email
    );

    const dbRes = await query(
      `
      SELECT planet_raw_output, house_raw_output, aspect_raw_output
      FROM public.astro_birth_chart_raw
      WHERE user_id = $1
      ORDER BY created_at DESC NULLS LAST
      LIMIT 1
      `,
      [email]
    );

    if (!dbRes.rows.length) {
      console.log('[attachWesternBirthProfile] no western birth chart found for user');
      return next();
    }

    const row = dbRes.rows[0];
    const summary = buildWesternProfileSummary(row);

    req.body.westernProfile = summary;

    req.body.birthProfile = {
      system: 'western',
      summary
    };

    console.log('[attachWesternBirthProfile] attached birthProfile (western):', {
      hasAsc: !!(summary && summary.ascendant),
      hasSun: !!(summary && summary.sun),
      hasMoon: !!(summary && summary.moon)
    });

    return next();
  } catch (err) {
    console.error('attachWesternBirthProfile error', err);
    return next();
  }
}

// ------------------------------------
// PROTECTED ROUTE
// ------------------------------------
router.post(
  '/v1/message',
  requireAuth,            // 🔐 MUST have Authorization: Bearer <jwt>
  attachAstroContext,
  attachVedicProfile,
  attachWesternBirthProfile,
  astroChatController.postMessage
);

export default router;
