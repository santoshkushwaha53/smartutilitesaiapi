// jobs/HousesScheduler.js
import cron from 'node-cron';
import axios from 'axios';

// ───────────────────────────────────────────────
// ENV CONFIG
// ───────────────────────────────────────────────

const SELF_API_BASE = process.env.SELF_API_BASE; // e.g. http://localhost:4000

// Optional overrides for houses
const HOUSES_COORDS = process.env.FREEASTRO_HOUSES_COORDS || ''; // e.g. "3.1390,101.6869"
const HOUSES_SYSTEM = process.env.FREEASTRO_HOUSES_SYSTEM || 'Placidus';
const HOUSES_LANG = process.env.FREEASTRO_HOUSES_LANG || 'en';

if (!SELF_API_BASE) {
  console.warn(
    '[HousesSched] SELF_API_BASE is not set in env. ' +
      'Scheduler will NOT be able to call your own API.'
  );
}

// ───────────────────────────────────────────────
// DATE HELPERS (similar style as PlanetsScheduler)
// ───────────────────────────────────────────────

/** Extract the original offset from ISO ("+08:00", "-05:00", or "Z") */
function extractOffset(iso) {
  const m = String(iso).match(/([+\-]\d{2}:\d{2}|Z)$/);
  return m ? m[1] : 'Z';
}

/** Shift ISO by N days, preserving original offset */
function shiftIsoDays(iso, days) {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) {
    throw new Error(`Invalid ISO datetime: ${iso}`);
  }
  dt.setUTCDate(dt.getUTCDate() + days);
  const base = dt.toISOString().replace(/\.\d{3}Z$/, '');
  const offset = extractOffset(iso);
  return offset === 'Z' ? `${base}Z` : `${base}${offset}`;
}

/** Shift ISO by N months, preserving original offset */
function shiftIsoMonths(iso, months) {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) {
    throw new Error(`Invalid ISO datetime: ${iso}`);
  }
  dt.setUTCMonth(dt.getUTCMonth() + months);
  const base = dt.toISOString().replace(/\.\d{3}Z$/, '');
  const offset = extractOffset(iso);
  return offset === 'Z' ? `${base}Z` : `${base}${offset}`;
}

/** Build ISO dates for every day in the month of baseIso (keeps time + offset) */
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

  const offset = extractOffset(baseIso);
  return result.map((iso) => {
    const noMs = iso.replace(/\.\d{3}Z$/, '');
    return offset === 'Z' ? `${noMs}Z` : `${noMs}${offset}`;
  });
}

/** Check if given date is the last day of its month (same as planets helper) */
function isLastDayOfMonth(d = new Date()) {
  const tomorrow = new Date(d);
  tomorrow.setDate(d.getDate() + 1);
  return tomorrow.getMonth() !== d.getMonth();
}

// ───────────────────────────────────────────────
// API CALLER – single houses call
// ───────────────────────────────────────────────

async function callHouses({ label, iso }) {
  if (!SELF_API_BASE) {
    console.error(
      `[HousesSched] ${label}: SELF_API_BASE is missing – aborting call.`
    );
    return;
  }

  const url = `${SELF_API_BASE}/api/freeastro/western/houses`;

  const body = {
    iso,
    // let backend fall back to FREEASTRO_DEFAULT_COORDS if not set here
    ...(HOUSES_COORDS ? { coords: HOUSES_COORDS } : {}),
    houseSystem: HOUSES_SYSTEM,
    lang: HOUSES_LANG,
  };

  console.log(
    `[HousesSched] ${label}: calling western/houses iso=${iso} ` +
      `coords="${body.coords || 'DEFAULT'}" system=${body.houseSystem}`
  );

  try {
    const res = await axios.post(url, body);
    console.log(
      `[HousesSched] ${label}: HTTP ${res.status} from western/houses`
    );
  } catch (err) {
    console.error(
      `[HousesSched] ${label}: error calling western/houses`,
      err?.response?.data || err.message || err
    );
  }
}

// ───────────────────────────────────────────────
// RUNNERS (DAILY / WEEKLY / MONTHLY / YEARLY)
// ───────────────────────────────────────────────

async function runDailyHousesJob({ label, baseIso }) {
  const isoYesterday = shiftIsoDays(baseIso, -1);
  const isoToday = baseIso;
  const isoTomorrow = shiftIsoDays(baseIso, +1);

  await callHouses({ label: `${label}:yesterday`, iso: isoYesterday });
  await callHouses({ label: `${label}:today`, iso: isoToday });
  await callHouses({ label: `${label}:tomorrow`, iso: isoTomorrow });
}

