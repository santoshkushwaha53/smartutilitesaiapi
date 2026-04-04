// utils/horoscope-prep.js
function safeParseJSON(str) {
  try { return JSON.parse(str); } catch { return null; }
}

const ZODIAC = [
  null,
  { name: "Aries",       elem: "Fire"  },
  { name: "Taurus",      elem: "Earth" },
  { name: "Gemini",      elem: "Air"   },
  { name: "Cancer",      elem: "Water" },
  { name: "Leo",         elem: "Fire"  },
  { name: "Virgo",       elem: "Earth" },
  { name: "Libra",       elem: "Air"   },
  { name: "Scorpio",     elem: "Water" },
  { name: "Sagittarius", elem: "Fire"  },
  { name: "Capricorn",   elem: "Earth" },
  { name: "Aquarius",    elem: "Air"   },
  { name: "Pisces",      elem: "Water" }
];

const CANONICAL = {
  "ascendant": "Ascendant",
  "sun": "Sun",
  "moon": "Moon",
  "mercury": "Mercury",
  "venus": "Venus",
  "mars": "Mars",
  "jupiter": "Jupiter",
  "saturn": "Saturn",
  "uranus": "Uranus",
  "neptune": "Neptune",
  "pluto": "Pluto",
  "true node": "True Node",
  "mean node": "Mean Node",
  "chiron": "Chiron",
  "lilith": "Lilith",
  "ceres": "Ceres",
  "pallas": "Pallas",
  "juno": "Juno",
  "vesta": "Vesta",
  "mc": "MC",
  "ic": "IC",
  "descendant": "Descendant"
};

function normBool(v) {
  if (typeof v === "boolean") return v;
  return String(v || "").toLowerCase() === "true";
}

function normalizePlacements(raw) {
  if (!raw || !Array.isArray(raw.output)) return [];
  return raw.output.map(p => {
    const name = (p?.planet?.en || "").trim();
    const canon = CANONICAL[name.toLowerCase()] || name;
    const n = Number(p?.zodiac_sign?.number) || null;
    const sign = n ? ZODIAC[n]?.name : (p?.zodiac_sign?.name?.en || null);
    const elem = n ? ZODIAC[n]?.elem : null;
    return {
      body: canon,
      sign,
      element: elem,
      fullDegree: Number(p?.fullDegree ?? NaN),
      degreeInSign: Number(p?.normDegree ?? NaN),
      retrograde: normBool(p?.isRetro)
    };
  });
}

function deriveFeatures(placements) {
  const byBody = Object.fromEntries(placements.map(p => [p.body, p]));
  const countsBySign = {};
  const countsByElem = { Fire: 0, Earth: 0, Air: 0, Water: 0 };
  let retrogradeCount = 0;

  for (const p of placements) {
    if (p.sign) countsBySign[p.sign] = (countsBySign[p.sign] || 0) + 1;
    if (p.element) countsByElem[p.element] += 1;
    if (p.retrograde) retrogradeCount++;
  }

  const stelliums = Object.entries(countsBySign)
    .filter(([_, c]) => c >= 3)
    .map(([sign, count]) => ({ sign, count }));

  return {
    primary: {
      sun: byBody["Sun"]?.sign || null,
      moon: byBody["Moon"]?.sign || null,
      ascendant: byBody["Ascendant"]?.sign || null
    },
    countsByElem,
    stelliums,
    retrogradeCount
  };
}

/** Build strict JSON request for common services. */
export function buildLLMInputFromText(text, {
  audience = "generic",
  period = "today",
  lang = "en"
} = {}) {
  const parsed = safeParseJSON(text);
  if (!parsed || !Array.isArray(parsed.output)) {
    throw new Error("Invalid 'text' payload (missing .output array).");
  }

  const placements = normalizePlacements(parsed);
  const features   = deriveFeatures(placements);

  const context = {
    audience, period, lang,
    primary: features.primary,
    element_balance: features.countsByElem,
    stelliums: features.stelliums,
    retrograde_count: features.retrogradeCount,
    placements: placements.map(p => ({
      body: p.body,
      sign: p.sign,
      degree_in_sign: p.degreeInSign,
      retrograde: p.retrograde
    }))
  };

  const system = "You are an expert astrologer. Provide concise, safe, actionable guidance.";
  const instruction = `
Using only the supplied placements & features, produce ${period} predictions for:
GENERAL, LOVE, CAREER, MONEY, HEALTH.

Output strict JSON:
{
  "services": {
    "general": { "score_percent": 0-100, "summary": "string", "tips": ["string","string"], "lucky_color": "string", "lucky_number": "string" },
    "love":    { "score_percent": 0-100, "summary": "string", "tips": ["string","string"], "lucky_color": "string", "lucky_number": "string" },
    "career":  { "score_percent": 0-100, "summary": "string", "tips": ["string","string"], "lucky_color": "string", "lucky_number": "string" },
    "money":   { "score_percent": 0-100, "summary": "string", "tips": ["string","string"], "lucky_color": "string", "lucky_number": "string" },
    "health":  { "score_percent": 0-100, "summary": "string", "tips": ["string","string"], "lucky_color": "string", "lucky_number": "string" }
  },
  "explanations": {
    "primary_signs": "how Sun/Moon/Ascendant informed the reading",
    "elements": "how element balance influenced it",
    "stelliums": "any sign clusters and their meaning",
    "retrogrades": "effect of retrograde count (if relevant)"
  }
}
Rules:
- Keep each summary 3–5 sentences; tips actionable and positive.
- Do not invent placements not provided.
- No medical or financial claims.
`.trim();

  return { system, instruction, context };
}
