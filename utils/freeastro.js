// utils/freeastro.js
import axios from 'axios';

// ENV
const RAW_BASE =
  process.env.FREEASTRO_BASE || 'https://json.freeastrologyapi.com';

const MODE = (process.env.FREEASTRO_MODE || 'sandbox').toLowerCase(); // sandbox|live
const BASE = process.env.FREEASTRO_BASE || 'https://json.freeastrologyapi.com';
const APIKEY = process.env.FREEASTRO_API_KEY || '';

// Build a *clean* axios client with no Authorization default whatsoever
const client = axios.create({
  baseURL: BASE,
  headers: {
    'Content-Type': 'application/json',
  },
  // do not auto-reject non-2xx so we can normalize errors
  validateStatus: () => true,
});
// extra safety: remove any inherited Authorization header
try {
  delete client.defaults.headers.common.Authorization;
} catch {
  /* ignore */
}

// Parse "lat,lon" -> { latitude, longitude }
function parseCoords(coordsStr) {
  if (!coordsStr) return { latitude: 0, longitude: 0 };
  const [lat, lon] = String(coordsStr)
    .split(',')
    .map((s) => parseFloat(s.trim()));
  return {
    latitude: Number.isFinite(lat) ? lat : 0,
    longitude: Number.isFinite(lon) ? lon : 0,
  };
}

// +05:30 → 5.5 ; -07:00 → -7
function tzFromISO(iso) {
  if (!iso) return 0;
  if (/[zZ]$/.test(iso)) return 0;
  const m = iso.match(/([+-])(\d{2}):?(\d{2})$/);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  const hh = parseInt(m[2] || '0', 10);
  const mm = parseInt(m[3] || '0', 10);
  return sign * (hh + mm / 60);
}

// Extract wall-clock parts from ISO (we also send timezone separately)
function partsFromISO(iso) {
  const m = String(iso || '').match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/
  );
  if (m) {
    return {
      year: +m[1],
      month: +m[2],
      date: +m[3],
      hours: +m[4],
      minutes: +m[5],
      seconds: +(m[6] || 0),
    };
  }
  const d = new Date(iso || Date.now());
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    date: d.getUTCDate(),
    hours: d.getUTCHours(),
    minutes: d.getUTCMinutes(),
    seconds: d.getUTCSeconds(),
  };
}

// ───────────────────────────────────────────────
// Payload builder for western planets
// ───────────────────────────────────────────────

export function buildWesternPlanetsPayload(iso, coords, lang = 'en') {
  // 1) Date/time parts as pure integers (no leading zeros in JSON)
  const { year, month, date, hours, minutes, seconds } = partsFromISO(iso);

  // 2) Timezone as float from the ISO offset, e.g. +05:30 → 5.5
  let timezone = tzFromISO(iso);
  // Fallback: if ISO has no offset, use local offset of the ISO date
  if (!Number.isFinite(timezone)) {
    const d = new Date(iso || Date.now());
    timezone = -d.getTimezoneOffset() / 60; // e.g. 5.5
  }

  // 3) Latitude / longitude as floats
  const { latitude, longitude } = parseCoords(coords);

  return {
    year, // Integer: e.g. 2025
    month, // Integer: 1..12
    date, // Integer: 1..31
    hours, // Integer: 0..23
    minutes, // Integer: 0..59
    seconds, // Integer: 0..59
    latitude, // Float: -90..90
    longitude, // Float: -180..180
    timezone, // Float: e.g. 5.5
    config: {
      observation_point: 'topocentric',
      ayanamsha: 'tropical',
      language: lang || 'en',
    },
  };
}

/* ──────────────────────────────────────────────
 * NEW: Payload builder for western houses
 * Reuses the planets payload and just adds house_system
 * ────────────────────────────────────────────── */
export function buildWesternHousesPayload(
  iso,
  coords,
  lang = 'en',
  houseSystem = 'Placidus'
) {
  const payload = buildWesternPlanetsPayload(iso, coords, lang);

  payload.config = {
    ...(payload.config || {}),
    house_system: houseSystem || 'Placidus',
  };

  return payload;
}
/* ──────────────────────────────────────────────
 * NEW: Payload builder for western aspects
 * Reuses planets payload and adds aspects options.
 * ────────────────────────────────────────────── */
export function buildWesternAspectsPayload(
  iso,
  coords,
  lang = 'en',
  {
    excludePlanets = null,
    allowedAspects = null,
    orbValues = null,
  } = {}
) {
  const payload = buildWesternPlanetsPayload(iso, coords, lang);

  // As per docs, these are top-level fields (not inside config)
  if (Array.isArray(excludePlanets) && excludePlanets.length > 0) {
    payload.exclude_planets = excludePlanets;
  }

  if (Array.isArray(allowedAspects) && allowedAspects.length > 0) {
    payload.allowed_aspects = allowedAspects;
  }

  if (orbValues && typeof orbValues === 'object') {
    payload.orb_values = orbValues;
  }

  return payload;
}

/**
 * FreeAstro JSON caller
 * @param endpoint e.g. 'western/planets'
 * @param body     JSON payload as per provider docs
 * @param extraHeaders optional object to merge (rarely needed)
 */
export async function callFreeAstro(endpoint, body, _unused) {
  const url = `${BASE.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`;
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': APIKEY, // <-- per their docs
  };
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`freeastro ${res.status}`);
    err.response = { status: res.status, data: json };
    throw err;
  }
  return { data: json, status: 'ok', httpStatus: res.status };
}
