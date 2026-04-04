// jobs/PlanetsScheduler.js
import cron from 'node-cron';
import axios from 'axios';

// ───────────────────────────────────────────────
// ENV CONFIG
// ───────────────────────────────────────────────

const SELF_API_BASE = process.env.SELF_API_BASE; // e.g. http://localhost:4000

// Optional throttling so you don't overload your own API on yearly runs
const YEARLY_THROTTLE_MS = Number(process.env.YEARLY_THROTTLE_MS || 50); // small delay between calls
const YEARLY_LOG_EVERY = Number(process.env.YEARLY_LOG_EVERY || 15); // log every N days processed

if (!SELF_API_BASE) {
  console.warn(
    '[FreeAstroSched] SELF_API_BASE is not set in env. ' +
      'Scheduler will NOT be able to call your own API.'
  );
}

// ───────────────────────────────────────────────
// UTC HELPERS
// ───────────────────────────────────────────────

/** Returns a Date at 00:00:00.000Z for the given Date */
function utcMidnight(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

/** Adds N days in UTC (safe for DST because we operate in UTC) */
function addDaysUtc(dateUtc, days) {
  const d = new Date(dateUtc);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/** Inclusive list of UTC-midnight dates between start and end */
function listDaysUtcInclusive(startUtc, endUtc) {
  const out = [];
  let cur = utcMidnight(startUtc);
  const end = utcMidnight(endUtc);

  while (cur <= end) {
    out.push(new Date(cur));
    cur = addDaysUtc(cur, 1);
  }
  return out;
}

/** Sleep helper */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ───────────────────────────────────────────────
// API CALLER
// ───────────────────────────────────────────────

/**
 * Calls your existing route once:
 *   POST /api/freeastro/western/planets/range
 */
async function callPlanetsRange({ label, baseIso, periods }) {
  if (!SELF_API_BASE) {
    console.error(
      `[FreeAstroSched] ${label}: SELF_API_BASE is missing – aborting job.`
    );
    return;
  }

  const url = `${SELF_API_BASE}/api/freeastro/western/planets/range`;
  const body = { baseIso, periods };

  try {
    const res = await axios.post(url, body);
    console.log(`[FreeAstroSched] ${label}: HTTP ${res.status} baseIso=${baseIso}`);
  } catch (err) {
    console.error(
      `[FreeAstroSched] ${label}: error calling planets/range baseIso=${baseIso}`,
      err?.response?.data || err.message || err
    );
  }
}

// ───────────────────────────────────────────────
// YEARLY FIX: expand "year" into daily calls (365/366)
// ───────────────────────────────────────────────

async function runYearDailyLoop({ label, yearUtc }) {
  // Build Jan 1 .. Dec 31 (inclusive) at 00:00Z
  const jan1 = new Date(Date.UTC(yearUtc, 0, 1, 0, 0, 0, 0));
  const dec31 = new Date(Date.UTC(yearUtc, 11, 31, 0, 0, 0, 0));
  const days = listDaysUtcInclusive(jan1, dec31);

  console.log(
    `[FreeAstroSched] ${label}: expanding 'year' into ${days.length} daily calls (UTC) for year=${yearUtc}`
  );

  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const baseIso = d.toISOString();

    // For a single-day snapshot, we request "today" relative to baseIso (your API already supports it)
    await callPlanetsRange({
      label: `${label} day=${i + 1}/${days.length}`,
      baseIso,
      periods: ['today'],
    });

    if ((i + 1) % YEARLY_LOG_EVERY === 0) {
      console.log(
        `[FreeAstroSched] ${label}: progress ${(i + 1)}/${days.length} (last=${baseIso})`
      );
    }

    if (YEARLY_THROTTLE_MS > 0) {
      await sleep(YEARLY_THROTTLE_MS);
    }
  }

  console.log(`[FreeAstroSched] ${label}: completed yearly daily loop ✅`);
}

// ───────────────────────────────────────────────
// SHARED RUNNER
// ───────────────────────────────────────────────

/**
 * Wrapper. If periods includes 'year', it expands to daily calls (365/366).
 * Otherwise it calls the API once (as before).
 */
async function runRangeJobForAllSigns({ label, baseIso, periods }) {
  // Always normalize baseIso to UTC midnight for consistency
  const baseDate = utcMidnight(new Date(baseIso));

  if (periods?.includes('year')) {
    const yearUtc = baseDate.getUTCFullYear();
    return runYearDailyLoop({ label, yearUtc });
  }

  return callPlanetsRange({
    label,
    baseIso: baseDate.toISOString(),
    periods,
  });
}

// ───────────────────────────────────────────────
// DATE HELPERS
// ───────────────────────────────────────────────

/** Check if given date is the last day of its month (UTC-safe) */
function isLastDayOfMonth(d = new Date()) {
  const utc = utcMidnight(d);
  const tomorrow = addDaysUtc(utc, 1);
  return tomorrow.getUTCMonth() !== utc.getUTCMonth();
}

// ───────────────────────────────────────────────
// CRON SCHEDULES
// ───────────────────────────────────────────────

/**
 * 1) DAILY – yesterday, today, tomorrow
 *    00:10 every day (server cron time), but baseIso forced to UTC midnight.
 */
cron.schedule('0 10 0 * * *', () => {
  const baseIso = utcMidnight(new Date()).toISOString();
  const periods = ['yesterday', 'today', 'tomorrow'];

  console.log('[FreeAstroSched] Daily job triggered');
  runRangeJobForAllSigns({
    label: 'daily(yesterday,today,tomorrow)',
    baseIso,
    periods,
  });
});

/**
 * 2) WEEKLY – next7
 *    Monday at 01:00
 */
cron.schedule('0 0 1 * * 1', () => {
  const baseIso = utcMidnight(new Date()).toISOString();
  const periods = ['next7'];

  console.log('[FreeAstroSched] Weekly job (next7) triggered');
  runRangeJobForAllSigns({
    label: 'weekly(next7)',
    baseIso,
    periods,
  });
});

/**
 * 3) MONTHLY – next30 for NEXT month
 *    Run every day at 02:00; only execute on LAST day of month.
 *    baseIso = first day of next month (00:00 UTC)
 */
cron.schedule('0 0 2 * * *', () => {
  const now = new Date();

  if (!isLastDayOfMonth(now)) {
    return;
  }

  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-based
  const firstOfNext = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));

  const baseIso = firstOfNext.toISOString();
  const periods = ['next30'];

  console.log('[FreeAstroSched] Monthly job (next30 for next month) triggered');
  runRangeJobForAllSigns({
    label: 'monthly(next30-for-next-month)',
    baseIso,
    periods,
  });
});

