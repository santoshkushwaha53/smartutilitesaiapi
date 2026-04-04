// routes/horoscope.read.table.route.js
// Read-only endpoint that pivots topics into UI-friendly columns.
// Works for: today/tomorrow/today (from horoscope_generic) and weekly/monthly/yearly (from astro_prediction)

import { Router } from 'express';
import { query } from '../src/db.js';

const router = Router();

async function getSignId(signCode) {
  const r = await query('SELECT id FROM zodiac_sign WHERE code = $1', [String(signCode).toLowerCase()]);
  if (!r.rows.length) throw new Error('invalid sign');
  return r.rows[0].id;
}

// If user asks "today", try both 'today' and 'today' so we can find cached rows.
function periodCandidates(p) {
  const v = String(p).toLowerCase();
  if (v === 'today') return ['today', 'today'];
  if (v === 'today') return ['today', 'today'];
  if (v === 'tomorrow') return ['tomorrow'];
  return [v];
}

async function findLatestDate(sign_id, system, periods, lang) {
  const r = await query(
    `SELECT valid_from::date AS d
       FROM horoscope_generic
      WHERE sign_id=$1 AND system=$2 AND period = ANY($3) AND lang=$4
      GROUP BY valid_from
      ORDER BY valid_from DESC
      LIMIT 1`,
    [sign_id, system, periods, lang]
  );
  return r.rows.length ? r.rows[0].d : null;
}

router.get('/read/table', async (req, res) => {
  try {
    const sign = String(req.query.sign || 'leo').toLowerCase();
    const system = String(req.query.system || 'vedic').toLowerCase();        // 'vedic' | 'western'
    const period = String(req.query.period || 'today').toLowerCase();        // today|tomorrow|today|weekly|monthly|yearly
    const lang = String(req.query.lang || 'en').toLowerCase();
    const date = req.query.date || new Date().toISOString().slice(0, 10);

    const sign_id = await getSignId(sign);

    // --- today / TODAY / TOMORROW (pivot from horoscope_generic) ---
    if (['today', 'tomorrow', 'today'].includes(period)) {
      const periods = periodCandidates(period);
      const sqlPivot = `
        WITH base AS (
          SELECT topic, text
            FROM horoscope_generic
           WHERE sign_id=$1 AND system=$2 AND period = ANY($3)
             AND valid_from=$4::date AND lang=$5
        )
        SELECT
          -- summary
          max(text) FILTER (WHERE topic='general')         AS today_horoscope,
          -- love
          max(text) FILTER (WHERE topic='love')            AS love_text,
          COALESCE((regexp_match(max(text) FILTER (WHERE topic='love'), '([0-9]{1,3})%'))[1]::int, NULL) AS love_percent,
          -- career / job / business
          max(text) FILTER (WHERE topic='career')          AS career_text,
          COALESCE(max(text) FILTER (WHERE topic='job'),
                   max(text) FILTER (WHERE topic='career')) AS job_text,
          COALESCE(max(text) FILTER (WHERE topic='business'),
                   max(text) FILTER (WHERE topic='money'))  AS business_text,
          -- money / relationships / numerology
          max(text) FILTER (WHERE topic='money')           AS money_text,
          max(text) FILTER (WHERE topic='relationships')   AS relationships_text,
          max(text) FILTER (WHERE topic='numerology')      AS numerology_text,
          -- lucky fields
          max(text) FILTER (WHERE topic='lucky_color')     AS lucky_color,
          COALESCE(
            NULLIF(regexp_replace(COALESCE(max(text) FILTER (WHERE topic='lucky_number'), ''), '\\D+', '', 'g'), '')::int,
            NULL
          ) AS lucky_number
        FROM base;`;

      let resolvedDate = date;
      let r = await query(sqlPivot, [sign_id, system, periods, resolvedDate, lang]);
      let row = r.rows[0] || {};
      const allNull = Object.values(row).every(v => v == null);

      // If nothing for the requested date, fall back to the latest cached date we have.
      if (allNull) {
        const latest = await findLatestDate(sign_id, system, periods, lang);
        if (latest) {
          resolvedDate = latest;
          r = await query(sqlPivot, [sign_id, system, periods, resolvedDate, lang]);
          row = r.rows[0] || {};
        }
      }

      return res.json({
        sign, system, period,
        requested_date: date,
        resolved_date: resolvedDate,
        ...row
      });
    }

    // --- WEEKLY / MONTHLY / YEARLY (latest per topic from astro_prediction, then pivot) ---
    const sqlWin = `
      WITH latest AS (
        SELECT DISTINCT ON (p.topic)
               p.topic, p.text, p.created_at
          FROM astro_prediction p
          JOIN astro_raw_event are ON are.id = p.raw_event_id
         WHERE are.sign_id=$1 AND are.system=$2
           AND p.period=$3
           AND p.audience_scope='generic'
           AND p.lang=$4
         ORDER BY p.topic, p.created_at DESC
      )
      SELECT
        max(text) FILTER (WHERE topic='general')         AS today_horoscope,
        max(text) FILTER (WHERE topic='love')            AS love_text,
        COALESCE((regexp_match(max(text) FILTER (WHERE topic='love'), '([0-9]{1,3})%'))[1]::int, NULL) AS love_percent,
        max(text) FILTER (WHERE topic='career')          AS career_text,
        COALESCE(max(text) FILTER (WHERE topic='job'),
                 max(text) FILTER (WHERE topic='career')) AS job_text,
        COALESCE(max(text) FILTER (WHERE topic='business'),
                 max(text) FILTER (WHERE topic='money'))  AS business_text,
        max(text) FILTER (WHERE topic='money')           AS money_text,
        max(text) FILTER (WHERE topic='relationships')   AS relationships_text,
        max(text) FILTER (WHERE topic='numerology')      AS numerology_text,
        max(text) FILTER (WHERE topic='lucky_color')     AS lucky_color,
        COALESCE(
          NULLIF(regexp_replace(COALESCE(max(text) FILTER (WHERE topic='lucky_number'), ''), '\\D+', '', 'g'), '')::int,
          NULL
        ) AS lucky_number
      FROM latest;`;

    const r = await query(sqlWin, [sign_id, system, period, lang]);
    const row = r.rows[0] || {};
    return res.json({ sign, system, period, ...row });

  } catch (e) {
    console.error('read/table error', e);
    return res.status(400).json({ error: String(e?.message || e) });
  }
});

export default router;
