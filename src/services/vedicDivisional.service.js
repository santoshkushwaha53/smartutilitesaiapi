/**
 * ==========================================================
 * SERVICE: vedicDivisional.service.js
 *
 * PURPOSE:
 *  - Compute Vedic divisional (Varga) charts locally
 *  - NO API calls
 *  - Uses planet longitude from D1 (extended planets)
 *
 * FORMULA SOURCE:
 *  - Parashara-based standard Varga calculation
 * ==========================================================
 */

const SIGNS = [
  'Aries', 'Taurus', 'Gemini', 'Cancer',
  'Leo', 'Virgo', 'Libra', 'Scorpio',
  'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces'
];

/**
 * Compute divisional sign for a planet
 */
function computeDivisionalSign(normDegree, signName, division) {
  const baseIndex = SIGNS.indexOf(signName);
  if (baseIndex === -1) {
    throw new Error(`Invalid zodiac sign: ${signName}`);
  }

  const divisionSize = 30 / division;
  const divisionIndex = Math.floor(normDegree / divisionSize);

  const finalIndex = (baseIndex * division + divisionIndex) % 12;
  return SIGNS[finalIndex];
}

/**
 * Compute full divisional chart (D2, D7, D9, D10, etc.)
 */
function computeDivisionalChart(extendedPlanetRaw, division) {
  const chart = {};

  for (const [planet, data] of Object.entries(extendedPlanetRaw || {})) {
    if (!data || data.normDegree == null) continue;

    const signName =
      data.zodiac_sign_name ||
      data.zodiacSign ||
      data.sign_name;

    if (!signName) continue;

    chart[planet] = {
      sign: computeDivisionalSign(
        Number(data.normDegree),
        signName,
        division
      ),
      degree: Number(data.normDegree),
      retrograde: String(data.isRetro) === 'true',
      source: 'local',
      ayanamsha: 'lahiri'
    };
  }

  return chart;
}

