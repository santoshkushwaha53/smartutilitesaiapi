// scripts/backfill_guest_all_throttled.mjs
import fs from 'node:fs/promises';

const BASE   = process.env.BASE   || 'http://localhost:4000/api/horoscope/get';
const SYSTEM = process.env.SYSTEM || 'western';
const LANG   = process.env.LANG   || 'en';
const TONE   = process.env.TONE   || 'concise';
const SLEEP  = Number(process.env.SLEEP_SECS || 65); // 65s to stay under 5/min limit

const SIGNS   = ['aries','taurus','gemini','cancer','leo','virgo','libra','scorpio','sagittarius','capricorn','aquarius','pisces'];
const PERIODS = ['yesterday','today','tomorrow','weekly','monthly','yearly'];
const TOPICS  = ['general','love','career','money','health','relationships','numerology','lucky_number','lucky_color','family','job'];

const OUTDIR = 'logs/guest_backfill_throttled_node';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callOne(sign, period, topic) {
  const body = {
    audience: 'generic',
    sign, system: SYSTEM, period,
    topics: [topic],
    lang: LANG, tone: TONE
  };

  try {
    const res = await fetch(BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const json = await res.json();

    const fname = `${OUTDIR}/${sign}_${period}_${topic}.json`;
    await fs.writeFile(fname, JSON.stringify(json, null, 2));
    console.log('✅ Saved', fname);
  } catch (err) {
    console.error('❌ Error', sign, period, topic, err.message);
  }
}

async function main() {
  await fs.mkdir(OUTDIR, { recursive: true });
  for (const sign of SIGNS) {
    for (const period of PERIODS) {
      for (const topic of TOPICS) {
        console.log(`▶️ ${sign} ${period} ${topic}`);
        await callOne(sign, period, topic);
        await sleep(SLEEP * 1000); // throttle
      }
    }
  }
  console.log('🎉 Backfill complete');
}

main();