/**
 * 4) YEARLY – year
 *    Dec 31 at 03:00
 *    baseIso = Jan 1 of NEXT year (00:00 UTC)
 *    ✅ NOW expands to 365/366 daily API calls
 */
cron.schedule('0 0 3 31 12 *', () => {
  const now = new Date();
  const nextYear = now.getUTCFullYear() + 1;
  const jan1Next = new Date(Date.UTC(nextYear, 0, 1, 0, 0, 0, 0));

  const baseIso = jan1Next.toISOString();
  const periods = ['year'];

  console.log('[FreeAstroSched] Yearly job (year for next year) triggered');
  runRangeJobForAllSigns({
    label: 'yearly(year-for-next-year)',
    baseIso,
    periods,
  });
});

// ───────────────────────────────────────────────
// MANUAL TRIGGER HELPERS
// ───────────────────────────────────────────────

async function runDailyJobNow() {
  const baseIso = utcMidnight(new Date()).toISOString();
  const periods = ['yesterday', 'today', 'tomorrow'];
  return runRangeJobForAllSigns({
    label: 'manual-daily(yesterday,today,tomorrow)',
    baseIso,
    periods,
  });
}

async function runWeeklyJobNow() {
  const baseIso = utcMidnight(new Date()).toISOString();
  const periods = ['next7'];
  return runRangeJobForAllSigns({
    label: 'manual-weekly(next7)',
    baseIso,
    periods,
  });
}

async function runMonthlyJobNow() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const firstOfNext = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));
  const baseIso = firstOfNext.toISOString();
  const periods = ['next30'];

  return runRangeJobForAllSigns({
    label: 'manual-monthly(next30-for-next-month)',
    baseIso,
    periods,
  });
}

async function runYearlyJobNow() {
  const now = new Date();
  const nextYear = now.getUTCFullYear() + 1;
  const jan1Next = new Date(Date.UTC(nextYear, 0, 1, 0, 0, 0, 0));
  const baseIso = jan1Next.toISOString();
  const periods = ['year'];

  return runRangeJobForAllSigns({
    label: 'manual-yearly(year-for-next-year)',
    baseIso,
    periods,
  });
}

// ───────────────────────────────────────────────
// EXPORTS + LOG
// ───────────────────────────────────────────────

export {
  runRangeJobForAllSigns,
  runDailyJobNow,
  runWeeklyJobNow,
  runMonthlyJobNow,
  runYearlyJobNow,
};

console.log(
  `[FreeAstroSched] Scheduler loaded. SELF_API_BASE="${
    SELF_API_BASE || 'NOT SET'
  }"`
);
