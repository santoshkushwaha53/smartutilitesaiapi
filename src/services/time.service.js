// src/services/time.service.js

export function normalizeCoords(lat, lon) {
  return `${Number(lat).toFixed(6)},${Number(lon).toFixed(6)}`;
}

// ✅ DO NOT use new Date(...) here.
export function buildUtcIsoFromBirthProfile(birth_date, birth_time) {
  const d = String(birth_date).slice(0, 10);   // "YYYY-MM-DD"
  const tRaw = String(birth_time || '00:00:00').trim();
  const t = tRaw.length === 5 ? `${tRaw}:00` : tRaw; // "HH:MM:SS"
  return `${d}T${t}.000Z`;
}
