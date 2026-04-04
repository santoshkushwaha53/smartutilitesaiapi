import { Router } from 'express';
import { query } from '../src/db.js'; // <-- your db helper

const router = Router();

/**
 * @typedef {Object} CardRow
 * @property {string} card_id
 * @property {string} name
 * @property {string} arcana            // "major" | "minor"
 * @property {string} img_front_url
 * @property {string} img_back_url
 * @property {string} short
 * @property {string} summary
 * @property {string} guidance
 * @property {string} warning
 * @property {string} love
 * @property {string} career
 * @property {string} wellbeing
 */

/**
 * @typedef {Object} SignRow
 * @property {string} zodiac_sign       // "leo", "aries", etc
 * @property {string} focus_text        // sign-specific blurb
 */

/**
 * @typedef {Object} TarotMeaning
 * @property {string} short
 * @property {string} summary
 * @property {string} guidance
 * @property {string} warning
 * @property {string} love
 * @property {string} career
 * @property {string} wellbeing
 */

/**
 * @typedef {Object} TarotCardResponse
 * @property {string} id
 * @property {string} name
 * @property {string} arcana            // "major" | "minor"
 * @property {string} imgFront
 * @property {string} imgBack
 * @property {TarotMeaning} upright
 * @property {Object.<string,string>} signFocus  // { leo: "...", aries: "...", ... }
 */

// ---------------------------------------------
// GET /api/tarot/card/:id?sign=leo
// ---------------------------------------------
//
// test:
// curl "http://localhost:4000/api/tarot/card/the-fool?sign=leo"
//
router.get('/card/:id', async (req, res) => {
  try {
    // 1. Read params/query
    const cardId = (req.params.id || '').toLowerCase(); // ex 'the-fool'
    const _signParam = (req.query.sign || 'leo').toString().toLowerCase();
    // we keep _signParam for future personalization on server if you want

    // 2. Fetch base card + upright meaning
    const cardSql = `
      SELECT
        c.card_id,
        c.name,
        c.arcana,
        c.img_front_url,
        c.img_back_url,
        m.short,
        m.summary,
        m.guidance,
        m.warning,
        m.love,
        m.career,
        m.wellbeing
      FROM tarot_card c
      JOIN tarot_card_meaning m
        ON m.card_id = c.card_id
       AND m.orientation = 'upright'
      WHERE c.card_id = $1
      LIMIT 1;
    `;

    const rawCardResult = await query(cardSql, [cardId]);
    /** @type {CardRow[]} */
    const cardRows = (rawCardResult.rows ?? []);
    if (!cardRows.length) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    /** @type {CardRow} */
    const cardRow = cardRows[0];

    // 3. Fetch sign-specific focus blurbs
    const signSql = `
      SELECT zodiac_sign, focus_text
      FROM tarot_card_sign_focus
      WHERE card_id = $1;
    `;
    const rawSignResult = await query(signSql, [cardId]);
    /** @type {SignRow[]} */
    const signRows = (rawSignResult.rows ?? []);

    // Build { leo: "...", aries: "...", ... }
    /** @type {Record<string,string>} */
    const signFocus = {};
    for (const r of signRows) {
      const z = (r.zodiac_sign || '').toLowerCase();
      if (!z) continue;
      signFocus[z] = r.focus_text || '';
    }

    // 4. Build final response in the shape your Ionic component expects
    /** @type {TarotCardResponse} */
    const responseBody = {
      id: cardRow.card_id,
      name: cardRow.name,
      arcana: cardRow.arcana === 'minor' ? 'minor' : 'major',
      imgFront: cardRow.img_front_url,
      imgBack: cardRow.img_back_url,
      upright: {
        short: cardRow.short,
        summary: cardRow.summary,
        guidance: cardRow.guidance,
        warning: cardRow.warning,
        love: cardRow.love,
        career: cardRow.career,
        wellbeing: cardRow.wellbeing,
      },
      signFocus, // { leo: "...", aries: "...", ... }
    };

    res.json(responseBody);
  } catch (err) {
    console.error('tarot.card error', err);
    res.status(500).json({
      error: 'server_error',
      detail: err && err.message ? err.message : 'unknown',
    });
  }
});

export default router;
