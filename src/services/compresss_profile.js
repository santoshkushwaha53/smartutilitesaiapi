// src/services/compresss_profile.js

// ---------- Small utility helpers ----------

function safeJson(v, fallback) {
  if (!v) return fallback;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return fallback;
    }
  }
  return v;
}

function getPlanetFromRasi(rasi, name) {
  if (!rasi) return null;
  return rasi[name] || null;
}

// ---------- VEDIC PROFILE COMPRESSION ----------
// Input row = one row from vw_vedic_chart_openai_payload
//   planets            = rasi_planet_raw (json/jsonb)
//   divisional_charts  = jsonb_object_agg(D2/D7/D9/D10 ...)

export function buildVedicProfileSummary(row) {
  if (!row) return null;

  const rasi = safeJson(row.planets, row.planets) || {};
  const divisional = safeJson(row.divisional_charts, row.divisional_charts) || {};

  const asc = getPlanetFromRasi(rasi, 'Ascendant');
  const sun = getPlanetFromRasi(rasi, 'Sun');
  const moon = getPlanetFromRasi(rasi, 'Moon');
  const rahu = getPlanetFromRasi(rasi, 'Rahu');
  const ketu = getPlanetFromRasi(rasi, 'Ketu');

  const keyPlanetNames = [
    'Mars',
    'Mercury',
    'Jupiter',
    'Venus',
    'Saturn',
    'Rahu',
    'Ketu'
  ];

  const keyPlanets = keyPlanetNames
    .map((name) => {
      const p = getPlanetFromRasi(rasi, name);
      if (!p) return null;
      return {
        planet: name,
        sign: p.zodiac_sign_name || null,
        house: p.house_number || null,
        nakshatra: p.nakshatra_name || null,
        pada: p.nakshatra_pada || null,
        vimsottariLord: p.nakshatra_vimsottari_lord || null
      };
    })
    .filter(Boolean);

  function pickDivChart(code) {
    const rawChart = divisional[code];
    if (!rawChart) return null;

    const chart = safeJson(rawChart, rawChart) || {};

    const important = [
      'Ascendant',
      'Sun',
      'Moon',
      'Mars',
      'Mercury',
      'Jupiter',
      'Venus',
      'Saturn',
      'Rahu',
      'Ketu'
    ];

    const out = {};
    for (const name of important) {
      const p = chart[name];
      if (p) {
        out[name] = {
          sign: p.sign || null,
          degree: p.degree || null
        };
      }
    }
    return out;
  }

  const rahuKetuAxis =
    rahu && ketu
      ? {
          rahuSign: rahu.zodiac_sign_name || null,
          ketuSign: ketu.zodiac_sign_name || null,
          rahuHouse: rahu.house_number || null,
          ketuHouse: ketu.house_number || null
        }
      : null;

  return {
    system: 'vedic',
    isoInput: row.iso_input || null,
    ayanamsha: row.ayanamsha || null,

    lagna:
      asc && {
        sign: asc.zodiac_sign_name || null,
        nakshatra: asc.nakshatra_name || null,
        pada: asc.nakshatra_pada || null
      },

    moon:
      moon && {
        sign: moon.zodiac_sign_name || null,
        house: moon.house_number || null,
        nakshatra: moon.nakshatra_name || null,
        pada: moon.nakshatra_pada || null
      },

    sun:
      sun && {
        sign: sun.zodiac_sign_name || null,
        house: sun.house_number || null,
        nakshatra: sun.nakshatra_name || null,
        pada: sun.nakshatra_pada || null
      },

    rahuKetuAxis,
    keyPlanets,

    divisional: {
      D2: pickDivChart('D2'),
      D7: pickDivChart('D7'),
      D9: pickDivChart('D9'),
      D10: pickDivChart('D10')
    }
  };
}

// ---------- WESTERN PROFILE COMPRESSION ----------
// Input row from astro_birth_chart_raw:
//  planet_raw_output, house_raw_output, aspect_raw_output

export function buildWesternProfileSummary(row) {
  if (!row) return null;

  const planetRaw = safeJson(row.planet_raw_output, row.planet_raw_output) || {};
  const houseRaw = safeJson(row.house_raw_output, row.house_raw_output) || {};
  const aspectRaw = safeJson(row.aspect_raw_output, row.aspect_raw_output) || {};

  // Planets JSON from your sample can be:
  // { output: [ { planet: {en:'Sun'}, zodiac_sign: {name:{en:'Leo'}}, fullDegree, ... }, ... ] }
  const planetsArr =
    Array.isArray(planetRaw.output) ? planetRaw.output : Array.isArray(planetRaw) ? planetRaw : [];

  const housesArr =
    houseRaw.output && Array.isArray(houseRaw.output.Houses)
      ? houseRaw.output.Houses
      : Array.isArray(houseRaw.Houses)
      ? houseRaw.Houses
      : [];

  const aspectsArr =
    Array.isArray(aspectRaw.output) ? aspectRaw.output : Array.isArray(aspectRaw) ? aspectRaw : [];

  function findPlanet(nameEn) {
    return planetsArr.find(
      (p) =>
        p.planet &&
        (p.planet.en === nameEn ||
          p.planet === nameEn) // in case shape is different
    );
  }

  function toPlanetSummary(p) {
    if (!p) return null;
    const signName =
      p.zodiac_sign?.name?.en || p.zodiac_sign?.name || p.zodiac_sign?.en || null;
    return {
      planet: p.planet?.en || p.planet || null,
      sign: signName,
      degree: p.normDegree ?? p.fullDegree ?? null,
      isRetro:
        p.isRetro === true ||
        p.isRetro === 'true' ||
        p.isRetro === 'True' ||
        p.isRetro === 'TRUE'
    };
  }

  const asc = findPlanet('Ascendant');
  const sun = findPlanet('Sun');
  const moon = findPlanet('Moon');

  const keyPlanetNames = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto'];

  const keyPlanets = keyPlanetNames
    .map((name) => toPlanetSummary(findPlanet(name)))
    .filter(Boolean);

  const houses = housesArr.map((h) => ({
    house: h.House ?? h.house ?? null,
    sign: h.zodiac_sign?.name?.en || h.zodiac_sign?.name || null,
    degree: h.normDegree ?? h.degree ?? null
  }));

  // compress aspects: only major and only basic UI shape
  const MAJOR = new Set(['Conjunction', 'Opposition', 'Square', 'Trine', 'Sextile']);
  const aspects = aspectsArr
    .filter((a) => {
      const type = a.aspect?.en || a.aspect;
      if (!type) return false;
      // keep all if you want, or only major:
      return MAJOR.has(type) || true; // change to 'MAJOR.has(type)' if you want strict
    })
    .map((a) => ({
      type: a.aspect?.en || a.aspect,
      a: a.planet_1?.en || a.planet_1,
      b: a.planet_2?.en || a.planet_2
    }));

  return {
    system: 'western',
    ascendant: asc ? toPlanetSummary(asc) : null,
    sun: sun ? toPlanetSummary(sun) : null,
    moon: moon ? toPlanetSummary(moon) : null,
    keyPlanets,
    houses,
    aspects
  };
}
