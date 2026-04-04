// jobs/AspectsScheduler.js
import cron from 'node-cron';
import axios from 'axios';

// ───────────────────────────────────────────────
// ENV CONFIG
// ───────────────────────────────────────────────

const SELF_API_BASE = process.env.SELF_API_BASE; // e.g. http://localhost:4000
const DEFAULT_COORDS =
  process.env.FREEASTRO_DEFAULT_COORDS || '3.1390,101.6869';
const DEFAULT_LANG = 'en';

// Optional throttle to avoid hammering your own API on yearly runs
const YEARLY_THROTTLE_MS = Number(process.env.YEARLY_THROTTLE_MS || 50);

if (!SELF_API_BASE) {
  console.warn(
    '[AspectsSched] SELF_API_BASE is not set in env. ' +
      'Scheduler will NOT be able to call your own API.'
  );
}

// ───────────────────────────────────────────────
// DATE HELPERS
// ───────────────────────────────────────────────

function shiftIsoDays(baseIso, days) {
  const dt = new Date(baseIso);
  if (Number.isNaN(dt.getTime())) {
    throw new Error(`Invalid baseIso: ${baseIso}`);
  }
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString();
}

function shiftIsoMonths(baseIso, months) {
  const dt = new Date(baseIso);
  if (Number.isNaN(dt.getTime())) {
    throw new Error(`Invalid baseIso: ${baseIso}`);
  }
  dt.setUTCMonth(dt.getUTCMonth() + months);
  return dt.toISOString();
}

/** Check if given date is the last day of its month */
function isLastDayOfMonth(d = new Date()) {
  const tomorrow = new Date(d);
  tomorrow.setDate(d.getDate() + 1);
  return tomorrow.getMonth() !== d.getMonth();
}

/** Build ISO dates for every day in the month of baseIso */
function buildMonthIsoList(baseIso) {
  const base = new Date(baseIso);
  if (Number.isNaN(base.getTime())) {
    throw new Error(`Invalid baseIso: ${baseIso}`);
  }

  const year = base.getUTCFullYear();
  const month = base.getUTCMonth(); // 0-based

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

/** Leap year check */
function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0);
}

/**
 * Build ISO dates for every day in the year of baseIso (365/366)
 * Uses UTC midnight for consistency.
 */
function buildYearIsoList(baseIso) {
  const base = new Date(baseIso);
  if (Number.isNaN(base.getTime())) {
    throw new Error(`Invalid baseIso: ${baseIso}`);
  }

  const year = base.getUTCFullYear();
  const totalDays = isLeapYear(year) ? 366 : 365;

  const start = new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0)); // Jan 1, 00:00 UTC

  const result = [];
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    result.push(d.toISOString());
  }
  return result;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────────────────────────
// API CALLER (single aspects call)
// ───────────────────────────────────────────────

/**
 * Calls your existing route once:
 *   POST /api/freeastro/western/aspects
 */
async function callAspectsOnce({
  label,
  iso,
  coords = DEFAULT_COORDS,
  lang = DEFAULT_LANG,
  extraOptions = {},
}) {
  if (!SELF_API_BASE) {
    console.error(
      `[AspectsSched] ${label}: SELF_API_BASE is missing – aborting job.`
    );
    return;
  }

  const url = `${SELF_API_BASE}/api/freeastro/western/aspects`;
  const body = {
    iso,
    coords,
    lang,
    ...extraOptions, // e.g. excludePlanets, allowedAspects, orbValues
  };

  console.log(
    `[AspectsSched] ${label}: calling western/aspects iso=${iso} coords=${coords}`
  );

  try {
    const res = await axios.post(url, body);
    console.log(
      `[AspectsSched] ${label}: HTTP ${res.status} from western/aspects`
    );
  } catch (err) {
    console.error(
      `[AspectsSched] ${label}: error calling western/aspects`,
      err?.response?.data || err.message || err
    );
  }
}

// ───────────────────────────────────────────────
// CRON SCHEDULES
// ───────────────────────────────────────────────

/**
 * 1) DAILY – yesterday, today, tomorrow
 *    e.g. 00:10 every day server time
 */
cron.schedule('0 10 0 * * *', async () => {
  const baseIso = new Date().toISOString();

  console.log('[AspectsSched] Daily job triggered');

  const isoYesterday = shiftIsoDays(baseIso, -1);
  const isoToday = baseIso;
  const isoTomorrow = shiftIsoDays(baseIso, +1);

  await callAspectsOnce({
    label: 'daily:yesterday',
    iso: isoYesterday,
  });

  await callAspectsOnce({
    label: 'daily:today',
    iso: isoToday,
  });

  await callAspectsOnce({
    label: 'daily:tomorrow',
    iso: isoTomorrow,
  });
});

