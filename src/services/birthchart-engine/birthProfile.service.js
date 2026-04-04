// src/services/birthchart-engine/birthProfile.service.js
import { query } from '../../db.js';

export async function getBirthProfileByEmail({ email }) {
  const { rows } = await query(
    `
    SELECT profile_id, email, birth_date, birth_time, latitude, longitude, timezone, system
    FROM public.birth_profile
    WHERE email = $1
    ORDER BY profile_id DESC
    LIMIT 1
    `,
    [String(email)]
  );

  return rows[0] || null;
}
