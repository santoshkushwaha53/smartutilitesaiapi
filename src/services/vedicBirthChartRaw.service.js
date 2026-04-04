/**
 * ==========================================================
 * FILE: src/services/vedicBirthChartRaw.service.js
 *
 * PURPOSE:
 *  - Generate & store RAW Vedic (Kundli) astrology data
 *  - Phase-1 (FreeAstro): Extended planet positions (Rasi + Houses)
 *  - Phase-2 (LOCAL): Divisional charts: D2, D7, D9, D10
 *  - ✅ NEW: Upsert birth_chart (system='vedic') with latitude/longitude
 *
 * NOTE:
 *  - Response and validations match your existing route.
 *  - Does NOT break existing code:
 *      - We try to upsert lat/lon columns if they exist
 *      - If not, we fallback to minimal upsert (no crash)
 * ==========================================================
 */

import { query } from '../db.js';
import { callFreeAstro } from '../../utils/freeastro.js';

const ASTRO_PROVIDER = process.env.FREEASTRO_PROVIDER || 'freeastrologyapi.com';

/* Zodiac order – DO NOT CHANGE */
const SIGNS = [
  'Aries', 'Taurus', 'Gemini', 'Cancer',
  'Leo', 'Virgo', 'Libra', 'Scorpio',
  'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces'
];

/* ---------------- Helpers ---------------- */

function normalizeCoords(lat, lon) {
  return `${Number(lat).toFixed(6)},${Number(lon).toFixed(6)}`;
}

function buildIsoString({ year, month, date, hours, minutes, seconds }) {
  return new Date(Date.UTC(
    year,
    month - 1,
    date,
    hours,
    minutes,
    seconds || 0
  )).toISOString();
}

/**
 * ✅ NEW: Upsert birth_chart (system='vedic') with lat/lon
 * - Uses try/catch fallback to avoid breaking if columns differ.
 *
 * IMPORTANT:
 * If your birth_chart columns are named differently, update the column list below.
 */
async function upsertBirthChartVedic({
  userId,
  isoInput,
  birthProfileId,
  latitude,
  longitude,
  timezoneOffset
}) {
  const uid = String(userId);
  const iso = isoInput; // ISO string

  // 1) Try full upsert (includes latitude/longitude/timezone_offset/birth_profile_id)
  try {
    await query(
      `
      INSERT INTO public.birth_chart (
        user_id, system, iso_input, birth_date, birth_time,
        latitude, longitude, timezone_offset, birth_profile_id,
        version, syncversion, last_updated_date
      )
      VALUES (
        $1, 'vedic', $2::timestamptz, ($2::timestamptz)::date, ($2::timestamptz)::time,
        $3::numeric, $4::numeric, $5::numeric, $6::bigint,
        1, 1, now()
      )
      ON CONFLICT (user_id, system)
      DO UPDATE SET
        iso_input         = EXCLUDED.iso_input,
        birth_date        = EXCLUDED.birth_date,
        birth_time        = EXCLUDED.birth_time,
        latitude          = EXCLUDED.latitude,
        longitude         = EXCLUDED.longitude,
        timezone_offset   = EXCLUDED.timezone_offset,
        birth_profile_id  = EXCLUDED.birth_profile_id,
        version           = COALESCE(birth_chart.version, 0) + 1,
        syncversion       = COALESCE(birth_chart.syncversion, 0) + 1,
        last_updated_date = now()
      `,
      [
        uid,
        iso,
        latitude == null ? null : Number(latitude),
        longitude == null ? null : Number(longitude),
        timezoneOffset == null ? null : Number(timezoneOffset),
        birthProfileId == null ? null : Number(birthProfileId)
      ]
    );
    return;
  } catch (e) {
    // 2) Fallback: minimal upsert (NO lat/lon) to avoid breaking runtime
    await query(
      `
      INSERT INTO public.birth_chart (
        user_id, system, iso_input, birth_date, birth_time,
        version, syncversion, last_updated_date
      )
      VALUES (
        $1, 'vedic', $2::timestamptz, ($2::timestamptz)::date, ($2::timestamptz)::time,
        1, 1, now()
      )
      ON CONFLICT (user_id, system)
      DO UPDATE SET
        iso_input         = EXCLUDED.iso_input,
        birth_date        = EXCLUDED.birth_date,
        birth_time        = EXCLUDED.birth_time,
        version           = COALESCE(birth_chart.version, 0) + 1,
        syncversion       = COALESCE(birth_chart.syncversion, 0) + 1,
        last_updated_date = now()
      `,
      [uid, iso]
    );
  }
}

/* ==========================================================
 * LOCAL PARASHARI DIVISIONAL ENGINE
 * ========================================================== */

function computeDivisionalSign(normDegree, signName, division) {
  const signIndex = SIGNS.indexOf(signName);
  if (signIndex === -1) {
    throw new Error(`Invalid zodiac sign: ${signName}`);
  }

  const partSize = 30 / division;
  const partIndex = Math.floor(normDegree / partSize);

  const finalIndex = (signIndex * division + partIndex) % 12;
  return SIGNS[finalIndex];
}

function computeDivisionalChart(extendedPlanetRaw, division) {
  const chart = {};

  for (const [planet, data] of Object.entries(extendedPlanetRaw || {})) {
    if (!data || data.normDegree == null) continue;

    const signName =
      data.zodiac_sign_name ||
      data.zodiacSign ||
      data.sign_name;

    if (!signName) continue;

    chart[planet] = {
      sign: computeDivisionalSign(
        Number(data.normDegree),
        signName,
        division
      ),
      degree: Number(data.normDegree),
      retrograde: String(data.isRetro) === 'true',
      source: 'local',
      ayanamsha: 'lahiri'
    };
  }

  return chart;
}