/**
 * 2) WEEKLY – next7
 *    Cron: every Monday at 01:00
 */
cron.schedule('0 0 1 * * 1', async () => {
  const baseIso = new Date().toISOString();
  console.log('[AspectsSched] Weekly job (next7) triggered');

  for (let i = 1; i <= 7; i++) {
    const iso = shiftIsoDays(baseIso, i);
    await callAspectsOnce({
      label: `weekly:next7_d${i}`,
      iso,
    });
  }
});

/**
 * 3) MONTHLY – next30 for NEXT month
 *    Run every day at 02:00; only execute when today is LAST day of month.
 *    baseIso = first day of next month (00:00 UTC)
 */
cron.schedule('0 0 2 * * *', async () => {
  const now = new Date();

  if (!isLastDayOfMonth(now)) {
    return; // not last day → skip
  }

  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-based
  const firstOfNext = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0));

  const baseIso = firstOfNext.toISOString();
  const monthIsos = buildMonthIsoList(baseIso);

  console.log(
    `[AspectsSched] Monthly job (next month daily aspects) triggered for ${monthIsos.length} days`
  );

  let idx = 0;
  for (const iso of monthIsos) {
    idx += 1;
    await callAspectsOnce({
      label: `monthly:nextMonth_d${idx}`,
      iso,
    });
  }
});

/**
 * 4) YEARLY – daily aspects for whole next year (365/366)
 *    Cron: Dec 31 at 03:00
 */
cron.schedule('0 0 3 31 12 *', async () => {
  const now = new Date();
  const nextYear = now.getUTCFullYear() + 1;
  const jan1Next = new Date(Date.UTC(nextYear, 0, 1, 0, 0, 0));

  const baseIso = jan1Next.toISOString();
  const yearIsos = buildYearIsoList(baseIso);

  console.log(
    `[AspectsSched] Yearly job (daily aspects) triggered for ${yearIsos.length} days`
  );

  let idx = 0;
  for (const iso of yearIsos) {
    idx += 1;
    await callAspectsOnce({
      label: `yearly:day${idx}`,
      iso,
    });

    if (YEARLY_THROTTLE_MS > 0) {
      await sleep(YEARLY_THROTTLE_MS);
    }
  }
});

// ───────────────────────────────────────────────
// MANUAL TRIGGER HELPERS
// ───────────────────────────────────────────────

async function runDailyAspectsJobNow() {
  const baseIso = new Date().toISOString();
  const isoYesterday = shiftIsoDays(baseIso, -1);
  const isoToday = baseIso;
  const isoTomorrow = shiftIsoDays(baseIso, +1);

  await callAspectsOnce({ label: 'manual-daily:yesterday', iso: isoYesterday });
  await callAspectsOnce({ label: 'manual-daily:today', iso: isoToday });
  await callAspectsOnce({
    label: 'manual-daily:tomorrow',
    iso: isoTomorrow,
  });
}

async function runWeeklyAspectsJobNow() {
  const baseIso = new Date().toISOString();
  for (let i = 1; i <= 7; i++) {
    const iso = shiftIsoDays(baseIso, i);
    await callAspectsOnce({
      label: `manual-weekly:next7_d${i}`,
      iso,
    });
  }
}

async function runMonthlyAspectsJobNow() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-based
  const firstOfNext = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0));
  const baseIso = firstOfNext.toISOString();

  const monthIsos = buildMonthIsoList(baseIso);

  let idx = 0;
  for (const iso of monthIsos) {
    idx += 1;
    await callAspectsOnce({
      label: `manual-monthly:nextMonth_d${idx}`,
      iso,
    });
  }
}

async function runYearlyAspectsJobNow() {
  const now = new Date();
  const nextYear = now.getUTCFullYear() + 1;
  const jan1Next = new Date(Date.UTC(nextYear, 0, 1, 0, 0, 0));
  const baseIso = jan1Next.toISOString();

  const yearIsos = buildYearIsoList(baseIso);

  let idx = 0;
  for (const iso of yearIsos) {
    idx += 1;
    await callAspectsOnce({
      label: `manual-yearly:day${idx}`,
      iso,
    });

    if (YEARLY_THROTTLE_MS > 0) {
      await sleep(YEARLY_THROTTLE_MS);
    }
  }
}

// ───────────────────────────────────────────────
// EXPORTS + LOG
// ───────────────────────────────────────────────

export {
  runDailyAspectsJobNow,
  runWeeklyAspectsJobNow,
  runMonthlyAspectsJobNow,
  runYearlyAspectsJobNow,
};

console.log(
  `[AspectsSched] Scheduler loaded. SELF_API_BASE="${
    SELF_API_BASE || 'NOT SET'
  }"`
);
