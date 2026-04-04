// routes/freeastro-western.route.js
import express from 'express';
import axios from 'axios';
import crypto from 'node:crypto';
import { query } from '../src/db.js';

const router = express.Router();

const FREEASTRO_BASE = process.env.FREEASTRO_BASE || 'https://json.freeastrologyapi.com';
const FREEASTRO_API_KEY = process.env.FREEASTRO_API_KEY;

function requireField(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object' || !(p in cur)) {
      throw new Error(`Missing required field: ${path}`);
    }
    cur = cur[p];
  }
  return cur;
}

router.post('/western/natal-wheel', async (req, res) => {
  try {
    const body = req.body || {};
    const birth = body.birth || {};
    const config = body.config || {};

    const year      = requireField({ birth }, 'birth.year');
    const month     = requireField({ birth }, 'birth.month');
    const date      = requireField({ birth }, 'birth.date');
    const hours     = requireField({ birth }, 'birth.hours');
    const minutes   = requireField({ birth }, 'birth.minutes');
    const seconds   = requireField({ birth }, 'birth.seconds');
    const latitude  = requireField({ birth }, 'birth.latitude');
    const longitude = requireField({ birth }, 'birth.longitude');
    const timezone  = requireField({ birth }, 'birth.timezone');

    const userId      = body.userId ?? null;
    const profileId   = body.profileId ?? null;
    const callChannel = body.callChannel ?? 'api';
    const jobCode     = body.jobCode ?? null;
    const createdBy   = body.createdBy ?? null;

    const providerPayload = {
      year,
      month,
      date,
      hours,
      minutes,
      seconds,
      latitude,
      longitude,
      timezone,
      config,
    };

    const requestHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(providerPayload))
      .digest('hex');

    if (!FREEASTRO_API_KEY) {
      throw new Error('FREEASTRO_API_KEY is not configured');
    }

    const url = `${FREEASTRO_BASE}/western/natal-wheel-chart`;

    const { data: responseBody } = await axios.post(url, providerPayload, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': FREEASTRO_API_KEY, // adjust if header name is different
      },
      timeout: 15000,
    });

    const observation_point   = config.observation_point ?? null;
    const ayanamsha           = config.ayanamsha ?? null;
    const language            = config.language ?? null;
    const house_system        = config.house_system ?? null;
    const exclude_planets     = config.exclude_planets ?? null;
    const allowed_aspects     = config.allowed_aspects ?? null;
    const orb_values          = config.orb_values ?? null;
    const aspect_line_colors  = config.aspect_line_colors ?? null;
    const wheel_chart_colors  = config.wheel_chart_colors ?? null;

    if (profileId) {
      await query(
        `
        UPDATE astro_western_natal_wheel
           SET is_latest = FALSE,
               updated_at = now(),
               updated_by = $2
         WHERE profile_id = $1
           AND is_latest = TRUE
        `,
        [profileId, createdBy]
      );
    }

    const insertSql = `
      INSERT INTO astro_western_natal_wheel (
        user_id,
        profile_id,
        birth_year, birth_month, birth_day,
        birth_hours, birth_minutes, birth_seconds,
        latitude, longitude, timezone_offset,
        observation_point, ayanamsha, language, house_system,
        exclude_planets, allowed_aspects, orb_values,
        aspect_line_colors, wheel_chart_colors,
        request_payload, response_body,
        provider_code, api_endpoint, request_hash,
        call_channel, job_code,
        created_by, is_latest
      )
      VALUES (
        $1, $2,
        $3, $4, $5,
        $6, $7, $8,
        $9, $10, $11,
        $12, $13, $14, $15,
        $16::jsonb, $17::jsonb, $18::jsonb,
        $19::jsonb, $20::jsonb,
        $21::jsonb, $22::jsonb,
        'FREEASTRO', '/western/natal-wheel-chart', $23,
        $24, $25,
        $26, TRUE
      )
      RETURNING
        chart_id,
        created_at,
        birth_year, birth_month, birth_day,
        birth_hours, birth_minutes, birth_seconds,
        latitude, longitude, timezone_offset,
        observation_point, ayanamsha, language, house_system,
        response_body;
    `;

    const params = [
      userId,
      profileId,
      year,
      month,
      date,
      hours,
      minutes,
      seconds,
      latitude,
      longitude,
      timezone,
      observation_point,
      ayanamsha,
      language,
      house_system,
      exclude_planets,
      allowed_aspects,
      orb_values,
      aspect_line_colors,
      wheel_chart_colors,
      providerPayload,  // request_payload
      responseBody,     // response_body
      requestHash,
      callChannel,
      jobCode,
      createdBy
    ];

    const result = await query(insertSql, params);
    const row = result.rows[0];

    res.status(201).json({
      ok: true,
      chartId: row.chart_id,
      createdAt: row.created_at,
      meta: {
        birth: {
          year: row.birth_year,
          month: row.birth_month,
          day: row.birth_day,
          hours: row.birth_hours,
          minutes: row.birth_minutes,
          seconds: row.birth_seconds,
        },
        location: {
          latitude: row.latitude,
          longitude: row.longitude,
          timezoneOffset: row.timezone_offset,
        },
        config: {
          observation_point: row.observation_point,
          ayanamsha: row.ayanamsha,
          language: row.language,
          house_system: row.house_system,
        },
      },
      raw: row.response_body,
    });
  } catch (err) {
    console.error('[NATAL WHEEL ERROR]', err?.message, err?.stack);
    res.status(400).json({
      ok: false,
      error: err?.message || 'Failed to generate natal wheel chart',
    });
  }
});

export default router;
