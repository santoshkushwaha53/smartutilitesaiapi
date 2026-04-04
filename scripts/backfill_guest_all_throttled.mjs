// backfill.js
import fs from 'node:fs/promises';

// ----------------------
// Config (env-overridable)
// ----------------------
const BASE   = process.env.BASE   || 'http://localhost:4000/api/horoscope/get';
const SYSTEM = process.env.SYSTEM || 'western';       // <-- important
const LANG   = process.env.LANG   || 'en';
const TONE   = process.env.TONE   || 'concise';
const SLEEP  = Number(process.env.SLEEP_SECS || 15);  // throttle between calls

// Domains
const SIGNS   = ['aries','taurus','gemini','cancer','leo','virgo','libra','scorpio','sagittarius','capricorn','aquarius','pisces'];
const PERIODS = ['yesterday','today','tomorrow','weekly','monthly','yearly'];
const TOPICS  = ['general','love','career','money','health','relationships','numerology','lucky_number','lucky_color','family','job'];

// Output directory is namespaced by SYSTEM to avoid cross-system cache/file collisions
const OUTDIR = `logs/guest_backfill_throttled_node/${SYSTEM}`;

// --------------
// Small helpers
// --------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safe = (s) => String(s).replace(/[^\w.-]+/g, '_'); // sanitize for filenames

async function writeJson(path, data) {
  await fs.mkdir(path.substring(0, path.lastIndexOf('/')), { recursive: true });
  await fs.writeFile(path, JSON.stringify(data, null, 2) + '\n');
}

async function callOne(sign, period, topic) {
  const body = {
    audience: 'generic',
    sign,
    system: SYSTEM,
    period,
    topics: [topic],
    lang: LANG,
    tone: TONE
  };

  // Organize outputs as /SYSTEM/<sign>/<period>/<topic>_<SYSTEM>.json
  const dir   = `${OUTDIR}/${safe(sign)}/${safe(period)}`;
  const fname = `${dir}/${safe(topic)}_${SYSTEM}.json`;

  try {
    const res = await fetch(BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    let json;
    try {
      json = await res.json();
    } catch (e) {
      // Non-JSON response
      const text = await res.text();
      throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 200)}...`);
    }

    // Attach a small client-side debug echo so you can audit later
    const payload = {
      _client_debug: {
        requested: { sign, system: SYSTEM, period, topic, lang: LANG, tone: TONE },
        base: BASE,
        http_status: res.status,
        timestamp: new Date().toISOString()
      },
      ...json
    };

    await writeJson(fname, payload);
    console.log('✅ Saved', fname);
  } catch (err) {
    console.error('❌ Error', { sign, period, topic, system: SYSTEM, msg: err.message });
    // Also persist the error for post-mortem
    const errFile = `${dir}/${safe(topic)}_${SYSTEM}.error.json`;
    await writeJson(errFile, {
      error: true,
      message: err.message,
      at: new Date().toISOString(),
      request: { sign, period, topic, system: SYSTEM, lang: LANG, tone: TONE, base: BASE }
    }).catch(() => {});
  }
}

async function main() {
  await fs.mkdir(OUTDIR, { recursive: true });

  for (const sign of SIGNS) {
    for (const period of PERIODS) {
      for (const topic of TOPICS) {
        console.log(`▶️  ${SYSTEM.toUpperCase()} | ${sign} | ${period} | ${topic}`);
        await callOne(sign, period, topic);
        await sleep(SLEEP * 1000); // throttle to avoid rate limits
      }
    }
  }

  console.log('🎉 Backfill complete');
}

process.on('unhandledRejection', (e) => {
  console.error('UNHANDLED REJECTION:', e?.message || e);
});
process.on('uncaughtException', (e) => {
  console.error('UNCAUGHT EXCEPTION:', e?.message || e);
});

main();
