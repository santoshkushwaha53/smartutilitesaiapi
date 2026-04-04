import express from "express";

const router = express.Router();

/* =========================
   Config
========================= */
const FRESH_TTL_MS = 6 * 60 * 60 * 1000;   // 6h fresh cache
const STALE_MAX_MS = 72 * 60 * 60 * 1000;  // stale fallback allowed up to 72h
const RETRIES = 2;
const TIMEOUT_MS = 8000;

const SIGNS = new Set([
  "aries","taurus","gemini","cancer","leo","virgo",
  "libra","scorpio","sagittarius","capricorn","aquarius","pisces"
]);
const DAYS = new Set(["yesterday","today","tomorrow"]);

// key -> { data, savedAt }
const CACHE = new Map();

/* =========================
   Helpers
========================= */
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function fetchWithTimeout(url, opts = {}, timeoutMs = TIMEOUT_MS){
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal, headers: { "User-Agent": "SohumAstroAI/1.0", ...(opts.headers||{}) } });
    return r;
  } finally {
    clearTimeout(t);
  }
}

async function fetchJSON(url, opts, retries = RETRIES){
  let err;
  for (let i = 0; i <= retries; i++){
    try {
      const resp = await fetchWithTimeout(url, opts);
      if (resp.ok) return await resp.json();
      // don’t retry hard 4xx (except 429)
      if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
        const e = new Error(`HTTP ${resp.status}`); e.status = resp.status; throw e;
      }
      err = new Error(`HTTP ${resp.status}`);
    } catch (e) {
      err = e;
    }
    await sleep(500 * Math.pow(2, i));
  }
  throw err;
}

/* =========================
   Providers (normalize to one shape)
========================= */

// 1) Aztro (today yesterday/today/tomorrow; POST)
async function providerAztro(sign, day){
  const url = `https://aztro.sameerkumar.website/?sign=${encodeURIComponent(sign)}&day=${day}`;
  const raw = await fetchJSON(url, { method: "POST" });
  return {
    provider: "aztro",
    sign, day,
    text: raw.description,
    mood: raw.mood,
    color: raw.color,
    compatibility: raw.compatibility,
    lucky_number: raw.lucky_number,
    lucky_time: raw.lucky_time,
    date_range: raw.date_range,
    current_date: raw.current_date
  };
}

// 2) Horoscope-App (Vercel) today
async function providerVercel(sign, day){
  const base = "https://horoscope-app-api.vercel.app/api/v1/get-horoscope/today";
  const params = new URLSearchParams({ sign, day });
  const raw = await fetchJSON(`${base}?${params.toString()}`, { method: "GET" });
  const data = raw?.data || {};
  return {
    provider: "horoscope-app",
    sign, day,
    text: data.horoscope_data || data.horoscope || "",
    mood: null,
    color: null,
    compatibility: null,
    lucky_number: null,
    lucky_time: null,
    date_range: null,
    current_date: data.date || null
  };
}

// 3) Ohmanda (today)
async function providerOhmanda(sign){
  const url = `https://ohmanda.com/api/horoscope/${encodeURIComponent(sign)}`;
  const raw = await fetchJSON(url, { method: "GET" });
  return {
    provider: "ohmanda",
    sign, day: "today",
    text: raw.horoscope,
    mood: null,
    color: null,
    compatibility: null,
    lucky_number: null,
    lucky_time: null,
    date_range: null,
    current_date: raw.date || null
  };
}

/* =========================
   ADDED: changeable provider order via ?prefer=
   e.g. ?prefer=ohmanda,horoscope-app
========================= */
function providerOrder(prefer) {
  const map = {
    aztro: (s,d) => providerAztro(s,d),
    "horoscope-app": (s,d) => providerVercel(s,d),
    ohmanda: (s,d) => providerOhmanda(s)
  };
  const def = ["aztro","horoscope-app","ohmanda"];
  const wanted = (prefer || "").toLowerCase().split(",").map(x => x.trim()).filter(Boolean);
  const unique = [...new Set([...wanted, ...def])].filter(k => map[k]);
  return unique.map(k => map[k]);
}

async function getFromAny(sign, day, prefer){
  const errors = [];
  for (const fn of providerOrder(prefer)) {
    try { return await fn(sign, day); }
    catch(e){ errors.push(String(e?.status || e?.message || e)); }
  }
  const e = new Error(`All providers failed: ${errors.join(" | ")}`);
  e.status = 502;
  throw e;
}

/* =========================
   ADDED: enrichment (fill extras later from Aztro)
========================= */
function mergeExtras(base, az) {
  return {
    ...base,
    mood: base.mood ?? az.mood ?? null,
    color: base.color ?? az.color ?? null,
    compatibility: base.compatibility ?? az.compatibility ?? null,
    lucky_number: base.lucky_number ?? az.lucky_number ?? null,
    lucky_time: base.lucky_time ?? az.lucky_time ?? null,
    date_range: base.date_range ?? az.date_range ?? null,
  };
}

async function enrichFromAztro(sign, day, key) {
  try {
    const resp = await fetch(
      `https://aztro.sameerkumar.website/?sign=${encodeURIComponent(sign)}&day=${day}`,
      { method: "POST", headers: { "User-Agent": "SohumAstroAI/1.0" } }
    );
    if (!resp.ok) return; // Aztro still down
    const raw = await resp.json();
    const az = {
      provider: "aztro",
      sign, day,
      text: raw.description,
      mood: raw.mood ?? null,
      color: raw.color ?? null,
      compatibility: raw.compatibility ?? null,
      lucky_number: raw.lucky_number ?? null,
      lucky_time: raw.lucky_time ?? null,
      date_range: raw.date_range ?? null,
      current_date: raw.current_date ?? null
    };
    const cached = CACHE.get(key);
    if (cached) {
      const merged = mergeExtras(cached.data, az);
      CACHE.set(key, { ...cached, data: merged });
    }
  } catch { /* ignore */ }
}

/* =========================
   Route
========================= */
router.get("/", async (req, res) => {
  try {
    let { sign = "", day = "today", prefer = "" } = req.query;
    sign = String(sign).toLowerCase();
    day  = String(day).toLowerCase();
    prefer = String(prefer);

    if (!SIGNS.has(sign)) return res.status(400).json({ error: "Invalid sign", allowed: [...SIGNS] });
    if (!DAYS.has(day)) day = "today";

    const key = `${sign}:${day}`;
    const now = Date.now();
    const cached = CACHE.get(key);

    // 1) Serve fresh cache
    if (cached && (now - cached.savedAt) <= FRESH_TTL_MS) {
      return res.json({ ...cached.data, cache: "fresh" });
    }

    // 2) Try providers (with prefer order if supplied)
    try {
      const payload = await getFromAny(sign, day, prefer);
      CACHE.set(key, { data: payload, savedAt: now });
      res.json({ ...payload, cache: cached ? "refreshed" : "miss" });

      // ADDED: if not Aztro, enrich cache in background for next request
      if (payload.provider !== "aztro") {
        setTimeout(() => enrichFromAztro(sign, day, key), 0);
      }
      return;
    } catch (upErr) {
      // 3) Serve stale if available
      if (cached && (now - cached.savedAt) <= STALE_MAX_MS) {
        return res.status(200).json({ ...cached.data, cache: "stale", note: "All providers temporarily unavailable" });
      }
      const status = upErr?.status || 502;
      return res.status(502).json({ error: "today providers unavailable", status });
    }
  } catch (e) {
    return res.status(500).json({ error: "Server error", message: String(e) });
  }
});

export default router;
