// routes/prokerala.route.js
import express from 'express';
import { z } from 'zod';
import NodeCache from 'node-cache';

// IMPORTANT: Option B path + .js extension
import { prokeralaGet } from '../src/clients/prokerala.js';

const router = express.Router();
const cache = new NodeCache({ stdTTL: 60, checkperiod: 120 });

const ck = (e, p) => `${e}::${JSON.stringify(p || {})}`;

function handleError(res, err) {
  if (err?.issues) return res.status(400).json({ error: 'ValidationError', issues: err.issues });
  if (err?.normalized) return res.status(err.normalized.status || 500).json({ error: 'ProkeralaError', detail: err.normalized });
  res.status(500).json({ error: 'InternalServerError', message: err?.message || 'Unknown error' });
}

const CoordinatesSchema = z.string().regex(/^\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*$/, 'coordinates must be "lat,lng"');

const PanchangQuerySchema = z.object({
  coordinates: CoordinatesSchema,
  datetime: z.string(),
  ayanamsa: z.coerce.number().int().min(0).max(3).optional(),
  language: z.string().default('en').optional(),
});

const HoroscopeSchema = z.object({
  sign: z.string().min(3),
  period: z.enum(['yesterday','today','tomorrow']).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  topics: z.string().optional(), // "general,career,love,health"
  language: z.string().default('en').optional(),
});

function parseCoords(s) {
  const [lat, lng] = s.split(',').map(v => parseFloat(v.trim()));
  return `${lat},${lng}`;
}

/* --- Sign-based GENERIC today horoscope (no coordinates) --- */
router.get('/horoscope', async (req, res) => {
  try {
    const q = HoroscopeSchema.parse(req.query);
    const params = {
      sign: String(q.sign).toLowerCase().trim(),
      period: q.period,
      date: q.date,
      topics: q.topics,
      language: q.language ?? 'en',
    };
    const endpoint = '/v2/astrology/horoscope'; // adjust if your plan uses a different path
    const key = ck(endpoint, params); const hit = cache.get(key);
    if (hit) return res.json({ cached: true, data: hit });
    const data = await prokeralaGet(endpoint, params);
    cache.set(key, data);
    res.json({ cached: false, data });
  } catch (err) { handleError(res, err); }
});

/* --- Vedic Panchang (needs coords+datetime) --- */
router.get('/panchang', async (req, res) => {
  try {
    const q = PanchangQuerySchema.parse(req.query);
    const params = {
      coordinates: parseCoords(q.coordinates),
      datetime: q.datetime,
      ayanamsa: q.ayanamsa ?? 1,
      language: q.language ?? 'en',
    };
    const endpoint = '/v2/astrology/panchang';
    const key = ck(endpoint, params); const hit = cache.get(key);
    if (hit) return res.json({ cached: true, data: hit });
    const data = await prokeralaGet(endpoint, params);
    cache.set(key, data);
    res.json({ cached: false, data });
  } catch (err) { handleError(res, err); }
});

/* --- Vedic natal convenience --- */
router.get('/vedic/birth-chart', async (req, res) => {
  try {
    const { coordinates, datetime, language } = req.query;
    if (!coordinates || !datetime) return res.status(400).json({ error: 'coordinates and datetime are required' });
    const params = {
      coordinates: parseCoords(String(coordinates)),
      datetime: String(datetime),
      ayanamsa: 1,
      language: language || 'en',
    };
    const endpoint = '/v2/astrology/birth-chart';
    const key = ck(endpoint, params); const hit = cache.get(key);
    if (hit) return res.json({ cached: true, data: hit });
    const data = await prokeralaGet(endpoint, params);
    cache.set(key, data);
    res.json({ cached: false, data });
  } catch (err) { handleError(res, err); }
});

/* --- Western natal convenience --- */
router.get('/western/natal', async (req, res) => {
  try {
    const { coordinates, datetime, language } = req.query;
    if (!coordinates || !datetime) return res.status(400).json({ error: 'coordinates and datetime are required' });
    const params = {
      coordinates: parseCoords(String(coordinates)),
      datetime: String(datetime),
      language: language || 'en',
    };
    const endpoint = '/v2/astrology/natal-chart'; // change if your plan uses a different path
    const key = ck(endpoint, params); const hit = cache.get(key);
    if (hit) return res.json({ cached: true, data: hit });
    const data = await prokeralaGet(endpoint, params);
    cache.set(key, data);
    res.json({ cached: false, data });
  } catch (err) { handleError(res, err); }
});

export default router;
