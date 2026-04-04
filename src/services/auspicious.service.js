// src/services/auspicious.service.js
import OpenAI from 'openai';
import { Pool } from 'pg';

export const SIGNS = [
  'Aries','Taurus','Gemini','Cancer','Leo','Virgo',
  'Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces'
];

const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const pool   = new Pool({ connectionString: process.env.DATABASE_URL });

/** JSON schema for strict structured output (all 12 signs) */
const JSON_SCHEMA_ALL_SIGNS = {
  name: 'AllSignsAuspiciousDay',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      dateISO: { type: 'string' },
      signs: {
        type: 'array',
        minItems: 12,
        maxItems: 12,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sign: { type: 'string', enum: SIGNS },
            hourlyScores: {
              type: 'array',
              minItems: 24,
              maxItems: 24,
              items: { type: 'integer', minimum: 0, maximum: 100 }
            },
            windows: {
              type: 'array',
              minItems: 1,
              maxItems: 6,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  start:   { type: 'string' },
                  end:     { type: 'string' },
                  score:   { type: 'integer', minimum: 0, maximum: 100 },
                  kind:    { type: 'string' },
                  planets: {
                    type: 'array', minItems: 1, maxItems: 5,
                    items: { type: 'string' }
                  },
                  reason:  { type: 'string' }  // <-- listed in properties
                },
                // ---- Every key in properties MUST be required with strict: true
                required: ['start','end','score','kind','planets','reason']
              }
            },
            peak: {
              type: 'object',
              additionalProperties: false,
              properties: {
                start:   { type: 'string' },
                end:     { type: 'string' },
                score:   { type: 'integer', minimum: 0, maximum: 100 },
                kind:    { type: 'string' },
                planets: {
                  type: 'array', minItems: 1, maxItems: 5,
                  items: { type: 'string' }
                },
                reason:  { type: 'string' }   // <-- include & require this too
              },
              required: ['start','end','score','kind','planets','reason']
            },
            tags: {
              type: 'array',
              minItems: 3,
              maxItems: 5,
              items: { type: 'string' }
            }
          },
          required: ['sign','hourlyScores','windows','peak','tags']
        }
      }
    },
    required: ['dateISO','signs']
  }
};


function buildPromptsForAll(dayISO) {
  const system = `You generate realistic but synthetic "auspicious time" data for ALL 12 zodiac signs for UI testing.
Return ONLY JSON matching the schema.
Rules:
- dateISO must equal the provided UTC date (YYYY-MM-DD).
- 24 hourlyScores (0..100) per sign with morning & evening peaks.
- 1–3 windows per sign, start/end within dateISO (UTC) as ISO datetimes.
- peak is a strong hour slice with high score.
- planets chosen from: Sun, Moon, Mars, Mercury, Jupiter, Venus, Saturn, Rahu, Ketu.
- tags: choose 3–5 from Launch, Contracts, Romance, Wealth, Learning, Health, Travel, Creative Work.
- Vary across signs.`;
  const user = `UTC date: ${dayISO}
Return data for: ${SIGNS.join(', ')}
Output strictly JSON per schema.`;
  return { system, user };
}

/** ✅ Responses API with structured outputs via text.format (NO response_format) */
export async function callOpenAIForAll(dayISO) {
  const { system, user } = buildPromptsForAll(dayISO);

  // Debug: print exactly what required keys we send (the problematic section)
  console.log('[SCHEMA windows.items.required]=',
    JSON.stringify(
      JSON_SCHEMA_ALL_SIGNS.schema.properties.signs.items.properties.windows.items.required
    )
  );

  const resp = await openai.responses.create({
  model: MODEL,
  input: [
    { role: 'system', content: system },
    { role: 'user',   content: user }
  ],
  temperature: 0.2,
  text: {
    format: {
      type: 'json_schema',
      json_schema: {
        name: JSON_SCHEMA_ALL_SIGNS.name,
        schema: JSON_SCHEMA_ALL_SIGNS.schema,
        strict: true
      }
    }
  }
});
const txt = resp.output_text ?? (resp.output?.[0]?.content?.[0]?.text ?? '');
if (!txt) throw new Error('No JSON returned from Responses API');
return JSON.parse(txt);
}

const clamp = n => Math.max(0, Math.min(100, Number(n || 0)));

