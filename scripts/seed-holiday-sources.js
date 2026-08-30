/**
 * Seeds the HolidaySource table with the starter registry of official +
 * fallback holiday notification sources. Safe to re-run (upserts on url).
 * Run: node scripts/seed-holiday-sources.js
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
const { getSeedSources } = require('../src/modules/holidays/ingestion/sources.seed');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const sources = getSeedSources();
  let created = 0, skipped = 0;

  for (const s of sources) {
    const existing = await prisma.holidaySource.findFirst({ where: { url: s.url } });
    if (existing) { skipped += 1; continue; }
    await prisma.holidaySource.create({ data: s });
    created += 1;
  }

  console.log(`Holiday sources seeded: ${created} created, ${skipped} already existed (of ${sources.length} total).`);
  await prisma.$disconnect();
  await pool.end();
}

main().catch((e) => { console.error('Seed failed:', e.message); process.exit(1); });
