import express from 'express';
import { query } from '../../src/db.js';

const router = express.Router();
const BASE = process.env.SELF_API_BASE;
/* ---------------- Helpers ---------------- */

function normalizeCoords(lat, lon) {
  return `${Number(lat).toFixed(6)},${Number(lon).toFixed(6)}`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** timezoneOffset (5.5) -> "+05:30" */
function tzOffsetToString(timezoneOffset) {
  const off = Number(timezoneOffset);
  if (!Number.isFinite(off)) return '+00:00';

  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const hours = Math.floor(abs);
  const minutes = Math.round((abs - hours) * 60);

  return `${sign}${pad2(hours)}:${pad2(minutes)}`;
}

/* -------------------------------------------------------
 * DATE / TIME NORMALIZERS (SAFE)
 * ----------------------------------------------------- */
function toYMD(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return v.toISOString().slice(0, 10);
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function toHMS(v) {
  if (v == null) return '00:00:00';
  const s = String(v).trim();
  if (/^\d{2}:\d{2}:\d{2}$/.test(s)) return s;
  if (/^\d{2}:\d{2}$/.test(s)) return `${s}:00`;
  const m = s.match(/^(\d{2}):(\d{2}):(\d{2})/);
  if (m) return `${m[1]}:${m[2]}:${m[3]}`;
  return '00:00:00';
}

function normalizeTzOffsetToString(tz) {
  if (tz == null || tz === '') return '+00:00';
  const s = String(tz).trim();
  if (/^[+-]\d{2}:\d{2}$/.test(s)) return s;
  if (/^[+-]\d{4}$/.test(s)) return `${s.slice(0, 3)}:${s.slice(3)}`;

  const off = Number(s);
  if (!Number.isFinite(off)) return '+00:00';
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const hours = Math.floor(abs);
  const minutes = Math.round((abs - hours) * 60);
  return `${sign}${pad2(hours)}:${pad2(minutes)}`;
}

function buildLocalIsoWithOffset(birthDate, birthTime, timezoneOffset) {
  const d = toYMD(birthDate);
  if (!d) throw new Error(`Invalid birth_date: ${birthDate}`);
  const t = toHMS(birthTime);
  const offStr = normalizeTzOffsetToString(timezoneOffset);
  return `${d}T${t}${offStr}`;
}

function toYMDParts(v) {
  const d = toYMD(v);
  if (!d) throw new Error(`Invalid birth_date: ${v}`);
  const [year, month, date] = d.split('-').map(Number);
  return { year, month, date };
}

function toHMSParts(v) {
  const t = toHMS(v);
  const [hours, minutes, seconds] = t.split(':').map(Number);
  return { hours, minutes, seconds };
}

function toTzHours(tzOff, resolvedCountry) {
  if (tzOff == null || tzOff === '') {
    return String(resolvedCountry || '').toUpperCase() === 'IN' ? 5.5 : 0;
  }
  const n = Number(tzOff);
  return Number.isFinite(n) ? n : 0;
}

/* -------------------------------------------------------
 * SAFE FETCH
 * ----------------------------------------------------- */
async function safeReadResponse(resp) {
  const contentType = String(resp.headers.get('content-type') || '').toLowerCase();
  const text = await resp.text();
  const looksJson = text.trim().startsWith('{') || text.trim().startsWith('[');

  if (contentType.includes('application/json') || looksJson) {
    try {
      return { ok: true, data: JSON.parse(text) };
    } catch {
      return { ok: false, status: resp.status, snippet: text.slice(0, 300) };
    }
  }

  return { ok: false, status: resp.status, snippet: text.slice(0, 300) };
}

/* -------------------------------------------------------
 * DB LOADERS
 * ----------------------------------------------------- */
async function loadBirthProfileByEmail(email) {
  const { rows } = await query(
    `
    SELECT email, latitude, longitude, birth_date, birth_time, timezone_offset, country
    FROM public.birth_profile
    WHERE email = $1
    LIMIT 1
    `,
    [String(email)]
  );
  return rows[0] || null;
}

async function loadLatestBirthChartForUser(email, system) {
  const { rows } = await query(
    `
    SELECT chart_id, user_id, system, latitude, longitude, birth_date, birth_time, timezone_offset
    FROM public.birth_chart
    WHERE user_id = $1
      AND system = $2
    ORDER BY chart_id DESC
    LIMIT 1
    `,
    [String(email), String(system)]
  );
  return rows[0] || null;
}

function isSameProfileAndChart(profile, chart) {
  if (!profile || !chart) return false;

  return (
    toYMD(profile.birth_date) === toYMD(chart.birth_date) &&
    toHMS(profile.birth_time) === toHMS(chart.birth_time) &&
    normalizeCoords(profile.latitude, profile.longitude) ===
      normalizeCoords(chart.latitude, chart.longitude) &&
    Number(profile.timezone_offset) === Number(chart.timezone_offset)
  );
}

/* =======================================================
 * POST /api/birthchart/get-or-generate
 * ===================================================== */
router.post('/get-or-generate', async (req, res) => {
  const startedAt = Date.now();
debugger;
  try {
    const { email, country = null, system = 'western', lang = 'en' } = req.body || {};
    if (!email) return res.status(400).json({ ok: false, error: 'missing_email' });

    const sys = String(system).toLowerCase();

    /* 1) Load profile */
    const profile = await loadBirthProfileByEmail(email);
    if (!profile) return res.status(404).json({ ok: false, error: 'birth_profile_not_found' });

    const resolvedCountry = country || profile.country || null;

    /* 2) Load existing chart FOR SYSTEM */
    const existingChart = await loadLatestBirthChartForUser(email, sys);

    const hasNoChartForSystem = !existingChart;
    const sameProfile = existingChart && isSameProfileAndChart(profile, existingChart);

    /* 3) Cache hit ONLY when chart exists AND profile unchanged */
  /* 3) Cache hit ONLY when chart exists AND profile unchanged */
if (!hasNoChartForSystem && sameProfile) {
  // 🔹 Special handling for VEDIC
  if (sys === 'vedic') {

  // 1) Load interpretation AND get vedic_raw_id from same table
  const { rows: interpRows } = await query(
    `
    SELECT vedic_raw_id, interpretation_html, response_json
    FROM vedic_birth_chart_interpretation
    WHERE user_id = $1
      AND vedic_interpretation_id = $2
    LIMIT 1
    `,
    [email, existingChart.chart_id]
  );

  if (!interpRows.length) {
    return res.status(404).json({
      ok: false,
      error: 'vedic_interpretation_not_found'
    });
  }

  const vedicRawId = interpRows[0].vedic_raw_id;
  const chartJson = interpRows[0].response_json ?? null;

  // 2) Load RAW using the vedicRawId
  const { rows: rawRows } = await query(
    `
    SELECT *
    FROM vedic_birth_chart_raw
    WHERE user_id = $1
      AND vedic_raw_id = $2
    LIMIT 1
    `,
    [email, vedicRawId]
  );

  // 3) Build interpretation block for UI — FULL response_json, not only answerJson
  const interpretationBlock = chartJson ? {
    responseJson: chartJson
  } : null;

  // 4) Respond with UI-compatible shape
  return res.json({
    ok: true,
    source: 'cache',
    email,
    country: resolvedCountry,
    system: sys,
    lang,
    chartId: existingChart.chart_id,

    db: {
      raw: rawRows[0] ? {
        rasi_planet_raw: rawRows[0].rasi_planet_raw,
        rasi_house_raw: rawRows[0].rasi_house_raw,
        houses_raw: rawRows[0].houses_raw,
        meta_json: rawRows[0].meta_json
      } : null,
      interpretation: interpretationBlock
    },

    tookMs: Date.now() - startedAt
  });
}


  // 🔹 NON-VEDIC: keep your existing lightweight response
  return res.json({
    ok: true,
    source: 'cache',
    email,
    country: resolvedCountry,
    system: sys,              // 'western' etc.
    lang,
    chartId: existingChart.chart_id,
    tookMs: Date.now() - startedAt,
  });
}


    /* 4) Otherwise → GENERATE (new OR regenerate) */
    const lat = Number(profile.latitude);
    const lon = Number(profile.longitude);
    const tzOff = toTzHours(profile.timezone_offset, resolvedCountry);

    let generatorUrl = '';
    let payload = null;

    if (sys === 'vedic') {
      generatorUrl = `${BASE}/api/birthchart/vedic/get-or-generate`;
      const { year, month, date } = toYMDParts(profile.birth_date);
      const { hours, minutes, seconds } = toHMSParts(profile.birth_time);

      payload = {
        userId: email,
        year,
        month,
        date,
        hours,
        minutes,
        seconds,
        latitude: lat,
        longitude: lon,
        timezone: tzOff,
        lang,
        purpose: 'natal',
        tone: 'balanced',
      };
    } else {
      generatorUrl = `${BASE}/api/birthchart/western/birth-chart/raw`;
      const iso = buildLocalIsoWithOffset(profile.birth_date, profile.birth_time, tzOff);

      payload = {
        userEmail: email,
        birthProfileEmail: email,
        iso,
        latitude: lat,
        longitude: lon,
        timezoneOffset: tzOff,
        country: resolvedCountry,
        houseSystem: 'Placidus',
        lang,
        purpose: 'natal',
        tone: 'balanced',
      };
    }

    const resp = await fetch(generatorUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const parsed = await safeReadResponse(resp);

    return res.status(resp.ok ? 200 : 502).json({
      ok: resp.ok && parsed.data?.ok !== false,
      source: hasNoChartForSystem ? 'new' : 'regenerated',
      email,
      country: resolvedCountry,
      system: sys,
      lang,
      generatorUrl,
      generatorResponse: parsed.data,
      tookMs: Date.now() - startedAt,
    });
  } catch (err) {
    console.error('[get-or-generate fatal]', err);
    return res.status(500).json({
      ok: false,
      error: 'get_or_generate_failed',
      detail: err?.message || String(err),
    });
  }
});

export default router;