async function runWeeklyHousesJob({ label, baseIso }) {
  // next7 days including base
  for (let i = 0; i < 7; i++) {
    const iso = shiftIsoDays(baseIso, i);
    await callHouses({ label: `${label}:d+${i}`, iso });
  }
}

async function runMonthlyHousesJob({ label, baseIso }) {
  // baseIso is first day of next month
  const monthIsos = buildMonthIsoList(baseIso);
  let index = 0;

  for (const iso of monthIsos) {
    index += 1;
    await callHouses({ label: `${label}:day${index}`, iso });
  }
}

async function runYearlyHousesJob({ label, baseIso }) {
  // 12 monthly snapshots starting from baseIso month
  for (let i = 0; i < 12; i++) {
    const iso = shiftIsoMonths(baseIso, i);
    await callHouses({ label: `${label}:m${i}`, iso });
  }
}

// ───────────────────────────────────────────────
// CRON SCHEDULES (mirror PlanetsScheduler)
// ───────────────────────────────────────────────

/**
 * 1) DAILY – yesterday, today, tomorrow
 *    e.g. 00:10 every day server time
 */
cron.schedule('0 10 0 * * *', () => {
  const baseIso = new Date().toISOString();
  console.log('[HousesSched] Daily houses job triggered');
  runDailyHousesJob({
    label: 'houses-daily(yesterday,today,tomorrow)',
    baseIso,
  });
});

/**
 * 2) WEEKLY – next7
 *    Every Monday at 01:00 server time
 */
cron.schedule('0 0 1 * * 1', () => {
  const baseIso = new Date().toISOString();
  console.log('[HousesSched] Weekly houses job (next7) triggered');
  runWeeklyHousesJob({
    label: 'houses-weekly(next7)',
    baseIso,
  });
});

/**
 * 3) MONTHLY – all days of NEXT month
 *    Run every day at 02:00; only execute when today is LAST day of month.
 *    baseIso = first day of next month (00:00 UTC)
 */
cron.schedule('0 0 2 * * *', () => {
  const now = new Date();

  if (!isLastDayOfMonth(now)) {
    return; // not last day → skip
  }

  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-based
  const firstOfNext = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0));
  const baseIso = firstOfNext.toISOString();

  console.log(
    '[HousesSched] Monthly houses job (all days of next month) triggered'
  );
  runMonthlyHousesJob({
    label: 'houses-monthly(next-month-all-days)',
    baseIso,
  });
});

/**
 * 4) YEARLY – 12 monthly snapshots for NEXT year
 *    Dec 31 at 03:00 UTC; baseIso = Jan 1 of next year (00:00 UTC)
 */
cron.schedule('0 0 3 31 12 *', () => {
  const now = new Date();
  const nextYear = now.getUTCFullYear() + 1;
  const jan1Next = new Date(Date.UTC(nextYear, 0, 1, 0, 0, 0));
  const baseIso = jan1Next.toISOString();

  console.log(
    '[HousesSched] Yearly houses job (12 monthly snapshots) triggered'
  );
  runYearlyHousesJob({
    label: 'houses-yearly(12-monthly-snapshots)',
    baseIso,
  });
});

// ───────────────────────────────────────────────
// MANUAL TRIGGER HELPERS (optional)
// ───────────────────────────────────────────────

async function runDailyHousesJobNow() {
  const baseIso = new Date().toISOString();
  return runDailyHousesJob({
    label: 'manual-houses-daily',
    baseIso,
  });
}

async function runWeeklyHousesJobNow() {
  const baseIso = new Date().toISOString();
  return runWeeklyHousesJob({
    label: 'manual-houses-weekly',
    baseIso,
  });
}

async function runMonthlyHousesJobNow() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-based
  const firstOfNext = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0));
  const baseIso = firstOfNext.toISOString();

  return runMonthlyHousesJob({
    label: 'manual-houses-monthly',
    baseIso,
  });
}

async function runYearlyHousesJobNow() {
  const now = new Date();
  const nextYear = now.getUTCFullYear() + 1;
  const jan1Next = new Date(Date.UTC(nextYear, 0, 1, 0, 0, 0));
  const baseIso = jan1Next.toISOString();

  return runYearlyHousesJob({
    label: 'manual-houses-yearly',
    baseIso,
  });
}

// ───────────────────────────────────────────────
// EXPORTS + LOG
// ───────────────────────────────────────────────

export {
  runDailyHousesJobNow,
  runWeeklyHousesJobNow,
  runMonthlyHousesJobNow,
  runYearlyHousesJobNow,
};

console.log(
  `[HousesSched] Scheduler loaded. SELF_API_BASE="${
    SELF_API_BASE || 'NOT SET'
  }", COORDS="${HOUSES_COORDS || 'BACKEND DEFAULT'}", SYSTEM="${HOUSES_SYSTEM}"`
);
