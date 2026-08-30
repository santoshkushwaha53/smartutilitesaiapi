/**
 * Correctness checks for the India Public Holidays dataset.
 * Run: node scripts/validate-holidays.js
 * Exits non-zero if any FAIL-level issue is found (safe to wire into CI).
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const YEARS = [2026, 2027];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const EXPECTED_CENTRAL_2026 = new Set([
  'Republic Day', 'Holi', 'Id-ul-Fitr', 'Ram Navami', 'Mahavir Jayanti', 'Good Friday',
  'Buddha Purnima', 'Id-ul-Zuha (Bakrid)', 'Muharram', 'Independence Day', 'Milad-un-Nabi',
  'Janmashtami', 'Mahatma Gandhi Jayanti', 'Dussehra', 'Diwali', 'Guru Nanak Jayanti', 'Christmas Day',
]);
const EXPECTED_CENTRAL_2027 = EXPECTED_CENTRAL_2026; // same 17 titles, different dates

let failures = 0;
let warnings = 0;

function fail(msg) { failures += 1; console.log(`  ✗ FAIL  ${msg}`); }
function warn(msg) { warnings += 1; console.log(`  ! WARN  ${msg}`); }
function pass(msg) { console.log(`  ✓ ${msg}`); }

function isValidDateString(s) {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

async function main() {
  const states = await prisma.state.findMany();
  const stateCodes = new Set(states.map((s) => s.code));
  console.log(`Loaded ${states.length} states/UTs from the State table.\n`);

  const allHolidays = await prisma.holiday.findMany();
  console.log(`Loaded ${allHolidays.length} holiday rows.\n`);

  // ── 1. Schema / basic field sanity ──────────────────────────────────────
  console.log('── Schema sanity ──');
  let badRows = 0;
  for (const h of allHolidays) {
    if (!h.title?.trim()) { badRows += 1; continue; }
    if (!isValidDateString(h.date)) { badRows += 1; fail(`${h.id}: invalid date "${h.date}"`); continue; }
    if (Number(h.date.slice(0, 4)) !== h.year) { badRows += 1; fail(`${h.id}: year field (${h.year}) doesn't match date (${h.date})`); }
    let stateArr;
    try { stateArr = JSON.parse(h.states || '[]'); } catch { badRows += 1; fail(`${h.id}: states is not valid JSON`); continue; }
    for (const code of stateArr) {
      if (!stateCodes.has(code) && !code.startsWith('SCH-')) {
        fail(`${h.id}: references unknown state code "${code}"`);
      }
    }
  }
  if (badRows === 0) pass('All rows have a valid title, date, year, and state codes.');

  // ── 2. Duplicate detection (same date+title+state combo) ────────────────
  console.log('\n── Duplicate detection ──');
  const seen = new Map();
  for (const h of allHolidays) {
    const states = JSON.parse(h.states || '[]');
    const key = `${h.type}::${h.date}::${h.title.toLowerCase()}::${states.slice().sort().join(',')}`;
    if (seen.has(key)) {
      warn(`Duplicate: "${h.title}" on ${h.date} (${h.type}) — ids ${seen.get(key)} and ${h.id}`);
    } else {
      seen.set(key, h.id);
    }
  }
  if ([...seen.values()].length === allHolidays.length) pass('No exact duplicates found.');

  // ── 3. Coverage — every state/UT has holidays for both years ────────────
  console.log('\n── Coverage: state/UT holidays per year ──');
  for (const year of YEARS) {
    for (const state of states) {
      const count = allHolidays.filter(
        (h) => h.type === 'state' && h.year === year && JSON.parse(h.states || '[]').includes(state.code)
      ).length;
      if (count === 0) fail(`${state.code} (${state.name}) has ZERO state holidays for ${year}`);
      else if (count < 8) warn(`${state.code} (${state.name}) has only ${count} state holidays for ${year} — looks incomplete`);
    }
  }
  pass('Coverage check complete (see FAIL/WARN lines above for gaps).');

  // ── 4. Central (national) gazetted list — count + title match ───────────
  console.log('\n── Central government gazetted holidays ──');
  for (const year of YEARS) {
    const rows = allHolidays.filter((h) => h.type === 'national' && h.year === year);
    if (rows.length !== 17) fail(`Central gazetted list for ${year} has ${rows.length} entries, expected 17`);
    else pass(`Central gazetted list for ${year} has the expected 17 entries.`);

    const expected = year === 2026 ? EXPECTED_CENTRAL_2026 : EXPECTED_CENTRAL_2027;
    const titles = new Set(rows.map((r) => r.title));
    for (const title of expected) {
      if (!titles.has(title)) fail(`Central ${year}: missing expected gazetted holiday "${title}"`);
    }
  }

  // ── 5. Weekday cross-check for fixed-date central holidays ──────────────
  console.log('\n── Fixed-date sanity (weekday-independent holidays) ──');
  const FIXED = { '01-26': 'Republic Day', '08-15': 'Independence Day', '10-02': 'Mahatma Gandhi Jayanti', '12-25': 'Christmas Day' };
  for (const year of YEARS) {
    for (const [mmdd, title] of Object.entries(FIXED)) {
      const expectedDate = `${year}-${mmdd}`;
      const row = allHolidays.find((h) => h.type === 'national' && h.year === year && h.title === title);
      if (!row) { fail(`${year}: fixed-date holiday "${title}" not found`); continue; }
      if (row.date !== expectedDate) fail(`${year}: "${title}" should be ${expectedDate}, found ${row.date}`);
    }
  }
  pass('Fixed-date holidays checked.');

  // ── Summary ───────────────────────────────────────────────────────────
  console.log('\n──────────────────────────────');
  console.log(`Result: ${failures} failure(s), ${warnings} warning(s).`);
  await prisma.$disconnect();
  await pool.end();
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error('Validation script crashed:', e); process.exit(1); });
