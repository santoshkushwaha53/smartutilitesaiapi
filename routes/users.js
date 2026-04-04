// routes/users.js
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../src/db.js';

const router = Router();

// Simple ping
router.get('/ping', (_req, res) => {
  res.json({ ok: true, scope: 'user' });
});

/**
 * Schema for profile upsert (NO password)
 * Accepts:
 *  - date_of_birth: YYYY-MM-DD or full datetime (no timezone)
 *  - country, birth_place
 */
const userDetailsSchema = z.object({
  email: z.string().email(),
  first_name: z.string().min(1),
  last_name: z.string().optional().nullable(),

  // keep your existing rule
  date_of_birth: z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?)?$/,
      'Use YYYY-MM-DD or YYYY-MM-DD HH:MM[:SS[.mmm]]'
    )
    .optional()
    .nullable(),

  gender: z.string().optional().nullable(),
  relationship: z.string().optional().nullable(),
  zodiac_sign: z.string().optional().nullable(),

  country: z.string().min(2).max(64).optional().nullable(),
  birth_place: z.string().min(1).max(128).optional().nullable(),

  // ✅ NEW: birth_profile fields
  birth_time: z
    .string()
    .regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Use HH:MM or HH:MM:SS')
    .optional()
    .nullable(),

  // if client might send them as strings, use z.coerce.number()
  latitude: z.coerce.number().optional().nullable(),
  longitude: z.coerce.number().optional().nullable(),
  timezone: z.coerce.number().optional().nullable(), // e.g. 5.5
  system: z.enum(['western', 'vedic']).optional().nullable(),
});


/** Normalize DoB so PG can cast to TIMESTAMP (no TZ) */
function normalizeDob(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; // date only -> midnight
  return s; // full datetime (space or 'T'), no timezone
}

/**
 * POST /api/user/details
 * Upsert user info (insert if not exists by email, else update).
 */
