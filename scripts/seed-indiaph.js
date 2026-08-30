/**
 * Comprehensive seeder — India Public Holidays
 * Seeds: national, state, bank, school holidays (2026 + 2027) + festivals + SEO pages
 * Run: node scripts/seed-indiaph.js
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg }     = require('@prisma/adapter-pg');
const { Pool }         = require('pg');
const fs               = require('fs');
const path             = require('path');

const pool    = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma  = new PrismaClient({ adapter });

const ASSETS = path.resolve(__dirname, '../../indiaph/src/assets');

const MONTH_MAP = {
  january:1, february:2, march:3, april:4, may:5, june:6,
  july:7, august:8, september:9, october:10, november:11, december:12
};

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

function parseMonthDay(dateLabel) {
  if (!dateLabel || dateLabel.toLowerCase().includes('pending')) return { month: 0, day: 0 };
  // e.g. "8 November 2026"
  const parts = dateLabel.trim().split(/\s+/);
  if (parts.length >= 2) {
    const day   = parseInt(parts[0]) || 0;
    const month = MONTH_MAP[parts[1]?.toLowerCase()] || 0;
    return { month, day };
  }
  return { month: 0, day: 0 };
}

// ─── Holiday mapper ────────────────────────────────────────────────────────────
function mapHoliday(h, year, overrideType, stateCode) {
  const states = [];
  if (stateCode && stateCode !== 'ALL') states.push(stateCode);
  if (Array.isArray(h.states)) {
    h.states.forEach(s => { if (s && s !== 'ALL' && !states.includes(s)) states.push(s); });
  }

  const type = overrideType || h.type || 'festival';
  // Suffix must be unique per (type, state) — otherwise a national holiday and a
  // bank holiday sharing the same title (e.g. "Republic Day") with no state code
  // would compute the same id and silently clobber each other on upsert.
  const sfx  = stateCode ? `-${stateCode}` : `-${type}`;
  const id   = `${h.id || h.title?.toLowerCase().replace(/\s+/g,'-')}${sfx}-${year}`;

  // Always derive year from actual date when available
  const actualDate = h.date || `${year}-01-01`;
  const actualYear = h.date ? Number(h.date.substring(0, 4)) : Number(year);

  return {
    id,
    title:       h.title || 'Unknown Holiday',
    date:        actualDate,
    year:        actualYear,
    type,
    states:      JSON.stringify(states),
    description: h.description || h.regionLabel || null,
    holidayType: h.holidayType || 'gazetted',
  };
}

async function upsertHoliday(data) {
  await prisma.holiday.upsert({
    where: { id: data.id },
    update: { ...data, updatedAt: new Date() },
    create: data,
  });
}

// ─── 1. NATIONAL holidays ─────────────────────────────────────────────────────
async function seedNational() {
  console.log('\n── National Holidays ──');

  // 2026 main file — skip type:'national' entries here; the dedicated
  // central-only files below are the authoritative DoPT gazetted list, and
  // duplicating titles like "Gandhi Jayanti" vs "Mahatma Gandhi Jayanti" here
  // would otherwise create two rows for the same holiday.
  const f26 = readJson(path.join(ASSETS, 'holidays/holidays-2026.json'));
  if (f26?.holidays) {
    const nonNational = f26.holidays.filter((h) => h.type !== 'national');
    for (const h of nonNational) await upsertHoliday(mapHoliday(h, 2026, null, null));
    console.log(`  2026 main: ${nonNational.length} holidays (${f26.holidays.length - nonNational.length} national-type entries skipped in favor of the central-only file)`);
  }

  // Central-only (DoPT gazetted) — 2026 and 2027
  for (const year of [2026, 2027]) {
    const central = readJson(path.join(ASSETS, `holidays/${year}/national/india_holidays_${year}_central_only.json`));
    if (central?.holidays) {
      for (const h of central.holidays) await upsertHoliday(mapHoliday(h, year, 'national', null));
      console.log(`  ${year} central: ${central.holidays.length} holidays`);
    }
  }
}

// ─── 2. STATE holidays ────────────────────────────────────────────────────────
async function seedStates() {
  console.log('\n── State Holidays ──');

  for (const year of [2026, 2027]) {
    const dir = path.join(ASSETS, `holidays/${year}/state`);
    if (!fs.existsSync(dir)) continue;
    let total = 0;

    for (const file of fs.readdirSync(dir)) {
      const stateCode = file.replace(`_${year}.json`, '');
      const data = readJson(path.join(dir, file));
      if (!data?.holidays) continue;
      for (const h of data.holidays) await upsertHoliday(mapHoliday(h, year, 'state', stateCode));
      total += data.holidays.length;
    }
    console.log(`  ${year} states: ${total} holidays across ${fs.readdirSync(dir).length} states`);
  }

  // NOTE: holidays/states/{CODE}/holidays-2026.json (12 states) is now
  // superseded by holidays/2026/state and holidays/2027/state (all 36
  // states/UTs) and is intentionally NOT seeded here anymore — seeding both
  // produced two rows per holiday (different auto-generated ids) for the
  // same date/title/state.
}

// ─── 3. BANK holidays ────────────────────────────────────────────────────────
async function seedBank() {
  console.log('\n── Bank Holidays ──');

  const bankFiles = [
    { path: 'holidays/bank/bank-holidays-2026.json', year: 2026 },
    { path: 'holidays/2026/bank/india_holidays_2026_rbi_bank.json', year: 2026 },
    { path: 'holidays/2027/bank/india_holidays_2027_rbi_bank.json', year: 2027 },
  ];

  for (const { path: rel, year } of bankFiles) {
    const data = readJson(path.join(ASSETS, rel));
    if (!data?.holidays) continue;
    for (const h of data.holidays) await upsertHoliday(mapHoliday(h, year, 'bank', null));
    console.log(`  ${path.basename(rel)}: ${data.holidays.length} holidays`);
  }
}

// ─── 4. SCHOOL holidays ───────────────────────────────────────────────────────
async function seedSchool() {
  console.log('\n── School Holidays ──');

  for (const year of [2026, 2027]) {
    const baseDir = path.join(ASSETS, `holidays/${year}/schools-holidays`);
    if (!fs.existsSync(baseDir)) continue;

    let total = 0;
    for (const sub of ['central_boards', 'state_boards']) {
      const dir = path.join(baseDir, sub);
      if (!fs.existsSync(dir)) continue;

      for (const file of fs.readdirSync(dir)) {
        const data = readJson(path.join(dir, file));
        if (!data?.holidays) continue;
        const code = data.code || file.replace('.json', '');
        for (const h of data.holidays) {
          await upsertHoliday(mapHoliday(h, year, 'school', `SCH-${code}`));
        }
        total += data.holidays.length;
      }
    }
    console.log(`  ${year} school: ${total} holidays`);
  }
}

// ─── 5. FESTIVALS ─────────────────────────────────────────────────────────────
async function seedFestivals() {
  console.log('\n── Festivals ──');

  // Load index for date lookups
  const indexData = readJson(path.join(ASSETS, 'data/festivals/festivals.index.json'));
  const indexMap  = {};
  if (indexData?.festivals) {
    for (const f of indexData.festivals) indexMap[f.slug] = f;
  }

  const festDir = path.join(ASSETS, 'data/festivals');
  let count = 0;

  for (const file of fs.readdirSync(festDir)) {
    if (!file.endsWith('.json') || file === 'festivals.index.json') continue;

    const data = readJson(path.join(festDir, file));
    if (!data?.slug && !data?.name) continue;

    const slug     = data.slug || file.replace('.json', '');
    const indexEntry = indexMap[slug] || indexMap[Object.keys(indexMap).find(k => k.toLowerCase() === slug.toLowerCase())];
    const dateLabel  = indexEntry?.date?.dateLabel || '';
    const { month, day } = parseMonthDay(dateLabel);

    const sigArr = Array.isArray(data.significance)
      ? data.significance.map(s => typeof s === 'string' ? s : (s.heading || s.title || JSON.stringify(s)))
      : [];
    const regions = Array.isArray(data.regions) ? data.regions : [];
    const states  = regions.filter(r => r !== 'All India' && r.length <= 4).map(r => r.toUpperCase());

    const record = {
      name:             data.name || slug,
      alternateName:    data.alternateName || null,
      type:             data.type || 'cultural',
      month,
      day,
      shortDesc:        data.shortDesc || null,
      description:      data.shortDesc || null,
      heroEmoji:        data.heroEmoji || indexEntry?.heroEmoji || '',
      colorTone:        data.colorTone || indexEntry?.colorTone || '',
      calendarType:     data.date?.calendarType || indexEntry?.date?.calendarType || null,
      dateLabel:        indexEntry?.date?.dateLabel || null,
      sortOrder:        indexEntry?.sortOrder || 0,
      isActive:         true,
      heroImage:        null,
      images:           '[]',
      regions:          JSON.stringify(regions),
      statesCelebrated: JSON.stringify(states),
      tags:             JSON.stringify(indexEntry?.tags || []),
      significance:     JSON.stringify(sigArr),
      whyCelebrate:     JSON.stringify(Array.isArray(data.whyCelebrate) ? data.whyCelebrate : []),
      howToCelebrate:   JSON.stringify(Array.isArray(data.howToCelebrate) ? data.howToCelebrate : []),
      rituals:          JSON.stringify(Array.isArray(data.rituals) ? data.rituals : []),
      foods:            JSON.stringify(Array.isArray(data.foods) ? data.foods : []),
      wishes:           JSON.stringify(Array.isArray(data.wishes) ? data.wishes : []),
      timeline:         JSON.stringify(Array.isArray(data.timeline) ? data.timeline : []),
      faq:              JSON.stringify(Array.isArray(data.faq) ? data.faq : []),
      cardTheme:        JSON.stringify(indexEntry?.cardTheme || {}),
      seoTitle:         data.seo?.title || null,
      seoDescription:   data.seo?.description || null,
      seoKeywords:      JSON.stringify(data.seo?.keywords || []),
    };

    await prisma.festival.upsert({
      where:  { id: slug },
      update: { ...record, updatedAt: new Date() },
      create: { id: slug, ...record },
    });
    count++;
  }
  console.log(`  Seeded ${count} festivals`);
}

// ─── 6. SEO PAGES ────────────────────────────────────────────────────────────
async function seedSEO() {
  console.log('\n── SEO Pages ──');

  const data = readJson(path.join(ASSETS, 'data/page-info.index.json'));
  if (!data?.pages) return;

  let count = 0;
  for (const page of data.pages) {
    const seo = page.seo || {};
    const matchPaths = page.match?.exact || page.match?.patterns || [page.id];
    const url = Array.isArray(matchPaths) ? matchPaths[0] : matchPaths;

    const faqs = Array.isArray(page.faq)
      ? page.faq.map(f => ({ q: f.question || f.q, a: f.answer || f.a }))
      : [];

    const routePath = String(url);
    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: seo.title || page.title,
      description: seo.description || page.shortDescription,
      mainEntity: faqs.length ? { '@type': 'FAQPage', mainEntity: faqs.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) } : undefined,
    };
    await prisma.seoPage.upsert({
      where: { routePath },
      update: {
        title:         seo.title        || page.title,
        description:   seo.description  || page.shortDescription,
        canonicalPath: routePath,
        jsonLd,
        updatedAt:     new Date(),
      },
      create: {
        routePath,
        title:         seo.title        || page.title,
        description:   seo.description  || page.shortDescription,
        canonicalPath: routePath,
        jsonLd,
      },
    });
    count++;
  }
  console.log(`  Seeded ${count} SEO pages`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🌱 Starting India Public Holidays full seed...\n');
  const start = Date.now();

  await seedNational();
  await seedStates();
  await seedBank();
  await seedSchool();
  await seedFestivals();
  await seedSEO();

  // Summary
  const [holidays, festivals, seo] = await Promise.all([
    prisma.holiday.count(),
    prisma.festival.count(),
    prisma.seoPage.count(),
  ]);

  const byType = await prisma.holiday.groupBy({ by: ['type'], _count: { id: true } });

  console.log('\n✅ Seed complete in', ((Date.now() - start) / 1000).toFixed(1), 's');
  console.log('\n📊 Database totals:');
  console.log(`   Holidays  : ${holidays}`);
  byType.forEach(t => console.log(`     ${t.type.padEnd(10)}: ${t._count.id}`));
  console.log(`   Festivals : ${festivals}`);
  console.log(`   SEO pages : ${seo}`);

  await prisma.$disconnect();
  await pool.end();
}

main().catch(e => { console.error('❌ Seed failed:', e.message); process.exit(1); });
