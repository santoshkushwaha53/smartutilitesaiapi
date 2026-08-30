// AI-assisted holiday research using Grok (xAI).
//
// xAI's API is OpenAI-compatible REST (https://api.x.ai/v1/chat/completions),
// so this talks to it directly over axios rather than pulling in an SDK.
// This module NEVER writes to the live Holiday table itself — every result
// becomes a HolidayCandidate row (source: this module's HolidaySource entry,
// isOfficial: false) so it goes through the same human-approval queue as
// scraped candidates. An LLM can hallucinate a date; nothing here should
// bypass review on a public holiday calendar.

const axios = require('axios');
const prisma = require('../../../lib/prisma');

const XAI_API_URL = 'https://api.x.ai/v1/chat/completions';
const XAI_MODEL = process.env.XAI_MODEL || 'grok-4';
const AI_SOURCE_ID = 'ai-research-grok';

function assertConfigured() {
  if (!process.env.XAI_API_KEY) {
    const err = new Error(
      'XAI_API_KEY is not set. Add it to the backend .env (and Render env vars) to use AI research — get one from https://console.x.ai.'
    );
    err.code = 'XAI_NOT_CONFIGURED';
    throw err;
  }
}

async function ensureAiSource() {
  return prisma.holidaySource.upsert({
    where: { id: AI_SOURCE_ID },
    update: {},
    create: {
      id: AI_SOURCE_ID,
      name: 'AI Research (Grok / xAI, web-search grounded)',
      scope: 'state', // nominal — actual scope is per-candidate via stateCode
      stateCode: null,
      url: 'https://x.ai/api',
      kind: 'html',
      parserKey: 'grok-research',
      isOfficial: false, // an LLM answer, however well-grounded, is not a government source
    },
  });
}

async function callGrok(prompt) {
  assertConfigured();

  const response = await axios.post(
    XAI_API_URL,
    {
      model: XAI_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are a meticulous Indian public-holiday researcher. You only report a holiday if you can point to a ' +
            'specific, checkable government or gazette source for it. You always answer with strict JSON only — no ' +
            'prose, no markdown fences. If you are not confident in a date, set "confidence" to "low" and explain why ' +
            'in "reasoning" rather than guessing.',
        },
        { role: 'user', content: prompt },
      ],
      // xAI "Live Search" — lets Grok ground its answer in real web results
      // instead of relying purely on training data for a fast-changing,
      // year-specific fact like a gazette holiday date.
      search_parameters: { mode: 'auto' },
      temperature: 0.2,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.XAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    }
  );

  const content = response.data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Grok returned an empty response');

  // Strip accidental ```json fences even though we asked for strict JSON.
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Grok response was not valid JSON: ${cleaned.slice(0, 300)}`);
  }
}

// ─── Verify a single pending candidate ────────────────────────────────────
// Asks Grok to independently confirm or dispute a scraped candidate's date.
// Updates the candidate's confidence + rawExcerpt with the AI's verdict, but
// never changes its status — a human still approves/rejects it.
async function verifyCandidate(candidateId) {
  const candidate = await prisma.holidayCandidate.findUnique({ where: { id: candidateId } });
  if (!candidate) throw new Error('Candidate not found');

  const scope = candidate.stateCode ? `the Indian state/UT ${candidate.stateCode}` : 'the Government of India (central)';
  const prompt =
    `A scraped source claims the following public holiday. Verify it using web search and reply with strict JSON ` +
    `matching exactly this shape: {"confirmed": boolean, "correctedDate": "YYYY-MM-DD or null", "confidence": ` +
    `"high"|"medium"|"low", "reasoning": string, "sources": string[]}.\n\n` +
    `Holiday: "${candidate.title}"\nClaimed date: ${candidate.date}\nYear: ${candidate.year}\nScope: ${scope}\n`;

  const result = await callGrok(prompt);

  const confidence = ['high', 'medium', 'low'].includes(result.confidence) ? result.confidence : 'low';
  const note =
    `[AI verification — Grok] confirmed=${!!result.confirmed}` +
    (result.correctedDate ? `, correctedDate=${result.correctedDate}` : '') +
    ` — ${result.reasoning || 'no reasoning given'}` +
    (Array.isArray(result.sources) && result.sources.length ? ` (sources: ${result.sources.join(', ')})` : '');

  return prisma.holidayCandidate.update({
    where: { id: candidateId },
    data: {
      confidence,
      rawExcerpt: note.slice(0, 2000),
      date: result.confirmed === false && result.correctedDate ? result.correctedDate : candidate.date,
    },
  });
}

// ─── Research holidays for a state/year gap ───────────────────────────────
// Used when a state has little or no data for a year — asks Grok to find
// the real gazetted/restricted holidays via web search and queues each one
// it can support with a source as a new HolidayCandidate.
async function researchGap({ stateCode, year, stateName }) {
  const source = await ensureAiSource();
  const scope = stateCode ? `the Indian state/UT of ${stateName || stateCode} (${stateCode})` : 'the Government of India (central, DoPT gazetted list)';

  const prompt =
    `Using web search, find the official public holidays for ${scope} for the year ${year}. Only include a holiday ` +
    `if you can cite a specific government/gazette/DoPT source for its date. Reply with strict JSON: ` +
    `{"holidays": [{"title": string, "date": "YYYY-MM-DD", "holidayType": "gazetted"|"restricted"|"observance", ` +
    `"confidence": "high"|"medium"|"low", "source": string}]}. Omit any holiday you are not reasonably confident about ` +
    `rather than guessing.`;

  const result = await callGrok(prompt);
  const holidays = Array.isArray(result.holidays) ? result.holidays : [];

  let created = 0;
  let skipped = 0;

  for (const h of holidays) {
    if (!h?.title || !h?.date || !/^\d{4}-\d{2}-\d{2}$/.test(h.date)) { skipped++; continue; }

    const existingHoliday = await prisma.holiday.findFirst({
      where: {
        date: h.date,
        title: { equals: h.title, mode: 'insensitive' },
      },
    });
    if (existingHoliday) { skipped++; continue; }

    const existingPending = await prisma.holidayCandidate.findFirst({
      where: { sourceId: source.id, stateCode: stateCode || null, date: h.date, title: h.title, status: 'pending' },
    });
    if (existingPending) { skipped++; continue; }

    await prisma.holidayCandidate.create({
      data: {
        sourceId: source.id,
        year,
        stateCode: stateCode || null,
        title: h.title,
        date: h.date,
        rawDateText: h.date,
        type: stateCode ? 'state' : 'national',
        holidayType: ['gazetted', 'restricted', 'observance'].includes(h.holidayType) ? h.holidayType : 'gazetted',
        confidence: ['high', 'medium', 'low'].includes(h.confidence) ? h.confidence : 'low',
        rawExcerpt: `[AI research — Grok] ${h.source || 'no source cited'}`,
        sourceUrl: source.url,
      },
    });
    created++;
  }

  return { created, skipped, totalReturned: holidays.length };
}

module.exports = { verifyCandidate, researchGap, ensureAiSource };
