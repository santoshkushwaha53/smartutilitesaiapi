// routes/freeastro.route.js
import express from 'express';
import { query } from '../src/db.js';
import {
  buildWesternPlanetsPayload,
  callFreeAstro,
  buildWesternHousesPayload,
  buildWesternAspectsPayload,
} from '../utils/freeastro.js';

const router = express.Router();

console.log('[FreeAstro] router loaded at', new Date().toISOString());

/* ──────────────────────────────────────────────
 * CONFIG: per-day delay for next30 batching (ms)
 * e.g. FREEASTRO_DAY_DELAY_MS=25000
 * ────────────────────────────────────────────── */
const DAY_DELAY_MS = Number(process.env.FREEASTRO_DAY_DELAY_MS || 25_000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ──────────────────────────────────────────────
 * Helpers
 * ────────────────────────────────────────────── */

// If coords missing, fall back to a safe default.
function resolveCoords(coords) {
  if (coords && String(coords).trim().length > 0) {
    return String(coords).trim();
  }
  return process.env.FREEASTRO_DEFAULT_COORDS || '51.4769,-0.0005'; // Greenwich
}

// Extract the trailing timezone offset or "Z"
function extractOffset(iso) {
  const m = String(iso).match(/([+\-]\d{2}:\d{2}|Z)$/);
  return m ? m[1] : 'Z';
}

// Shift an ISO datetime string by N days, preserving offset
function shiftIsoDays(iso, days) {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) {
    throw new Error(`Invalid ISO datetime: ${iso}`);
  }
  dt.setUTCDate(dt.getUTCDate() + days);
  const isoBase = dt.toISOString().replace(/\.\d{3}Z$/, '');
  const offset = extractOffset(iso);
  return offset === 'Z' ? `${isoBase}Z` : `${isoBase}${offset}`;
}

// Shift an ISO datetime string by N months, preserving offset
function shiftIsoMonths(iso, months) {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) {
    throw new Error(`Invalid ISO datetime: ${iso}`);
  }
  dt.setUTCMonth(dt.getUTCMonth() + months);
  const isoBase = dt.toISOString().replace(/\.\d{3}Z$/, '');
  const offset = extractOffset(iso);
  return offset === 'Z' ? `${isoBase}Z` : `${isoBase}${offset}`;
}