/** Insert/Upsert everything into Postgres in one transaction */
export async function upsertAllSigns(dayISO, dayOffset, userId, payload) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const s of payload.signs) {
      const dRes = await client.query(
        `INSERT INTO astro.auspicious_day (zodiac_sign, day_utc, day_offset, user_id)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (zodiac_sign, day_utc, day_offset, user_id)
         DO UPDATE SET created_utc = now()
         RETURNING id`,
        [s.sign, dayISO, dayOffset, userId || '']
      );
      const dayId = dRes.rows[0].id;

      // hourly
      await client.query(`DELETE FROM astro.auspicious_hourly WHERE day_id = $1`, [dayId]);
      for (let h = 0; h < 24; h++) {
        await client.query(
          `INSERT INTO astro.auspicious_hourly (day_id, hour_of_day, score) VALUES ($1,$2,$3)`,
          [dayId, h, clamp(s.hourlyScores[h])]
        );
      }

      // windows
      await client.query(
        `DELETE FROM astro.auspicious_window_planet WHERE window_id IN (SELECT id FROM astro.auspicious_window WHERE day_id = $1)`,
        [dayId]
      );
      await client.query(`DELETE FROM astro.auspicious_window WHERE day_id = $1`, [dayId]);
      for (const w of (s.windows || [])) {
        const wRes = await client.query(
          `INSERT INTO astro.auspicious_window (day_id, start_utc, end_utc, max_score, kind, reason)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [dayId, w.start, w.end, clamp(w.score), w.kind, w.reason || null]
        );
        const winId = wRes.rows[0].id;
        for (const p of (w.planets || [])) {
          await client.query(
            `INSERT INTO astro.auspicious_window_planet (window_id, planet) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [winId, p]
          );
        }
      }

      // tags
      await client.query(`DELETE FROM astro.auspicious_tag WHERE day_id = $1`, [dayId]);
      for (const t of (s.tags || [])) {
        await client.query(
          `INSERT INTO astro.auspicious_tag (day_id, tag) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [dayId, t]
        );
      }
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Read back a single sign in the exact widget shape */
// src/services/auspicious.service.js
export async function getOneSign(sign, dayISO, dayOffset, userId) {
  const q = `
    -- Candidate user_ids in priority order
    WITH wanted AS (
      SELECT $4 AS user_id
      UNION ALL SELECT ''
      UNION ALL SELECT 'guest'
    ),

    -- (A) Exact date match in priority order
    d_exact AS (
      SELECT ad.id, ad.day_utc, ad.user_id, 0 AS tier, 0 AS date_distance
      FROM astro.auspicious_day ad
      JOIN wanted w ON w.user_id = ad.user_id
      WHERE ad.zodiac_sign = $1
        AND ad.day_utc = $2::date
        AND ad.day_offset = $3
      ORDER BY
        CASE ad.user_id
          WHEN $4      THEN 0
          WHEN ''      THEN 1
          WHEN 'guest' THEN 2
          ELSE 99
        END
      LIMIT 1
    ),

    -- (B) Nearest date within ±3 days if exact not found
    d_near AS (
      SELECT ad.id, ad.day_utc, ad.user_id, 1 AS tier,
             ABS( (ad.day_utc - $2::date) ) AS date_distance
      FROM astro.auspicious_day ad
      JOIN wanted w ON w.user_id = ad.user_id
      WHERE ad.zodiac_sign = $1
        AND ad.day_offset = $3
        AND ad.day_utc BETWEEN ($2::date - INTERVAL '3 day') AND ($2::date + INTERVAL '3 day')
      ORDER BY
        CASE ad.user_id
          WHEN $4      THEN 0
          WHEN ''      THEN 1
          WHEN 'guest' THEN 2
          ELSE 99
        END,
        ABS( (ad.day_utc - $2::date) )
      LIMIT 1
    ),

    -- (C) Latest available if still nothing
    d_latest AS (
      SELECT ad.id, ad.day_utc, ad.user_id, 2 AS tier, 9999::integer AS date_distance
      FROM astro.auspicious_day ad
      JOIN wanted w ON w.user_id = ad.user_id
      WHERE ad.zodiac_sign = $1
        AND ad.day_offset = $3
      ORDER BY
        CASE ad.user_id
          WHEN $4      THEN 0
          WHEN ''      THEN 1
          WHEN 'guest' THEN 2
          ELSE 99
        END,
        ad.day_utc DESC
      LIMIT 1
    ),

    -- Choose the first available source: exact -> near -> latest
    d AS (
      SELECT * FROM d_exact
      UNION ALL SELECT * FROM d_near   WHERE NOT EXISTS (SELECT 1 FROM d_exact)
      UNION ALL SELECT * FROM d_latest WHERE NOT EXISTS (SELECT 1 FROM d_exact) AND NOT EXISTS (SELECT 1 FROM d_near)
      LIMIT 1
    ),

    wins AS (
      SELECT jsonb_agg(
        jsonb_build_object(
          'start',   w.start_utc,
          'end',     w.end_utc,
          'score',   w.max_score,
          'kind',    w.kind,
          'planets', (SELECT jsonb_agg(p.planet ORDER BY p.planet)
                      FROM astro.auspicious_window_planet p
                      WHERE p.window_id = w.id),
          'reason',  w.reason
        )
        ORDER BY w.start_utc
      ) AS arr
      FROM astro.auspicious_window w
      JOIN d ON d.id = w.day_id
    ),

    pk AS (
      SELECT to_jsonb(x) AS obj
      FROM (
        SELECT w.start_utc "start", w.end_utc "end", w.max_score AS score, w.kind,
               (SELECT jsonb_agg(p.planet ORDER BY p.planet)
                FROM astro.auspicious_window_planet p
                WHERE p.window_id = w.id) AS planets,
               w.reason
        FROM astro.auspicious_window w
        JOIN d ON d.id = w.day_id
        ORDER BY w.max_score DESC, w.start_utc
        LIMIT 1
      ) x
    ),

    tags AS (
      SELECT jsonb_agg(t.tag ORDER BY t.tag) AS arr
      FROM astro.auspicious_tag t
      JOIN d ON d.id = t.day_id
    )

    SELECT jsonb_build_object(
      'dateISO',     (SELECT day_utc FROM d),  -- will be the chosen row’s date
      'hourlyScores', COALESCE(
        (
          SELECT jsonb_agg(h.score::int ORDER BY h.hour_of_day)
          FROM astro.auspicious_hourly h
          JOIN d ON d.id = h.day_id
        ),
        '[]'::jsonb
      ),
      'windows', COALESCE((SELECT arr FROM wins), '[]'::jsonb),
      'peak',    COALESCE((SELECT obj FROM pk),  'null'::jsonb),
      'tags',    COALESCE((SELECT arr FROM tags),'[]'::jsonb)
    ) AS payload;
  `;

  const { rows } = await pool.query(q, [sign, dayISO, dayOffset, userId || '']);
  const payload = rows[0]?.payload ?? null;
  return payload;
}


