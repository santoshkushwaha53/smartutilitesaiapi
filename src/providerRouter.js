// src/providerRouter.js
import { callProkerala } from '../utils/prokerala.js';
import { callFreeAstro, buildWesternPlanetsPayload } from '../utils/freeastro.js';

const PK_HEADERS = process.env.PROKERALA_HEADERS
  ? JSON.parse(process.env.PROKERALA_HEADERS)
  : null;

/**
 * feature: 'raw_panchang' (vedic) | 'horoscope_prediction' (western snapshot) ...
 * Always returns { provider, endpoint, params, data, ok, status? }
 */
export async function fetchRoutedRawSnapshot({ feature, system, period, topic, iso, lang, coords, sign }) {
  const sys = String(system || '').toLowerCase();

  // ---- VEDIC: prokerala panchang ----
  if (sys === 'vedic') {
    const endpoint = 'v2/astrology/panchang';

    // Many backends prefer explicit lat/lon
    let latitude = 0, longitude = 0;
    if (coords) {
      const [lat, lon] = String(coords).split(',').map(v => parseFloat(v.trim()));
      if (Number.isFinite(lat)) latitude = lat;
      if (Number.isFinite(lon)) longitude = lon;
    }

    const params = {
      coordinates: coords,         // keep for backwards compatibility
      latitude,
      longitude,
      datetime: iso,
      ayanamsa: 1,
      language: lang || 'en'
    };

    try {
      const r = await callProkerala(endpoint, params, PK_HEADERS || undefined);
      return { provider: 'prokerala', endpoint, params, data: r.data, ok: true };
    } catch (e) {
      const status = e?.response?.status || e?.status || 500;
      const data   = e?.response?.data || e?.data || { error: 'unknown_prokerala_error', detail: String(e.message || e) };
      return { provider: 'prokerala', endpoint, params, data, ok: false, status };
    }
  }

  // ---- WESTERN: FreeAstro sample (planets snapshot) ----
  const endpoint = 'western/planets';
  const params = buildWesternPlanetsPayload(iso, coords, lang); // helper that turns ISO+coords into their date/lat/lon/tz JSON

  try {
    const r = await callFreeAstro(endpoint, params, null);
    return { provider: 'freeastro', endpoint, params, data: r.data, ok: true };
  } catch (e) {
    const status = e?.response?.status || e?.status || 500;
    const data   = e?.response?.data || e?.data || { error: 'unknown_freeastro_error', detail: String(e.message || e) };
    return { provider: 'freeastro', endpoint, params, data, ok: false, status };
  }
}