// Build ISO dates for every day in the month of baseIso
function buildMonthIsoList(baseIso) {
  const base = new Date(baseIso);
  if (Number.isNaN(base.getTime())) {
    throw new Error(`Invalid baseIso: ${baseIso}`);
  }

  const year = base.getUTCFullYear();
  const month = base.getUTCMonth(); // 0-based

  // Start at 1st of that month, keep same time-of-day as base
  const first = new Date(
    Date.UTC(
      year,
      month,
      1,
      base.getUTCHours(),
      base.getUTCMinutes(),
      base.getUTCSeconds()
    )
  );

  const result = [];
  let cursor = first;

  while (cursor.getUTCMonth() === month) {
    result.push(cursor.toISOString());
    cursor = new Date(cursor);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return result;
}

/* ──────────────────────────────────────────────
 * DB UPSERT HELPERS
 * ────────────────────────────────────────────── */

// PLANETS → astro_planet_raw
async function upsertPlanetRaw({
  system = 'western',
  iso,
  coords,
  payload,
  resultJson,
  provider = 'freeastrologyapi.com',
}) {
  const {
    year,
    month,
    date,
    hours,
    minutes,
    seconds,
    latitude,
    longitude,
    timezone,
    config = {},
  } = payload;

  const statusCode = resultJson?.statusCode ?? null;

  const sql = `
    INSERT INTO astro_planet_raw (
      system,
      iso_input,
      coord_str,
      year, month, day, hour, minute, second,
      latitude, longitude, timezone_offset,
      observation_point, ayanamsha, lang,
      provider,
      status_code,
      raw_output,
      updated_at
    )
    VALUES (
      $1,  -- system
      $2,  -- iso_input
      $3,  -- coord_str
      $4,$5,$6,$7,$8,$9,
      $10,$11,$12,
      $13,$14,$15,
      $16,
      $17,
      $18::jsonb,
      now()
    )
    ON CONFLICT (system, iso_input, coord_str, lang)
    DO UPDATE SET
      status_code       = EXCLUDED.status_code,
      raw_output        = EXCLUDED.raw_output,
      provider          = EXCLUDED.provider,
      observation_point = EXCLUDED.observation_point,
      ayanamsha         = EXCLUDED.ayanamsha,
      timezone_offset   = EXCLUDED.timezone_offset,
      updated_at        = now()
    RETURNING *;
  `;

  const params = [
    system,                 // $1
    iso,                    // $2
    coords,                 // $3
    year,                   // $4
    month,                  // $5
    date,                   // $6  (mapped to column "day")
    hours,                  // $7
    minutes,                // $8
    seconds,                // $9
    latitude,               // $10
    longitude,              // $11
    timezone,               // $12
    config.observation_point || null, // $13
    config.ayanamsha        || null,  // $14
    config.language         || 'en',  // $15
    provider,                            // $16
    statusCode,                          // $17
    JSON.stringify(resultJson || {}),    // $18
  ];

  const { rows } = await query(sql, params);
  console.log('[upsertPlanetRaw] stored row id=', rows[0]?.id, 'iso=', iso);
  return rows[0];
}

// HOUSES → astro_house_raw
async function upsertHouseRaw({
  system = 'western',
  iso,
  coords,
  payload,
  resultJson,
  provider = 'freeastrologyapi.com',
}) {
  const {
    year,
    month,
    date,
    hours,
    minutes,
    seconds,
    latitude,
    longitude,
    timezone,
    config = {},
  } = payload;

  const statusCode = resultJson?.statusCode ?? null;

  const sql = `
    INSERT INTO astro_house_raw (
      system,
      iso_input,
      coord_str,
      year, month, day, hour, minute, second,
      latitude, longitude, timezone_offset,
      observation_point, ayanamsha, house_system, lang,
      provider,
      status_code,
      raw_output,
      updated_at
    )
    VALUES (
      $1,  -- system
      $2,  -- iso_input
      $3,  -- coord_str
      $4,$5,$6,$7,$8,$9,
      $10,$11,$12,
      $13,$14,$15,$16,
      $17,
      $18,
      $19::jsonb,
      now()
    )
    ON CONFLICT (system, iso_input, coord_str, house_system, lang)
    DO UPDATE SET
      status_code   = EXCLUDED.status_code,
      raw_output    = EXCLUDED.raw_output,
      provider      = EXCLUDED.provider,
      updated_at    = now()
    RETURNING *;
  `;

  const params = [
    system,                 // $1
    iso,                    // $2
    coords,                 // $3
    year,                   // $4
    month,                  // $5
    date,                   // $6
    hours,                  // $7
    minutes,                // $8
    seconds,                // $9
    latitude,               // $10
    longitude,              // $11
    timezone,               // $12
    config.observation_point || null,   // $13
    config.ayanamsha         || null,   // $14
    config.house_system      || null,   // $15
    config.language          || 'en',   // $16
    provider,                            // $17
    statusCode,                          // $18
    JSON.stringify(resultJson || {}),    // $19
  ];

  const { rows } = await query(sql, params);
  console.log('[upsertHouseRaw] stored row id=', rows[0]?.id, 'iso=', iso);
  return rows[0];
}

// ASPECTS → astro_aspect_raw
async function upsertAspectRaw({
  system = 'western',
  iso,
  coords,
  payload,
  resultJson,
  provider = 'freeastrologyapi.com',
}) {
  const {
    year,
    month,
    date,
    hours,
    minutes,
    seconds,
    latitude,
    longitude,
    timezone,
    config = {},
  } = payload;

  const statusCode = resultJson?.statusCode ?? null;

  const sql = `
    INSERT INTO astro_aspect_raw (
      system,
      iso_input,
      coord_str,
      year, month, day, hour, minute, second,
      latitude, longitude, timezone_offset,
      observation_point, ayanamsha, lang,
      exclude_planets,
      allowed_aspects,
      orb_values,
      provider,
      status_code,
      raw_output,
      updated_at
    )
    VALUES (
      $1,  -- system
      $2,  -- iso_input
      $3,  -- coord_str
      $4,$5,$6,$7,$8,$9,
      $10,$11,$12,
      $13,$14,$15,
      $16,
      $17,
      $18,
      $19,
      $20,
      $21::jsonb,
      now()
    )
    ON CONFLICT (
      system,
      iso_input,
      coord_str,
      lang,
      COALESCE(observation_point, ''),
      COALESCE(ayanamsha, '')
    )
    DO UPDATE SET
      status_code      = EXCLUDED.status_code,
      raw_output       = EXCLUDED.raw_output,
      provider         = EXCLUDED.provider,
      exclude_planets  = EXCLUDED.exclude_planets,
      allowed_aspects  = EXCLUDED.allowed_aspects,
      orb_values       = EXCLUDED.orb_values,
      updated_at       = now()
    RETURNING *;
  `;

  const params = [
    system,                 // $1
    iso,                    // $2
    coords,                 // $3
    year,                   // $4
    month,                  // $5
    date,                   // $6
    hours,                  // $7
    minutes,                // $8
    seconds,                // $9
    latitude,               // $10
    longitude,              // $11
    timezone,               // $12
    config.observation_point || null, // $13
    config.ayanamsha        || null,  // $14
    config.language         || 'en',  // $15
    payload.exclude_planets || null,  // $16
    payload.allowed_aspects || null,  // $17
    payload.orb_values      || null,  // $18
    provider,                            // $19
    statusCode,                          // $20
    JSON.stringify(resultJson || {}),    // $21
  ];

  const { rows } = await query(sql, params);
  console.log('[upsertAspectRaw] stored row id=', rows[0]?.id, 'iso=', iso);
  return rows[0];
}

/* ──────────────────────────────────────────────
 * PLANETS – SINGLE CALL HELPER
 * ────────────────────────────────────────────── */

async function fetchPlanetsForIso(iso, coords, lang, options = {}) {
  const safeCoords = resolveCoords(coords);
  const payload = buildWesternPlanetsPayload(iso, safeCoords, lang);
  const result = await callFreeAstro('western/planets', payload);

  const {
    system = 'western',
    period = null,
    topic = 'planets_raw',
    provider = 'freeastrologyapi.com',
    modelNameLabel = 'freeastro-planets',
  } = options || {};

  let savedPlanetRaw = null;
  let savedPlanetRawError = null;

  try {
    savedPlanetRaw = await upsertPlanetRaw({
      system,
      iso,
      coords: safeCoords,
      payload,
      resultJson: result.data,
      provider,
    });
  } catch (err) {
    console.error('[FreeAstro upsertPlanetRaw error]', err);
    savedPlanetRawError = String(err?.message || err);
  }

  console.log('[fetchPlanetsForIso] iso=', iso, 'savedPlanetRawId=', savedPlanetRaw?.id);

  return {
    ok: true,
    provider,
    endpoint: 'western/planets',
    system,
    iso,
    coords: safeCoords,
    payload,
    data: result.data,
    meta: {
      period,
      topic,
      modelNameLabel,
    },
    savedPlanetRaw,
    savedPlanetRawError,
  };
}

/* ──────────────────────────────────────────────
 * ROUTES
 * ────────────────────────────────────────────── */

// Health check
router.get('/ping', (_req, res) => {
  res.json({ ok: true, provider: 'freeastrologyapi.com' });
});

// Single-date Western planets
router.post('/western/planets', async (req, res) => {
  try {
    const { iso, coords, lang } = req.body || {};

    if (!iso) {
      return res.status(400).json({
        ok: false,
        error: 'missing_iso',
        message: 'Required field "iso" is missing',
      });
    }

    const result = await fetchPlanetsForIso(iso, coords, lang, {
      system: 'western',
      period: 'instant',
      topic: 'planets_single',
      provider: 'freeastrologyapi.com',
      modelNameLabel: 'freeastro:single',
    });

    return res.json(result);
  } catch (e) {
    console.error('[FreeAstro western/planets error]', e?.response || e);
    const status = e?.response?.status || 502;
    return res.status(status).json({
      ok: false,
      error: 'freeastro_error',
      status,
      detail: e?.response?.data || String(e.message || e),
    });
  }
});

// Single-date Western houses → astro_house_raw
router.post('/western/houses', async (req, res) => {
  try {
    const { iso, coords, lang, houseSystem } = req.body || {};

    if (!iso) {
      return res.status(400).json({
        ok: false,
        error: 'missing_iso',
        message: 'Required field "iso" is missing',
      });
    }

    const safeCoords = resolveCoords(coords);

    const payload = buildWesternHousesPayload(
      iso,
      safeCoords,
      lang || 'en',
      houseSystem || 'Placidus'
    );

    const result = await callFreeAstro('western/houses', payload);

    let saved = null;
    let savedError = null;

    try {
      saved = await upsertHouseRaw({
        system: 'western',
        iso,
        coords: safeCoords,
        payload,
        resultJson: result.data,
        provider: 'freeastrologyapi.com',
      });
    } catch (err) {
      console.error('[FreeAstro western/houses upsert error]', err);
      savedError = String(err?.message || err);
    }

    return res.json({
      ok: true,
      provider: 'freeastrologyapi.com',
      endpoint: 'western/houses',
      system: 'western',
      iso,
      coords: safeCoords,
      payload,
      data: result.data,
      saved,
      savedError,
    });
  } catch (e) {
    console.error('[FreeAstro western/houses error]', e?.response || e);
    const status = e?.response?.status || 502;
    return res.status(status).json({
      ok: false,
      error: 'freeastro_error',
      status,
      detail: e?.response?.data || String(e.message || e),
    });
  }
});

// Single-date Western aspects → astro_aspect_raw
router.post('/western/aspects', async (req, res) => {
  try {
    const {
      iso,
      coords,
      lang,
      excludePlanets,
      allowedAspects,
      orbValues,
    } = req.body || {};

    if (!iso) {
      return res.status(400).json({
        ok: false,
        error: 'missing_iso',
        message: 'Required field "iso" is missing',
      });
    }

    const safeCoords = resolveCoords(coords);

    const payload = buildWesternAspectsPayload(
      iso,
      safeCoords,
      lang || 'en',
      {
        excludePlanets,
        allowedAspects,
        orbValues,
      }
    );

    const result = await callFreeAstro('western/aspects', payload);

    let saved = null;
    let savedError = null;

    try {
      saved = await upsertAspectRaw({
        system: 'western',
        iso,
        coords: safeCoords,
        payload,
        resultJson: result.data,
        provider: 'freeastrologyapi.com',
      });
    } catch (err) {
      console.error('[FreeAstro western/aspects upsert error]', err);
      savedError = String(err?.message || err);
    }

    return res.json({
      ok: true,
      provider: 'freeastrologyapi.com',
      endpoint: 'western/aspects',
      system: 'western',
      iso,
      coords: safeCoords,
      payload,
      data: result.data,
      saved,
      savedError,
    });
  } catch (e) {
    console.error('[FreeAstro western/aspects error]', e?.response || e);
    const status = e?.response?.status || 502;
    return res.status(status).json({
      ok: false,
      error: 'freeastro_error',
      status,
      detail: e?.response?.data || String(e.message || e),
    });
  }
});

// Multi-period Western planets range
router.post('/western/planets/range', async (req, res) => {
  try {
    const { baseIso, coords, lang, periods } = req.body || {};

    const base = baseIso || new Date().toISOString();
    const safeCoords = resolveCoords(coords);

    const requestedPeriods =
      Array.isArray(periods) && periods.length
        ? periods
        : ['yesterday', 'today', 'tomorrow', 'next7', 'next30', 'year'];

    const results = {};

    // Yesterday
    if (requestedPeriods.includes('yesterday')) {
      const isoYest = shiftIsoDays(base, -1);
      results.yesterday = await fetchPlanetsForIso(
        isoYest,
        safeCoords,
        lang,
        {
          system: 'western',
          period: 'yesterday',
          topic: 'planets_range',
          modelNameLabel: 'freeastro:yesterday',
        }
      );
    }

    // Today
    if (requestedPeriods.includes('today')) {
      results.today = await fetchPlanetsForIso(base, safeCoords, lang, {
        system: 'western',
        period: 'today',
        topic: 'planets_range',
        modelNameLabel: 'freeastro:today',
      });
    }

    // Tomorrow
    if (requestedPeriods.includes('tomorrow')) {
      const isoTom = shiftIsoDays(base, +1);
      results.tomorrow = await fetchPlanetsForIso(isoTom, safeCoords, lang, {
        system: 'western',
        period: 'tomorrow',
        topic: 'planets_range',
        modelNameLabel: 'freeastro:tomorrow',
      });
    }

    // Next 1 week (7 days ahead: +1 to +7)
    if (requestedPeriods.includes('next7')) {
      const arr = [];
      for (let i = 1; i <= 7; i++) {
        const iso = shiftIsoDays(base, i);
        const r = await fetchPlanetsForIso(iso, safeCoords, lang, {
          system: 'western',
          period: `next7_d${i}`,
          topic: 'planets_range',
          modelNameLabel: 'freeastro:next7',
        });
        arr.push(r);
      }
      results.next7 = arr;
    }

    // Next 1 "month" = all days in month of baseIso
    if (requestedPeriods.includes('next30')) {
      const monthIsos = buildMonthIsoList(base);
      const arr = [];

      console.log(
        `[FreeAstro range] next30: month=${base} days=${monthIsos.length}, delay=${DAY_DELAY_MS}ms`
      );

      let index = 0;
      for (const iso of monthIsos) {
        index += 1;
        console.log(
          `[FreeAstro range] next30 day ${index}/${monthIsos.length} iso=${iso}`
        );

        try {
          const r = await fetchPlanetsForIso(iso, safeCoords, lang, {
            system: 'western',
            period: 'daily',
            topic: 'planets_range',
            modelNameLabel: 'freeastro:daily',
          });
          arr.push(r);
        } catch (err) {
          console.error(
            '[FreeAstro range] next30 error for iso',
            iso,
            err?.response?.data || err.message || err
          );
        }

        if (index < monthIsos.length) {
          console.log(
            `[FreeAstro range] next30 sleeping ${DAY_DELAY_MS}ms before next day…`
          );
          await sleep(DAY_DELAY_MS);
        }
      }

      results.next30 = arr;
    }

    // Next 1 year (12 monthly points)
    if (requestedPeriods.includes('year')) {
      const arr = [];
      for (let i = 0; i < 12; i++) {
        const iso = shiftIsoMonths(base, i);
        const r = await fetchPlanetsForIso(iso, safeCoords, lang, {
          system: 'western',
          period: `year_m${i}`,
          topic: 'planets_range',
          modelNameLabel: 'freeastro:year',
        });
        arr.push(r);
      }
      results.year = arr;
    }

    return res.json({
      ok: true,
      provider: 'freeastrologyapi.com',
      baseIso: base,
      coords: safeCoords,
      periods: requestedPeriods,
      results,
    });
  } catch (e) {
    console.error(
      '[FreeAstro western/planets/range error]',
      e?.response || e
    );
    const status = e?.response?.status || 502;
    return res.status(status).json({
      ok: false,
      error: 'freeastro_error',
      status,
      detail: e?.response?.data || String(e.message || e),
    });
  }
});
// Multi-period Western aspects range → astro_aspect_raw
router.post('/western/aspects/range', async (req, res) => {
  try {
    const { baseIso, coords, lang, periods } = req.body || {};

    const base = baseIso || new Date().toISOString();
    const safeCoords = resolveCoords(coords);

    // Normalize periods and allow aliases
    const rawPeriods =
      Array.isArray(periods) && periods.length
        ? periods
        : ['yesterday', 'today', 'tomorrow', 'next7'];

    const requested = rawPeriods.map((p) => String(p).toLowerCase());

    const wantYesterday = requested.includes('yesterday');
    const wantToday = requested.includes('today');
    const wantTomorrow = requested.includes('tomorrow');

    const wantNext7 =
      requested.includes('next7') ||
      requested.includes('weekly') ||
      requested.includes('week');

    const wantNext30 =
      requested.includes('next30') ||
      requested.includes('monthly') ||
      requested.includes('month');

    const wantYear = requested.includes('year');

    const results = {};

    // Small helper: single aspects call + upsert
    async function fetchAspectsForIso(label, iso) {
      const payload = buildWesternAspectsPayload(
        iso,
        safeCoords,
        lang || 'en',
        {} // later you can pass excludePlanets / allowedAspects / orbValues
      );

      const result = await callFreeAstro('western/aspects', payload);

      let saved = null;
      let savedError = null;
      try {
        saved = await upsertAspectRaw({
          system: 'western',
          iso,
          coords: safeCoords,
          payload,
          resultJson: result.data,
          provider: 'freeastrologyapi.com',
        });
      } catch (err) {
        console.error('[FreeAstro aspects/range upsert error]', label, err);
        savedError = String(err?.message || err);
      }

      return {
        iso,
        coords: safeCoords,
        payload,
        data: result.data,
        saved,
        savedError,
      };
    }

    // Yesterday
    if (wantYesterday) {
      const isoY = shiftIsoDays(base, -1);
      results.yesterday = await fetchAspectsForIso('yesterday', isoY);
    }

    // Today
    if (wantToday) {
      results.today = await fetchAspectsForIso('today', base);
    }

    // Tomorrow
    if (wantTomorrow) {
      const isoT = shiftIsoDays(base, +1);
      results.tomorrow = await fetchAspectsForIso('tomorrow', isoT);
    }

    // Weekly: next 7 days
    if (wantNext7) {
      const arr = [];
      for (let i = 1; i <= 7; i++) {
        const iso = shiftIsoDays(base, i);
        const r = await fetchAspectsForIso(`next7_d${i}`, iso);
        arr.push(r);
      }
      results.next7 = arr;
    }

    // Monthly: all days in the month of baseIso
    if (wantNext30) {
      const monthIsos = buildMonthIsoList(base);
      const arr = [];

      console.log(
        `[FreeAstro aspects/range] monthly: base=${base}, days=${monthIsos.length}`
      );

      let idx = 0;
      for (const iso of monthIsos) {
        idx += 1;
        console.log(
          `[FreeAstro aspects/range] day ${idx}/${monthIsos.length} iso=${iso}`
        );
        try {
          const r = await fetchAspectsForIso(`month_d${idx}`, iso);
          arr.push(r);
        } catch (err) {
          console.error(
            '[FreeAstro aspects/range] error for iso',
            iso,
            err?.response?.data || err.message || err
          );
        }
      }

      results.next30 = arr;
    }

    // Yearly: 12 snapshots month-by-month
    if (wantYear) {
      const arr = [];
      for (let i = 0; i < 12; i++) {
        const iso = shiftIsoMonths(base, i);
        const r = await fetchAspectsForIso(`year_m${i}`, iso);
        arr.push(r);
      }
      results.year = arr;
    }

    return res.json({
      ok: true,
      provider: 'freeastrologyapi.com',
      baseIso: base,
      coords: safeCoords,
      periods: requested,
      results,
    });
  } catch (e) {
    console.error('[FreeAstro western/aspects/range error]', e?.response || e);
    const status = e?.response?.status || 502;
    return res.status(status).json({
      ok: false,
      error: 'freeastro_error',
      status,
      detail: e?.response?.data || String(e.message || e),
    });
  }
});
// Multi-period Western houses range → astro_house_raw
router.post('/western/houses/range', async (req, res) => {
  try {
    const { baseIso, coords, lang, periods, houseSystem } = req.body || {};

    const base = baseIso || new Date().toISOString();
    const safeCoords = resolveCoords(coords);
    const hs = houseSystem || 'Placidus';

    // Normalize periods and allow aliases
    const rawPeriods =
      Array.isArray(periods) && periods.length
        ? periods
        : ['yesterday', 'today', 'tomorrow', 'next7'];

    const requested = rawPeriods.map((p) => String(p).toLowerCase());

    const wantYesterday = requested.includes('yesterday');
    const wantToday = requested.includes('today');
    const wantTomorrow = requested.includes('tomorrow');

    const wantNext7 =
      requested.includes('next7') ||
      requested.includes('weekly') ||
      requested.includes('week');

    const wantNext30 =
      requested.includes('next30') ||
      requested.includes('monthly') ||
      requested.includes('month');

    const wantYear = requested.includes('year');

    const results = {};

    // Small helper: single houses call + upsert
    async function fetchHousesForIso(label, iso) {
      const payload = buildWesternHousesPayload(
        iso,
        safeCoords,
        lang || 'en',
        hs
      );

      const result = await callFreeAstro('western/houses', payload);

      let saved = null;
      let savedError = null;
      try {
        saved = await upsertHouseRaw({
          system: 'western',
          iso,
          coords: safeCoords,
          payload,
          resultJson: result.data,
          provider: 'freeastrologyapi.com',
        });
      } catch (err) {
        console.error('[FreeAstro houses/range upsert error]', label, err);
        savedError = String(err?.message || err);
      }

      return {
        iso,
        coords: safeCoords,
        houseSystem: hs,
        payload,
        data: result.data,
        saved,
        savedError,
      };
    }

    // Yesterday
    if (wantYesterday) {
      const isoY = shiftIsoDays(base, -1);
      results.yesterday = await fetchHousesForIso('yesterday', isoY);
    }

    // Today
    if (wantToday) {
      results.today = await fetchHousesForIso('today', base);
    }

    // Tomorrow
    if (wantTomorrow) {
      const isoT = shiftIsoDays(base, +1);
      results.tomorrow = await fetchHousesForIso('tomorrow', isoT);
    }

    // Weekly: next 7 days
    if (wantNext7) {
      const arr = [];
      for (let i = 1; i <= 7; i++) {
        const iso = shiftIsoDays(base, i);
        const r = await fetchHousesForIso(`next7_d${i}`, iso);
        arr.push(r);
      }
      results.next7 = arr;
    }

    // Monthly: all days in the month of baseIso
    if (wantNext30) {
      const monthIsos = buildMonthIsoList(base);
      const arr = [];

      console.log(
        `[FreeAstro houses/range] monthly: base=${base}, days=${monthIsos.length}`
      );

      let idx = 0;
      for (const iso of monthIsos) {
        idx += 1;
        console.log(
          `[FreeAstro houses/range] day ${idx}/${monthIsos.length} iso=${iso}`
        );
        try {
          const r = await fetchHousesForIso(`month_d${idx}`, iso);
          arr.push(r);
        } catch (err) {
          console.error(
            '[FreeAstro houses/range] error for iso',
            iso,
            err?.response?.data || err.message || err
          );
        }
      }

      results.next30 = arr;
    }

    // Yearly: 12 snapshots month-by-month
    if (wantYear) {
      const arr = [];
      for (let i = 0; i < 12; i++) {
        const iso = shiftIsoMonths(base, i);
        const r = await fetchHousesForIso(`year_m${i}`, iso);
        arr.push(r);
      }
      results.year = arr;
    }

    return res.json({
      ok: true,
      provider: 'freeastrologyapi.com',
      baseIso: base,
      coords: safeCoords,
      houseSystem: hs,
      periods: requested,
      results,
    });
  } catch (e) {
    console.error('[FreeAstro western/houses/range error]', e?.response || e);
    const status = e?.response?.status || 502;
    return res.status(status).json({
      ok: false,
      error: 'freeastro_error',
      status,
      detail: e?.response?.data || String(e.message || e),
    });
  }
});

export default router;
