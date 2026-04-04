// routes/adminApiJobs.route.js
import express from 'express';
import axios from 'axios';
import { query } from '../src/db.js';

const router = express.Router();
const SELF_API_BASE = process.env.SELF_API_BASE || 'http://localhost:4000';

/* small helper */
function isStatusSuccess(statusCode) {
  return statusCode >= 200 && statusCode < 300;
}

/* ──────────────────────────────────────────────
 * GET all API jobs
 * GET /api/admin/api-jobs
 * ────────────────────────────────────────────── */
router.get('/api-jobs', async (_req, res) => {
  try {
    const { rows } = await query('SELECT * FROM usp_api_job_get_all()');
    // rows are your jobs; frontend adds lastRun* in memory after a run
    res.json({ ok: true, data: rows });
  } catch (err) {
    console.error('[api-jobs:get]', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

/* ──────────────────────────────────────────────
 * POST create or update job (upsert)
 * POST /api/admin/api-jobs
 * body: { job_id?, job_code, display_name, http_method, base_url, relative_path,
 *         payload_template, headers_template, is_enabled, notes }
 * ────────────────────────────────────────────── */
router.post('/api-jobs', async (req, res) => {
  try {
    const {
      job_id,
      job_code,
      display_name,
      http_method,
      base_url,
      relative_path,
      payload_template,
      headers_template,
      is_enabled,
      notes,
    } = req.body || {};

    const sql = `
      SELECT *
      FROM usp_api_job_upsert(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
      )
    `;
    const vals = [
      job_id || null,
      job_code,
      display_name,
      http_method || 'POST',
      base_url || null,
      relative_path,
      payload_template || null,
      headers_template || null,
      typeof is_enabled === 'boolean' ? is_enabled : true,
      notes || null,
    ];

    const { rows } = await query(sql, vals);
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('[api-jobs:upsert]', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

/* ──────────────────────────────────────────────
 * DELETE job
 * DELETE /api/admin/api-jobs/:id
 * ────────────────────────────────────────────── */
router.delete('/api-jobs/:id', async (req, res) => {
  try {
    const jobId = Number(req.params.id || 0);
    if (!jobId) {
      return res.status(400).json({ ok: false, error: 'invalid_job_id' });
    }

    await query('SELECT usp_api_job_delete($1)', [jobId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[api-jobs:delete]', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

/* ──────────────────────────────────────────────
 * Helper: build dynamic payload for FreeAstro jobs
 *  - planets/range  → periods (today, next7, next30, year…)
 *  - houses         → single date (iso)
 *  - houses/range   → weekly / monthly / yearly using periods
 *  - aspects        → single date (iso)
 *  - aspects/range  → weekly / monthly / yearly using periods
 *  - fallback       → at least baseIso
 * ────────────────────────────────────────────── */
function buildDynamicPayload(job, basePayload = {}) {
  const payload = { ...(basePayload || {}) };

  const code = String(job.job_code || '').toUpperCase().trim();
  const path = String(job.relative_path || '').toLowerCase().trim();
  const now = new Date();

  const hasPeriods =
    Array.isArray(payload.periods) && payload.periods.length > 0;

  const isPlanetsRange = path.includes('/planets/range');
  const isHousesRange = path.includes('/houses/range');
  const isHousesSingle = path.includes('/houses') && !isHousesRange;
  const isAspectsRange = path.includes('/aspects/range');
  const isAspectsSingle = path.includes('/aspects') && !isAspectsRange;

  function ensureBaseIso() {
    if (!payload.baseIso) {
      payload.baseIso = now.toISOString();
    }
  }

  function ensurePeriods(defaultPeriod) {
    if (!hasPeriods) {
      payload.periods = [defaultPeriod];
    }
  }

  function ensureIso() {
    if (!payload.iso) {
      payload.iso = now.toISOString();
    }
  }

  // ============= PLANETS RANGE (existing behaviour) =============
  if (isPlanetsRange) {
    ensureBaseIso();

    if (!hasPeriods) {
      if (code.includes('TODAY_ONLY')) {
        ensurePeriods('today');
      } else if (code.includes('YESTERDAY_ONLY')) {
        ensurePeriods('yesterday');
      } else if (code.includes('TOMORROW_ONLY')) {
        ensurePeriods('tomorrow');
      } else if (
        code.includes('WEEKLY') ||
        code.includes('NEXT7') ||
        code.includes('WEEK')
      ) {
        ensurePeriods('next7');
      } else if (
        code.includes('MONTHLY') ||
        code.includes('NEXT30') ||
        code.includes('MONTH')
      ) {
        ensurePeriods('next30');
      } else if (code.includes('YEARLY') || code.includes('YEAR')) {
        ensurePeriods('year');
      } else if (code.includes('FREEASTRO_TODAY')) {
        // special: your TODAY job that actually fetches tomorrow
        ensurePeriods('tomorrow');
      } else if (code.includes('FREEASTRO_YESTERDAY')) {
        ensurePeriods('yesterday');
      } else if (code.includes('FREEASTRO_TOMORROW')) {
        ensurePeriods('tomorrow');
      } else if (
        code.includes('FREEASTRO_WEEK') ||
        code.includes('FREEASTRO_NEXT7')
      ) {
        ensurePeriods('next7');
      }
    }

    return payload;
  }

  // ============= HOUSES RANGE (/western/houses/range) ===========
  if (isHousesRange) {
    ensureBaseIso();

    let periods = hasPeriods
      ? payload.periods.map((p) => String(p).toLowerCase())
      : [];

    if (!periods.length) {
      if (
        code.includes('WEEKLY') ||
        code.includes('NEXT7') ||
        code.includes('WEEK')
      ) {
        periods = ['weekly'];
      } else if (
        code.includes('MONTHLY') ||
        code.includes('NEXT30') ||
        code.includes('MONTH')
      ) {
        periods = ['monthly'];
      } else if (code.includes('YEARLY') || code.includes('YEAR')) {
        periods = ['year'];
      } else if (code.includes('YESTERDAY')) {
        periods = ['yesterday'];
      } else if (code.includes('TOMORROW')) {
        periods = ['tomorrow'];
      } else {
        periods = ['today'];
      }
    }

    payload.periods = periods;
    return payload;
  }

  // ============= HOUSES SINGLE-DATE (/western/houses) ===========
  if (isHousesSingle) {
    ensureIso();
    return payload;
  }

  // ============= ASPECTS RANGE (/western/aspects/range) =========
  if (isAspectsRange) {
    ensureBaseIso();

    let periods = hasPeriods
      ? payload.periods.map((p) => String(p).toLowerCase())
      : [];

    if (!periods.length) {
      if (
        code.includes('WEEKLY') ||
        code.includes('NEXT7') ||
        code.includes('WEEK')
      ) {
        periods = ['weekly'];
      } else if (
        code.includes('MONTHLY') ||
        code.includes('NEXT30') ||
        code.includes('MONTH')
      ) {
        periods = ['monthly'];
      } else if (code.includes('YEARLY') || code.includes('YEAR')) {
        periods = ['year'];
      } else if (code.includes('YESTERDAY')) {
        periods = ['yesterday'];
      } else if (code.includes('TOMORROW')) {
        periods = ['tomorrow'];
      } else {
        periods = ['today'];
      }
    }

    payload.periods = periods;
    return payload;
  }

  // ============= ASPECTS SINGLE-DATE (/western/aspects) =========
  if (isAspectsSingle) {
    ensureIso();
    return payload;
  }

  // ============= generic fallback ===============================
  if (!payload.baseIso && !payload.iso) {
    payload.baseIso = now.toISOString();
  }

  return payload;
}

/* ──────────────────────────────────────────────
 * RUN NOW
 * POST /api/admin/api-jobs/:id/run
 * ────────────────────────────────────────────── */
router.post('/api-jobs/:id/run', async (req, res) => {
  const jobId = Number(req.params.id || 0);

  if (!jobId) {
    return res.status(400).json({ ok: false, error: 'invalid_job_id' });
  }

  let startedAt = new Date();

  try {
    const { rows } = await query('SELECT * FROM app_api_job WHERE job_id = $1', [
      jobId,
    ]);
    if (!rows || !rows.length) {
      return res.status(404).json({ ok: false, error: 'job_not_found' });
    }

    const job = rows[0];
    if (!job.is_enabled) {
      return res.status(400).json({ ok: false, error: 'job_disabled' });
    }

    const method = (job.http_method || 'POST').toUpperCase();
    const baseUrl = job.base_url || SELF_API_BASE;
    const path = job.relative_path || '/';
    const url = `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;

    // base payload from DB
    let basePayload = {};
    if (job.payload_template && typeof job.payload_template === 'object') {
      basePayload = job.payload_template;
    }

    // apply dynamic rules
    const payload = buildDynamicPayload(job, basePayload);

    const extraHeaders =
      job.headers_template && typeof job.headers_template === 'object'
        ? job.headers_template
        : {};

    console.log('[api-jobs:run] job', job.job_code, '→', method, url);
    console.log('[api-jobs:run] payload:', JSON.stringify(payload));

    startedAt = new Date();

    const axiosConfig = {
      method,
      url,
      headers: {
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
      data: ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
        ? payload
        : undefined,
    };

    // ── Special handling: YEARLY range endpoints should generate daily data (365/366)
    const pathLower = String(path).toLowerCase();
    const isPlanetsRange = pathLower.includes('/planets/range');
    const isAspectsRange = pathLower.includes('/aspects/range');
    const isHousesRange = pathLower.includes('/houses/range');

    const periods = Array.isArray(payload.periods)
      ? payload.periods.map((p) => String(p).toLowerCase())
      : [];

    const isYearRequest = periods.includes('year');

    if ((isPlanetsRange || isAspectsRange || isHousesRange) && isYearRequest) {
      const baseDateUtc = utcMidnight(
        new Date(payload.baseIso || new Date().toISOString())
      );
      const yearUtc = baseDateUtc.getUTCFullYear();
      const total = daysInYear(yearUtc);

      const THROTTLE_MS = Number(process.env.YEARLY_THROTTLE_MS || 50);

      console.log(
        `[api-jobs:run] YEAR EXPAND: ${job.job_code} -> ${total} daily calls for year ${yearUtc} (${pathLower})`
      );

      const dailyResults = [];
      let lastStatusCode = 200;

      for (let i = 0; i < total; i++) {
        const day = addDaysUtc(baseDateUtc, i);
        const dayIso = day.toISOString();

        const dayPayload = {
          ...payload,
          baseIso: dayIso,
          // IMPORTANT: force single-day snapshot
          periods: ['today'],
        };

        const dayResp = await axios({
          ...axiosConfig,
          data: dayPayload,
        });

        lastStatusCode = dayResp.status;

        dailyResults.push({
          date: dayIso.slice(0, 10),
          baseIso: dayIso,
          data: dayResp.data,
        });

        if (THROTTLE_MS > 0) await sleep(THROTTLE_MS);
      }

      const finishedAt = new Date();
      const statusCode = lastStatusCode;
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      const durationSec = durationMs / 1000;

      const combined = {
        ok: true,
        mode: 'year_daily',
        endpoint: pathLower,
        baseIso: baseDateUtc.toISOString(),
        periods: ['year'],
        daysCount: total,
        days: dailyResults,
      };

      const statusText = JSON.stringify({
        ok: true,
        mode: 'year_daily',
        endpoint: pathLower,
        daysCount: total,
      }).slice(0, 500);

      const logSql = `SELECT * FROM usp_api_job_log_run($1,$2,$3,$4,$5)`;
      const logVals = [jobId, statusCode, statusText, startedAt, finishedAt];
      const logResult = await query(logSql, logVals);
      const rawLog = logResult.rows[0] || null;

      const runLog = rawLog
        ? {
            ...rawLog,
            is_success: true,
            duration_ms: durationMs,
            started_at: rawLog.started_at || startedAt,
            finished_at: rawLog.finished_at || finishedAt,
          }
        : {
            is_success: true,
            duration_ms: durationMs,
            status_code: statusCode,
            status_text: statusText,
            started_at: startedAt,
            finished_at: finishedAt,
          };

      return res.json({
        ok: true,
        statusCode,
        statusText,
        durationMs,
        durationSec,
        data: combined,
        runLog,
      });
    }

    // ── normal (non-year) call
    const resp = await axios(axiosConfig);

    const finishedAt = new Date();
    const statusCode = resp.status;
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    const durationSec = durationMs / 1000;

    const statusText =
      typeof resp.data === 'object'
        ? JSON.stringify(resp.data).slice(0, 500)
        : String(resp.statusText || '').slice(0, 500);

    const success = isStatusSuccess(statusCode);

    // Log run with timing
    const logSql = `SELECT * FROM usp_api_job_log_run($1,$2,$3,$4,$5)`;
    const logVals = [jobId, statusCode, statusText, startedAt, finishedAt];
    const logResult = await query(logSql, logVals);
    const rawLog = logResult.rows[0] || null;

    const runLog = rawLog
      ? {
          ...rawLog,
          is_success:
            typeof rawLog.is_success === 'boolean' ? rawLog.is_success : success,
          duration_ms:
            typeof rawLog.duration_ms === 'number' ? rawLog.duration_ms : durationMs,
          started_at: rawLog.started_at || startedAt,
          finished_at: rawLog.finished_at || finishedAt,
        }
      : {
          is_success: success,
          duration_ms: durationMs,
          status_code: statusCode,
          status_text: statusText,
          started_at: startedAt,
          finished_at: finishedAt,
        };

    res.json({
      ok: true,
      statusCode,
      statusText,
      durationMs,
      durationSec,
      data: resp.data,
      runLog,
    });
  } catch (err) {
    console.error('[api-jobs:run error]', err?.response?.data || err);

    const finishedAt = new Date();
    const statusCode = err?.response?.status || 500;
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    const durationSec = durationMs / 1000;

    const statusText = JSON.stringify(
      err?.response?.data || { error: err.message || 'unknown' }
    ).slice(0, 500);

    // ensure we log failures too
    let runLog = null;
    try {
      const { rows: logRows } = await query(
        'SELECT * FROM usp_api_job_log_run($1,$2,$3,$4,$5)',
        [jobId, statusCode, statusText, startedAt, finishedAt]
      );
      const rawLog = logRows[0] || null;
      runLog = rawLog
        ? {
            ...rawLog,
            is_success:
              typeof rawLog.is_success === 'boolean' ? rawLog.is_success : false,
            duration_ms:
              typeof rawLog.duration_ms === 'number'
                ? rawLog.duration_ms
                : durationMs,
            started_at: rawLog.started_at || startedAt,
            finished_at: rawLog.finished_at || finishedAt,
          }
        : {
            is_success: false,
            duration_ms: durationMs,
            status_code: statusCode,
            status_text: statusText,
            started_at: startedAt,
            finished_at: finishedAt,
          };
    } catch (e2) {
      console.error('[api-jobs:run log-fail]', e2);
      runLog = {
        is_success: false,
        duration_ms: durationMs,
        status_code: statusCode,
        status_text: statusText,
        started_at: startedAt,
        finished_at: finishedAt,
      };
    }

    res.status(502).json({
      ok: false,
      error: 'run_failed',
      statusCode,
      statusText,
      durationMs,
      durationSec,
      runLog,
      detail: err?.response?.data || err.message || String(err),
    });
  }
});

// ───────────────────────────────────────────────
// YEAR HELPERS (kept same as your existing logic)
// ───────────────────────────────────────────────

function utcMidnight(d) {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0)
  );
}

function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInYear(y) {
  return isLeapYear(y) ? 366 : 365;
}

function addDaysUtc(dateUtc, days) {
  const d = new Date(dateUtc);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default router;