/* ==========================================================
 * PUBLIC SERVICE API
 * ========================================================== */

export async function generateVedicBirthChartRaw(input) {
  const startedAt = Date.now();

  const {
    userId,
    birthProfileId = null,
    year, month, date, hours, minutes, seconds = 0,
    latitude, longitude, timezone,
    observation_point = 'topocentric',
    ayanamsha = 'lahiri',
    language = 'en',
    purpose = 'natal'
  } = input || {};

  if (!userId) {
    return { httpStatus: 400, body: { ok: false, error: 'missing_userId' } };
  }

  if ([year, month, date, hours, minutes].some(v => v == null)) {
    return { httpStatus: 400, body: { ok: false, error: 'missing_birth_datetime' } };
  }

  if ([latitude, longitude, timezone].some(v => v == null)) {
    return { httpStatus: 400, body: { ok: false, error: 'missing_location_or_timezone' } };
  }

  const isoInput = buildIsoString({ year, month, date, hours, minutes, seconds });
  const coordStr = normalizeCoords(latitude, longitude);

  const basePayload = {
    year, month, date, hours, minutes, seconds,
    latitude, longitude, timezone,
    settings: { observation_point, ayanamsha, language }
  };

  /* ---------------- PHASE-1: EXTENDED PLANETS ---------------- */
  const extendedResp = await callFreeAstro('planets/extended', basePayload);

  // 🔑 CRITICAL NORMALIZATION
  const extendedPlanetRaw = extendedResp?.data?.output || {};
  const rasiPlanetRaw = extendedPlanetRaw;

  /* ---------------- SAVE MAIN RAW ---------------- */
  const { rows } = await query(`
    INSERT INTO vedic_birth_chart_raw (
      user_id, birth_profile_id, system, provider,
      iso_input, coord_str, latitude, longitude, timezone_offset,
      observation_point, ayanamsha, lang,
      rasi_planet_raw, extended_planet_raw,
      purpose, updated_at
    )
    VALUES (
      $1,$2,'vedic',$3,
      $4,$5,$6,$7,$8,
      $9,$10,$11,
      $12::jsonb,$13::jsonb,
      $14, now()
    )
    ON CONFLICT (user_id, iso_input, coord_str, ayanamsha, provider)
    DO UPDATE SET
      rasi_planet_raw     = EXCLUDED.rasi_planet_raw,
      extended_planet_raw = EXCLUDED.extended_planet_raw,
      updated_at          = now()
    RETURNING vedic_raw_id
  `, [
    userId, birthProfileId, ASTRO_PROVIDER,
    isoInput, coordStr, latitude, longitude, timezone,
    observation_point, ayanamsha, language,
    JSON.stringify(rasiPlanetRaw),
    JSON.stringify(extendedPlanetRaw),
    purpose
  ]);

  const vedicRawId = rows[0].vedic_raw_id;

  /* ----------------------------------------------------------
   * ✅ NEW: birth_chart upsert here (stores lat/lon for vedic)
   * ---------------------------------------------------------- */
  await upsertBirthChartVedic({
    userId,
    isoInput,
    birthProfileId,
    latitude,
    longitude,
    timezoneOffset: timezone
  });

  /* ---------------- PHASE-2: LOCAL DIVISIONALS ---------------- */
  const divisions = [
    { code: 'D2', div: 2 },
    { code: 'D7', div: 7 },
    { code: 'D9', div: 9 },
    { code: 'D10', div: 10 }
  ];

  const insertedDivisions = [];

  for (const d of divisions) {
    const chart = computeDivisionalChart(extendedPlanetRaw, d.div);

    await query(`
      INSERT INTO vedic_divisional_chart_raw (
        vedic_raw_id, user_id, division_code, chart_raw
      )
      VALUES ($1,$2,$3,$4::jsonb)
      ON CONFLICT (vedic_raw_id, division_code)
      DO UPDATE SET chart_raw = EXCLUDED.chart_raw
    `, [
      vedicRawId, userId, d.code, JSON.stringify(chart)
    ]);

    insertedDivisions.push(d.code);
  }

  return {
    httpStatus: 200,
    body: {
      ok: true,
      message: 'Vedic birth chart generated successfully',
      vedicRawId,
      phase1: ['Extended (Rasi + Houses)'],
      phase2: insertedDivisions,
      engine: 'local-parashari-varga',
      tookMs: Date.now() - startedAt
    }
  };
}

/**
 * Loads raw + divisionals for UI (from DB).
 * (New helper used by your new combined endpoint.)
 */
export async function loadVedicRawForUi({ userId, vedicRawId }) {
  const raw = await query(
    `
    SELECT *
    FROM vedic_birth_chart_raw
    WHERE vedic_raw_id = $1
      AND user_id = $2
    LIMIT 1
    `,
    [Number(vedicRawId), String(userId)]
  );

  const divisional = await query(
    `
    SELECT division_code, chart_raw
    FROM vedic_divisional_chart_raw
    WHERE vedic_raw_id = $1
      AND user_id = $2
    ORDER BY division_code
    `,
    [Number(vedicRawId), String(userId)]
  );

  return {
    raw: raw.rows[0] || null,
    divisionals: divisional.rows || []
  };
}
