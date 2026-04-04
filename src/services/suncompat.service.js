// src/services/suncompat.service.js
import { query } from '../db.js';

function toLower(s) { return String(s || '').toLowerCase(); }

export async function fetchPair(signA, signB) {
  const a = toLower(signA);
  const b = toLower(signB);
  if (!a || !b) return null;

  // Resolve sign ids and stable ordering for the pair row
  const { rows: srows } = await query(
    `SELECT sign_id, slug FROM ref_sign WHERE lower(slug) IN ($1,$2)`,
    [a, b]
  );
  if (srows.length !== 2) return null;

  const sA = srows.find(x => x.slug.toLowerCase() === a);
  const sB = srows.find(x => x.slug.toLowerCase() === b);
  const low  = Math.min(sA.sign_id, sB.sign_id);
  const high = Math.max(sA.sign_id, sB.sign_id);

  const { rows } = await query(
    `SELECT *
       FROM sun_pair_compat
      WHERE sign_low_id = $1
        AND sign_high_id = $2
        AND is_active = true`,
    [low, high]
  );
  if (!rows.length) return null;

  const r = rows[0];

  // === Return the EXACT shape your app/jq expects ===
  return {
    compat_key: r.compat_key,
    desc:       r.summary,

    // simple element scores
    elements: {
      fire:  r.el_fire ?? 0,
      air:   r.el_air ?? 0,
      water: r.el_water ?? 0,
      earth: r.el_earth ?? 0,
    },

    // ✅ NEW: the detailed element cards at `.elementalDetail.air.title`
    elementalDetail: r.elemental_detail_json ?? {},

    // heatmap used at `.aspectHeatmap.rows|length` etc
    aspectHeatmap: r.aspect_heatmap ?? { rows: [], cols: [], cells: [] },

    // inter-aspect list
    aspects: r.aspects_list ?? [],

    // planets per person
    planetsA: r.planets_a ?? {},
    planetsB: r.planets_b ?? {},

    // houses block (you curl .houses.selected)
    houses: {
      selected: r.houses_selected ?? [],
      notes:    r.houses_notes ?? {}
    },

    // ✅ NEW: love language block at `.loveLanguage.shared.title`
    loveLanguage: r.love_lang_json ?? {},

    // timeline + AI guidance
    transits: r.transits_json ?? [],
    ai:       r.ai_json ?? {},

    // optional extra sections (if you use them later)
    compatibility: {
      breakdown:    r.compat_breakdown_json ?? {},
      commonGround: r.common_ground_json ?? []
    }
  };
}

// (optional) keep this for future single-sign matrix
export async function fetchMatrix(slug) {
  // implement when needed
  return [];
}