router.post('/details', async (req, res) => {
  try {
    const body = userDetailsSchema.parse(req.body);

    const email = body.email.trim().toLowerCase();
    const first = body.first_name.trim();
    const last = body.last_name?.trim() || null;

    // app_user dob (your existing logic)
    const dobTs = normalizeDob(body.date_of_birth ?? null); // string or null (timestamp-like)
    const dobDateOnly = dobTs ? dobTs.slice(0, 10) : null;  // for birth_profile.birth_date (DATE)

    const gender = body.gender ?? null;
    const relationship = body.relationship ?? null;
    const zodiac = body.zodiac_sign ?? null;

    const country = body.country?.trim() || null;
    const birthPlace = body.birth_place?.trim() || null;

    // ✅ optional fields for birth_profile
    // birth_time: "10:30" OR "10:30:00"
    // latitude/longitude: numeric
    // timezone: numeric (hours offset like 5.5) stored in birth_profile.timezone_offset
    const birthTime = body.birth_time ? String(body.birth_time).trim() : null;
    const latitude = body.latitude ?? null;
    const longitude = body.longitude ?? null;
    const tz = body.timezone ?? null;
    const system = body.system ? String(body.system).trim() : 'western';

    // Check existence for nicer response code
    const { rows: pre } = await query(`SELECT id FROM app_user WHERE email = $1`, [email]);
    const existed = pre?.length > 0;

    // Preferred path: DB function expects TIMESTAMP (without time zone)
    const sqlTimestamp = `
      SELECT fn_upsert_app_user_info(
        $1::citext,    -- email
        $2::text,      -- first_name
        $3::text,      -- last_name
        $4::timestamp, -- date_of_birth (no tz)
        $5::text,      -- gender
        $6::text,      -- relationship
        $7::text       -- zodiac_sign
      ) AS id
    `;
    const paramsTs = [email, first, last, dobTs, gender, relationship, zodiac];

    // Legacy fallback: function expects DATE
    const sqlDate = `
      SELECT fn_upsert_app_user_info(
        $1::citext,
        $2::text,
        $3::text,
        $4::date,
        $5::text,
        $6::text,
        $7::text
      ) AS id
    `;
    const paramsDate = [
      email,
      first,
      last,
      dobDateOnly,
      gender,
      relationship,
      zodiac,
    ];

    let userId;
    try {
      const { rows } = await query(sqlTimestamp, paramsTs);
      userId = rows?.[0]?.id;
    } catch {
      const { rows } = await query(sqlDate, paramsDate);
      userId = rows?.[0]?.id;
    }

    // If SP doesn’t take country/birth_place yet, patch row here.
    if (country !== null || birthPlace !== null) {
      await query(
        `
        UPDATE app_user
           SET country     = COALESCE($2, country),
               birth_place = COALESCE($3, birth_place),
               updated_at  = now()
         WHERE email = $1
        `,
        [email, country, birthPlace]
      );
    }

    // ✅ NEW: upsert birth_profile (insert if not exists else update) by email
    // - Prefer UPSERT with ON CONFLICT(email) if you have UNIQUE(email)
    // - Fallback to UPDATE-then-INSERT if unique constraint not present
    let birthProfileId = null;

    try {
      const userIdBigint =
        typeof userId === 'number'
          ? userId
          : (typeof userId === 'string' && /^\d+$/.test(userId) ? Number(userId) : null);

      // Normalize birth_time -> "HH:MM:SS" for Postgres TIME
      const birthTimeSql =
        birthTime
          ? (birthTime.length === 5 ? `${birthTime}:00` : birthTime) // "10:30" -> "10:30:00"
          : null;

      // 1) Preferred UPSERT path (requires UNIQUE(email) on public.birth_profile)
      try {
        const { rows: bp } = await query(
          `
          INSERT INTO public.birth_profile
            (email, user_id, birth_date, birth_time, latitude, longitude, timezone_offset, system, country)
          VALUES
            ($1::text, $2::bigint, $3::date, $4::time, $5::numeric, $6::numeric, $7::numeric, $8::text, $9::text)
          ON CONFLICT (email)
          DO UPDATE SET
            user_id         = COALESCE(EXCLUDED.user_id, public.birth_profile.user_id),
            birth_date      = COALESCE(EXCLUDED.birth_date, public.birth_profile.birth_date),
            birth_time      = COALESCE(EXCLUDED.birth_time, public.birth_profile.birth_time),
            latitude        = COALESCE(EXCLUDED.latitude, public.birth_profile.latitude),
            longitude       = COALESCE(EXCLUDED.longitude, public.birth_profile.longitude),
            timezone_offset = COALESCE(EXCLUDED.timezone_offset, public.birth_profile.timezone_offset),
            system          = COALESCE(EXCLUDED.system, public.birth_profile.system),
            country         = COALESCE(EXCLUDED.country, public.birth_profile.country)
          RETURNING profile_id
          `,
          [
            email,
            userIdBigint,
            dobDateOnly,
            birthTimeSql,
            latitude,
            longitude,
            tz,                 // maps to timezone_offset
            system || 'western',
            country
          ]
        );

        birthProfileId = bp?.[0]?.profile_id ?? null;
      } catch (e) {
        // 2) Fallback if UNIQUE(email) is not present:
        // UPDATE first; if no row updated then INSERT.
        const upd = await query(
          `
          UPDATE public.birth_profile
             SET user_id         = COALESCE($2::bigint, user_id),
                 birth_date      = COALESCE($3::date, birth_date),
                 birth_time      = COALESCE($4::time, birth_time),
                 latitude        = COALESCE($5::numeric, latitude),
                 longitude       = COALESCE($6::numeric, longitude),
                 timezone_offset = COALESCE($7::numeric, timezone_offset),
                 system          = COALESCE($8::text, system),
                 country         = COALESCE($9::text, country)
           WHERE email = $1::text
           RETURNING profile_id
          `,
          [
            email,
            userIdBigint,
            dobDateOnly,
            birthTimeSql,
            latitude,
            longitude,
            tz,
            system || 'western',
            country
          ]
        );

        if (upd.rows?.length) {
          birthProfileId = upd.rows[0].profile_id;
        } else {
          const ins = await query(
            `
            INSERT INTO public.birth_profile
              (email, user_id, birth_date, birth_time, latitude, longitude, timezone_offset, system, country)
            VALUES
              ($1::text, $2::bigint, $3::date, $4::time, $5::numeric, $6::numeric, $7::numeric, $8::text, $9::text)
            RETURNING profile_id
            `,
            [
              email,
              userIdBigint,
              dobDateOnly,
              birthTimeSql,
              latitude,
              longitude,
              tz,
              system || 'western',
              country
            ]
          );

          birthProfileId = ins.rows?.[0]?.profile_id ?? null;
        }
      }
    } catch (e) {
      console.warn('birth_profile upsert skipped:', e?.message || e);
      // do not break old flow
    }

    return res.status(existed ? 200 : 201).json({
      ok: true,
      id: userId,
      birth_profile_id: birthProfileId,
      action: existed ? 'update' : 'insert',
    });
  } catch (err) {
    if (err?.issues) {
      return res.status(400).json({ ok: false, error: 'Invalid payload', details: err.issues });
    }
    console.error('user/details error:', err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});



/**
 * GET /api/user/details?email=...
 */
router.get('/details', async (req, res) => {
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ ok: false, error: 'email is required' });

    const { rows } = await query(
      `
     SELECT
  u.id,
  u.email,
  u.first_name,
  u.last_name,
  u.date_of_birth,
  u.gender,
  u.relationship,
  u.zodiac_sign,
  u.country,
  u.birth_place,
  u.created_at,
  u.updated_at,
  u.last_login_at,

  bp.profile_id,
  bp.user_id       AS bp_user_id,
  bp.birth_date,
  bp.birth_time,
  bp.latitude,
  bp.longitude,
  bp.timezone_offset,
  bp.system,
  bp.country       AS bp_country,
  bp.version       AS bp_version,
  bp.update_time   AS bp_update_time

FROM public.app_user u
LEFT JOIN public.birth_profile bp
  ON bp.email = u.email
WHERE u.email = $1;

      `,
      [email]
    );

    if (rows.length === 0) return res.status(404).json({ ok: false, error: 'Not found' });

    return res.json({ ok: true, user: rows[0] });
  } catch (err) {
    console.error('user/details GET error:', err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

export default router;
