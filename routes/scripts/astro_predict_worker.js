import 'dotenv/config';
import { Pool } from 'pg';
import OpenAI from 'openai';

// ---------- config ----------
const TABLE = 'astro_positions'; // <-- change if your table name differs
const MODEL = 'gpt-4o-mini';     // cheap, good-enough today guidance

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- prompt kit (cost-optimized) ----------
function compressPositions(output) {
  const keep = new Set([
    'Ascendant','Sun','Moon','Mercury','Venus','Mars','Jupiter','Saturn',
    'Uranus','Neptune','Pluto','Mean Node','True Node','MC','IC','Descendant'
  ].map(x => x.toLowerCase()));

  const abbr = { Ascendant:'ASC', Mercury:'Merc', Venus:'Ven', Jupiter:'Jup', Saturn:'Sat',
                 Uranus:'Ura', Neptune:'Nep', Pluto:'Plu', 'Mean Node':'Node', 'True Node':'Node' };

  const sgn3 = s => s.slice(0,3); // Libra->Lib
  const parts = [];
  for (const it of output) {
    const body = it.planet.en;
    if (!keep.has(body.toLowerCase())) continue;
    const sign = it.zodiac_sign.name.en;
    const full = Number(it.fullDegree).toFixed(2);
    const norm = Number(it.normDegree).toFixed(2);
    const retro = String(it.isRetro).toLowerCase() === 'true' ? ' R' : '';
    const tag = abbr[body] || body;
    parts.push(`${tag} ${full} (${sgn3(sign)} ${norm}${retro})`);
  }
  return parts.join('; ');
}

const SYSTEM_PROMPT = `
You are an empathetic, practical astrology interpreter. Use the provided planetary positions (western/vedic specified) to produce concise, grounded guidance.
Rules:
- Friendly, encouraging tone; no fatalism, no medical or legal advice.
- If system=vedic, interpret through sidereal logic; if western, use tropical.
- Only use the data given; do not invent houses/aspects unless provided.
- Write at CEFR B2 simplicity; short sentences; no jargon.
- Return STRICTLY valid JSON matching the requested keys; omit keys not requested.
- Hard limits: each summary ≤60 words; highlight ≤18 words.
`.trim();

function buildUserPrompt({ system, period, topics, lang, tz, astroLine }) {
  const topics_csv = Array.isArray(topics) ? topics.join(',') : String(topics || 'general');
  return `
context:
- system: ${system}
- audience: personal
- period: ${period}
- topics: ${topics_csv}
- language: ${lang}
- timezone: ${tz}

positions (compact):
${astroLine}

optional_aspects:
none

Output JSON only with keys: highlights, ratings, topics (only those in topics list), lucky, disclaimer.
Keep it brief and useful for ${period}.`.trim();
}

// Accepts either already-parsed object or the double-quoted JSON string
function parsePositionsCell(cell) {
  if (!cell) return [];
  if (typeof cell === 'object' && cell.output) return cell.output;
  if (typeof cell === 'string') {
    // fix doubled quotes then parse
    let s = cell.replace(/""/g, '"');
    if (s.startsWith('"')) s = s.slice(1);
    if (s.endsWith('"')) s = s.slice(0, -1);
    const obj = JSON.parse(s);
    return obj.output || [];
  }
  return [];
}

// ---------- core: process one row ----------
async function processOne(client) {
  // Lock one row atomically to avoid double-processing
  const sel = await client.query(`
    WITH cte AS (
      SELECT id
      FROM ${TABLE}
      WHERE is_ai_predicted = 'N'
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE ${TABLE} t
       SET is_ai_predicted = 'P'
      FROM cte
     WHERE t.id = cte.id
  RETURNING t.*;
  `);

  if (sel.rowCount === 0) return null; // nothing to do
  const row = sel.rows[0];

  // Gather inputs from row
  const system = row.system || 'western';
  const period = row.period || 'today';
  const lang = row.language || 'en';
  const tz = 'Asia/Kuala_Lumpur'; // set or read from a column/user profile
  const topics = (row.topic && row.topic.trim()) ? row.topic.split(',').map(s => s.trim()) : ['general'];

  const output = parsePositionsCell(row.json_data || row.positions_json || row.json || row.payload);
  const astroLine = compressPositions(output);

  // Build prompt & call OpenAI
  const user = buildUserPrompt({ system, period, topics, lang, tz, astroLine });

  let prediction;
  try {
    const r = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.7,
      //response_format: { type: 'json_object' },
      
      max_tokens: 600,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: user }
      ]
    });
    prediction = JSON.parse(r.choices[0]?.message?.content || '{}');
  } catch (e) {
    // Save error and mark E
    await client.query(
      `UPDATE ${TABLE} SET is_ai_predicted='E', error_text=$2 WHERE id=$1`,
      [row.id, String(e?.message || e)]
    );
    return { id: row.id, status: 'E', error: e?.message || String(e) };
  }

  // Save result and mark as done
  await client.query(
    `UPDATE ${TABLE}
        SET is_ai_predicted='Y',
            prediction_json = $2,
            predicted_at = NOW(),
            error_text = NULL
      WHERE id = $1`,
    [row.id, prediction]
  );

  return { id: row.id, status: 'Y' };
}

// ---------- runner ----------
(async () => {
  const client = await pool.connect();
  try {
    while (true) {
      await client.query('BEGIN');
      const result = await processOne(client);
      await client.query('COMMIT');
      if (!result) {
        console.log('No pending rows (is_ai_predicted = N). Done.');
        break;
      }
      console.log('Processed', result);
    }
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Worker failed:', e);
  } finally {
    client.release();
    await pool.end();
  }
})();
