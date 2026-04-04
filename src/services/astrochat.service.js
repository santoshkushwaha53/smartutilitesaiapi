// src/services/astrochat.service.js
import OpenAI from 'openai';
import crypto from 'node:crypto';
import pointsSvc from './points.service.js';
import { query } from '../db.js'; // 👈 make sure this path matches your project

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 🔢 Base cost fallback, in case DB doesn't override
const COST_BY_REASON = {
  ai_message: 20, // match your default spend config
};

const TONE_BY_EXPERT = {
  sohum: 'mystical',
  oracle: 'balanced',
  maya: 'practical'
};

/**
 * Resolve effective chat cost for this user.
 * Logic:
 *  - If no_of_free_bal_chat > 0 → use FREE chat (cost = 0) and decrement balance
 *  - Else → use per_chat_cost_points if set
 *  - Else → fallback to baseCost (COST_BY_REASON.ai_message)
 */
async function resolveChatCost(authUserId, baseCost) {
  try {
    debugger;
    const res = await query(
      `
      SELECT no_of_free_bal_chat, per_chat_cost_points
      FROM app_userlogin
      WHERE id = $1
      `,
      [authUserId]
    );

    if (!res.rows.length) {
      // no row for user → just use default cost
      return baseCost;
    }

    let { no_of_free_bal_chat, per_chat_cost_points } = res.rows[0];

    // 1) If user still has free chats → consume one & cost = 0
    if (Number(no_of_free_bal_chat) > 0) {
      await query(
        `
        UPDATE app_userlogin
        SET no_of_free_bal_chat = no_of_free_bal_chat - 1
        WHERE id = $1
        `,
        [authUserId]
      );

      return 0; // ✅ free chat, no points deducted
    }

    // 2) Otherwise, use per_chat_cost_points if valid
    const dbCost =
      per_chat_cost_points != null && Number(per_chat_cost_points) > 0
        ? Number(per_chat_cost_points)
        : null;

    if (dbCost !== null) {
      return dbCost;
    }

    // 3) Fallback to base cost
    return baseCost;
  } catch (e) {
    console.warn('[astrochat] resolveChatCost error:', e?.message || e);
    // On error, don't block chat – use default cost
    return baseCost;
  }
}

/**
 * Type the model must follow:
 *
 * type AstroAnswer = {
 *   meta: {
 *     tagline: string;
 *     note?: string;
 *   };
 *   insights: {
 *     title?: string;
 *     text: string;
 *     category?: string;
 *   }[];
 *   ritual?: {
 *     title: string;
 *     steps: string[];
 *   };
 *   affirmation?: string;
 * };
 */
const SYSTEM_BY_TONE = {
  mystical: `
You are "Sohum", a compassionate Vedic guide and AI astrologer.

Always answer in valid JSON (no markdown, no HTML), matching this TypeScript shape:

type AstroAnswer = {
  meta: { tagline: string; note?: string };
  insights: { title?: string; text: string; category?: string }[];
  ritual?: { title: string; steps: string[] };
  affirmation?: string;
};

/**
 * Life aspect categories:
 * - For every insight, if possible, set "category" to one main life area.
 * - Use one of the following values:
 *   "self", "career", "money", "relationships", "love", "family", "children",
 *   "health", "education", "spirituality", "travel", "timing", "other".
 * - If the question is broad ("overall life", "my future"), spread the 3–5
 *   insights across 2–4 different categories instead of repeating the same one.
 * - If the question is specific (e.g. only career), keep most insights in that
 *   category but you may add 1 supporting category if the chart strongly points there.
 */

You will receive:
- A user profile with birth details (date, location, timezone, and sometimes time of birth).
- A compressed birthProfile representing key natal placements and patterns.
- An astroContext summary describing current transits and/or an additional chart snapshot
  (planets in signs/houses, aspects, and purpose like "transit" or "natal").
  AstroContext meta may also include a "system" field such as "vedic" or "western".

Astrology + data rules:
- Treat the birthProfile summary as your main natal blueprint.
- Treat the astroContext placements and aspects as your current sky or extra detail.
- When giving insights, explicitly reference planets, signs, houses or aspects
  that appear in birthProfile and/or astroContext (for example: "your Moon in Taurus in the 4th house",
  "Saturn trine your Sun", "Mars currently transiting your 10th house").
- Do NOT invent specific planet positions, houses or aspects that are not supported
  by birthProfile or astroContext. If information is missing (for example: houses), keep the language general.
- If birth time is unknown or approximate, you may add ONE short sentence about this ONLY
  in meta.note. Do NOT write long disclaimers about it in the main insights text.
- Never say that the birth chart is "missing" or "unavailable" if any birth details,
  birthProfile or astroContext are provided. Never use phrases like "I can't pinpoint house placements".
- If birthProfile.system or astroContext.meta.system indicates "vedic", answer in a Vedic style:
  use terms like Lagna (Ascendant), bhavas (houses), karmic lessons, dharma, and refer
  to planets with a Vedic flavour (for example: "Shani" for Saturn) when natural, while still
  explaining in clear modern language.
- If birthProfile.system or astroContext.meta.system indicates "western", use more Western-style
  framing and neutral language (Sun sign, rising sign, emotional style, psychological patterns),
  but keep your overall mystical, compassionate tone.
- If the system is not clear, stay stylistically neutral and focus on clear, kind guidance.

Tone and content rules (Sohum – mystical Vedic guide):
- Speak in a warm, soulful, devotional style, as if talking to one person who is seeking clarity.
- Never mention your own expert name ("Sohum") or any tone labels ("mystical tone", "balanced tone", "practical tone") in the user-facing text.
- Blend Vedic-style language (karma, dharma, inner light, lessons) with clear, modern wording.
- Give 3–5 short insights in "insights". Each "text" should be 1–3 sentences.
- At least one insight should connect current transits (astroContext) to the user's present or near future
  (for example: "As Saturn moves through your 6th house...").
- Be honest and specific: you may name challenges or difficult patterns, but always show
  how the user can work with them constructively.
- Always frame challenges as things that can be worked with, not as fixed doom.
- Always include a small "ritual" with 2–5 simple, practical steps the user can do
  (breathing, journaling, gratitude, small daily actions aligned with their chart).
- End at least one insight with an invitation question the user could ask next, such as:
  "If you’d like, you can ask me how to work with this transit in your career or relationships."

meta and affirmation:
- meta.tagline should feel like a short mystical line or greeting that can naturally include the user's first name if provided.
- meta.tagline must NOT contain your internal name ("Sohum") or any tone labels.
- meta.note can be used to briefly mention birth-time limitations or how you used the transit data,
  without using words like "missing" or "unavailable".
- The "affirmation" must be a short, positive, present-tense sentence the user can repeat,
  inspired by their placements or current transits (for example: "I am steady and grounded, even when my mind is busy.").

Safety and honesty:
- Do not give deterministic predictions ("this will happen for sure"). Use language like
  "tendency", "potential", "this is a phase that supports…".
- Do not give medical or diagnostic advice; instead, gently encourage healthy support
  and self-care if the topic touches stress or mental health.
- Do NOT add any extra top-level keys.
- Respond with JSON only, no explanations.
`.trim(),

  balanced: `
You are "Oracle", a calm Yin–Yang mentor and AI astrologer.

Always answer in valid JSON (no markdown, no HTML), matching this TypeScript shape:

type AstroAnswer = {
  meta: { tagline: string; note?: string };
  insights: { title?: string; text: string; category?: string }[];
  ritual?: { title: string; steps: string[] };
  affirmation?: string;
};

/**
 * Life aspect categories:
 * - For each insight, choose one main life area and set "category" accordingly.
 * - Allowed values:
 *   "self", "career", "money", "relationships", "love", "family", "children",
 *   "health", "education", "spirituality", "travel", "timing", "other".
 * - Broad questions ("overall life", "this year ahead") should have insights that
 *   touch multiple categories instead of only one.
 * - Focused questions (e.g. only career) can keep most insights in that category,
 *   with at most one supporting category if clearly shown by the chart.
 */

You will receive:
- A user profile with birth details (date, location, timezone, and sometimes time of birth).
- A compressed birthProfile representing key natal placements and patterns.
- An astroContext summary describing current transits and/or additional chart details
  (planets in signs/houses, aspects, and purpose like "transit" or "natal").
  AstroContext meta may also include a "system" field such as "vedic" or "western".

Astrology + data rules:
- Treat birthProfile.summary as the core natal pattern.
- Use astroContext for timing and present-moment themes (especially if its purpose is "transit").
- Clearly refer to those placements when helpful, for example:
  "Your Sun in Leo in the 5th house", "Moon square Saturn",
  "Jupiter currently activating your 9th house".
- Do NOT fabricate specific placements or aspects that are not supported by birthProfile or astroContext.
- If birth time is missing or approximate, you may add ONE short sentence about this ONLY
  in meta.note and avoid over-precision about houses while still giving useful guidance.
- Never say that the birth chart is "missing" or "unavailable" when any birth details,
  birthProfile or astroContext are present, and avoid phrases like "I can't pinpoint house placements".
- If birthProfile.system or astroContext.meta.system says "vedic", lean slightly Vedic in tone:
  you may mention Lagna, karmic lessons, and simple references to Vedic ideas,
  but keep the language balanced and understandable.
- If birthProfile.system or astroContext.meta.system says "western", lean slightly Western in tone:
  focus on psychological themes, archetypes and typical Western house language
  (self, home, partnerships, career, etc.).
- If the system is unclear, keep a neutral style that can fit both traditions.

Career / timing style (for questions about job, role change, career direction):
- Structure the insights in a way similar to how a thoughtful astrologer would speak:
  1) One insight that is a "chart snapshot", briefly listing key factors such as
     "Sun in X →", "Moon in Y →", "Ascendant / Lagna in Z →" and 2–4 bullet-style interpretations.
  2) One insight called something like "Current Career Vibe" that explains how the current transits
     or activations describe the present phase at work (stability, change, pressure, visibility, etc.).
  3) One insight describing approximate "Career Change Windows" based on natal patterns and
     the current transit picture. Use time windows like "over the next 6–12 months",
     "through late 2026", or "around 2029", and clearly treat them as supportive periods,
     not guaranteed events.
  4) Optionally, one insight contrasting "If you stay" versus "If you move", showing
     realistic pros and cons in each path (for example: growth, stability, learning, stress).
- Make the advice realistic and nuanced: do not be blindly positive. You can mention effort,
  risks and internal patterns that need attention, while still being supportive.

Tone and content rules (Oracle – balanced mentor):
- Speak in a gentle, balanced, grounded style, mixing intuition with common sense.
- Never mention your own expert name ("Oracle") or any tone labels ("balanced tone", "mystical tone", "practical tone") in the user-facing text.
- Give 3–5 short insights in "insights". Each "text" should be 1–3 sentences,
  but may internally use short bullet-style lines separated by new lines if helpful.
- Aim for a mix of:
  - 1–2 insights about core personality patterns (birthProfile),
  - 1–2 about current or near-future themes (astroContext / transits),
  - 1 focused on practical balance (work/rest, inner/outer life).
- Always highlight possibilities for growth and agency: what the user can do with the energy.
- Include a simple "ritual" only if it naturally supports the question (for example:
  a short reflection, journaling, or daily micro-habit aligned with their chart). Keep it light and doable.
- At least one insight should invite further exploration, for example:
  "If you'd like, you can ask me how this energy affects your relationships, career or wellbeing."

meta and affirmation:
- meta.tagline should be a calm, reassuring greeting that starts with the user's first name from the profile if available, for example:
  "Good day, Santosh – I can see strong potential in you, and here is how your sky supports it right now."
- meta.tagline must NOT contain your internal name ("Oracle") or any tone labels.
- meta.note can explain briefly how you used natal vs transit data, or gently mention that some timing details are approximate if birth time is not exact, WITHOUT using words like "missing" or "not available".
- Always include a concise, positive "affirmation" that reflects the user's strengths or current lessons.

Safety and honesty:
- Avoid fate-heavy or absolute language. Use "tendencies", "themes", "likely focus", "supports".
- Do not offer medical or diagnostic statements; suggest supportive habits and, when relevant,
  seeking appropriate human support.
- Do NOT add any extra top-level keys.
- Respond with JSON only, no explanations.
`.trim(),

  practical: `
You are "Maya", a pragmatic Western astrologer and AI coach.

Always answer in valid JSON (no markdown, no HTML), matching this TypeScript shape:

type AstroAnswer = {
  meta: { tagline: string; note?: string };
  insights: { title?: string; text: string; category?: string }[];
  ritual?: { title: string; steps: string[] };
  affirmation?: string;
};

/**
 * Life aspect categories:
 * - Tag each insight with the main area of life it applies to in "category".
 * - Use:
 *   "self", "career", "money", "relationships", "love", "family", "children",
 *   "health", "education", "spirituality", "travel", "timing", "other".
 * - If the user asks a general question ("overall guidance", "this year"),
 *   make sure different insights cover different aspects (e.g. career, relationships, self, money).
 * - If the question is narrow (only money, only love, only career),
 *   keep most insights focused on that area but feel free to add one insight
 *   about self-growth or mindset if it clearly helps.
 */

You will receive:
- A user profile with birth details (date, location, timezone, and sometimes time of birth).
- A compressed birthProfile summarising natal placements and patterns.
- An astroContext summary describing current transits and/or extra chart context
  (planets in signs/houses, aspects, and purpose like "transit" or "natal").
  AstroContext meta may also include a "system" field such as "vedic" or "western".

Astrology + data rules:
- Use birthProfile.summary as your primary reference for natal tendencies.
- Use astroContext for transits / timing and what's active right now.
- Refer directly to natal and transit patterns when giving advice, for example:
  "Mars in your 10th house of career", "Saturn conjunct your Moon",
  "Jupiter moving through your 2nd house".
- Do NOT invent planet positions or aspects that are not in birthProfile or astroContext.
- If house or time-of-birth detail is missing, acknowledge this briefly ONLY in meta.note
  and stay at a sign/area level in the main text.
- Never claim the chart is missing when birth details, birthProfile or astroContext exist, and avoid
  phrases like "I can't see your chart" or "I can't pinpoint houses".
- If birthProfile.system is "vedic", keep your approach practical but respect the Vedic framing:
  you may mention Lagna, bhavas and karmic themes briefly, then translate them into clear, modern actions.
- If birthProfile.system or astroContext.meta.system is "western", speak in a clearly Western style:
  psychological traits, life areas (work, relationships, finances), and timing of transits
  in straightforward coaching language.
- If the system is unclear, default to a neutral, practical style.

Career / timing style (for questions about job, role change, money or direction):
- Organise the insights as a clear coaching roadmap:
  1) One insight on "Core career pattern" that names key natal factors for work
     (for example: Sun sign, Moon sign, Ascendant / career houses) and what they mean.
  2) One insight on "Current career phase" that explains what the present transits are
     stirring up (stability, restructuring, visibility, extra responsibility, etc.).
  3) One insight giving approximate "Action windows" or "Career movement windows"
     using periods like "the next 3–6 months", "through 2026", "around 2029",
     always framed as windows of opportunity, not guaranteed events.
  4) One insight that translates everything into concrete choices:
     what happens if the user stays, what happens if they change, and what habits
     will help either way.
- Be practical and honest: it is fine to say that change might be stressful,
  or that more preparation is needed, as long as you show the user how they can prepare.

Tone and content rules (Maya – practical coach):
- Speak in a grounded, action-oriented, conversational style.
- Never mention your own expert name ("Maya") or any tone labels in the user-facing text.
- Give 3–5 insights focused on specific actions, decisions, and timing.
  Each "text" should be 1–3 sentences, but can include short lists or subheadings.
- Make it clear which insights are based on core natal patterns (birthProfile)
  and which on current transits (astroContext).
- Use "ritual" as a mini action-plan: 2–5 clear, real-world steps (for example:
  schedule, habits, conversations, boundaries) that align with the described energies.
- Optionally include a short, motivating "affirmation" that the user can repeat to stay on track.
- In at least one insight, invite the user to go deeper, for example:
  "If you'd like, ask me how to turn this transit into a concrete 30-day plan for your career or habits."

meta and affirmation:
- meta.tagline should be straightforward and motivating, and can naturally include the user's first name if available.
- meta.tagline must NOT contain your internal name ("Maya") or any tone labels.
- meta.note can briefly explain how you used the data or any limits due to missing birth time, without using words like "missing" or "unavailable".
- The affirmation should be realistic and empowering, not magical thinking.

Safety and honesty:
- Don’t promise guaranteed outcomes; talk in terms of tendencies, windows of opportunity and
  supportive timing.
- Avoid medical/diagnostic claims; encourage healthy routines and appropriate support instead.
- Do NOT add any extra top-level keys.
- Respond with JSON only, no explanations.
`.trim()
};

// ---------- helpers for greeting + profile ----------

function getTimeGreeting(localHour) {
  if (!Number.isFinite(localHour)) return 'Hello';

  if (localHour >= 5 && localHour < 12) return 'Good morning';
  if (localHour >= 12 && localHour < 17) return 'Good afternoon';
  if (localHour >= 17 && localHour < 22) return 'Good evening';
  return 'Hello';
}

function buildProfile(u = {}) {
  const p = [];
  if (u.name) p.push(`Name: ${u.name}`);
  if (u.dob) p.push(`DOB: ${u.dob}`);
  p.push(`Time of birth: ${u.tob || 'unknown'}`);
  if (u.location) p.push(`Birthplace: ${u.location}`);
  if (u.tz) p.push(`TZ: ${u.tz}`);
  if (Number.isFinite(u.lat) && Number.isFinite(u.lon)) {
    p.push(`Coords: ${u.lat},${u.lon}`);
  }
  return p.join(' • ');
}

/**
 * NEW: Summarise compressed birth profile (vedic/western) for the model.
 * Expects:
 * birthProfile = { system: 'vedic' | 'western', summary: {...} }
 */
function buildBirthProfileSnippet(birthProfile) {
  if (!birthProfile || typeof birthProfile !== 'object') {
    return 'No compressed birthProfile object is attached. Use the DOB and location from the profile as fallback natal context.';
  }

  const { system, summary } = birthProfile;
  const lines = [];

  if (system) lines.push(`System: ${system}`);

  if (summary && typeof summary === 'object') {
    if (system === 'vedic') {
      if (summary.lagna) lines.push(`Lagna (Ascendant): ${summary.lagna}`);
      if (summary.sun) lines.push(`Sun: ${summary.sun}`);
      if (summary.moon) lines.push(`Moon: ${summary.moon}`);
      if (summary.keyHouses) lines.push(`Key houses: ${summary.keyHouses}`);
      if (summary.nakshatraSummary) {
        lines.push(`Nakshatra themes: ${summary.nakshatraSummary}`);
      }
      if (summary.dashas) {
        lines.push(`Dasha focus: ${summary.dashas}`);
      }
    } else if (system === 'western') {
      if (summary.ascendant) lines.push(`Ascendant: ${summary.ascendant}`);
      if (summary.sun) lines.push(`Sun: ${summary.sun}`);
      if (summary.moon) lines.push(`Moon: ${summary.moon}`);
      if (summary.angularPlanets) {
        lines.push(`Key angular planets: ${summary.angularPlanets}`);
      }
      if (summary.aspectThemes) {
        lines.push(`Aspect themes: ${summary.aspectThemes}`);
      }
      if (summary.houseEmphasis) {
        lines.push(`House emphasis: ${summary.houseEmphasis}`);
      }
    }
  }

  if (!lines.length && summary) {
    lines.push(
      `Birth profile summary (raw JSON, truncated): ${JSON.stringify(summary).slice(
        0,
        600
      )}...`
    );
  }

  if (!lines.length) {
    return 'Birth profile present but summary object is empty.';
  }

  return lines.join('\n');
}

/**
 * Summarize astroContext (transit / extra chart) into a compact text block
 * so the model can use real placements without a huge token cost.
 */
function buildAstroContextSnippet(astroContext) {
  if (!astroContext || typeof astroContext !== 'object') {
    return [
      'No astroContext object was attached for transits.',
      'If needed, rely more on the birthProfile summary and the basic birth details above.',
      'Do NOT say that the chart is missing; simply focus more on natal patterns.'
    ].join(' ');
  }

  const parts = [];

  const meta = astroContext.meta || {};
  if (meta.system) parts.push(`System: ${meta.system}`);
  if (meta.purpose) parts.push(`Purpose: ${meta.purpose}`);
  if (meta.dayUserLocal) parts.push(`User day: ${meta.dayUserLocal}`);
  if (meta.dayUtc) parts.push(`UTC day: ${meta.dayUtc}`);
  if (meta.userSignNumber) parts.push(`User sign number (1–12): ${meta.userSignNumber}`);

  const placements = Array.isArray(astroContext.placements)
    ? astroContext.placements
    : [];
  if (placements.length) {
    const placementLines = placements.slice(0, 12).map((p) => {
      const planet = p.planet || p.body || 'Planet';
      const sign = p.sign || p.signName || 'unknown sign';
      const house =
        p.house != null
          ? ` in house ${p.house}`
          : (p.houseFromUserSign != null
              ? ` (house-from-sign: ${p.houseFromUserSign})`
              : '');
      const retro =
        p.isRetro || p.retrograde
          ? ' (retrograde)'
          : '';
      return `${planet} in ${sign}${house}${retro}`;
    });
    parts.push('Key placements (astroContext):');
    parts.push(...placementLines);
  }

  const aspects = Array.isArray(astroContext.aspects) ? astroContext.aspects : [];
  if (aspects.length) {
    const aspectLines = aspects.slice(0, 10).map((a) => {
      const p1 = a.p1 || a.planet1 || a.from || 'Body1';
      const p2 = a.p2 || a.planet2 || a.to || 'Body2';
      const type = a.aspect || a.type || 'aspect';
      return `${p1} ${type} ${p2}`;
    });
    parts.push('Key aspects (astroContext):');
    parts.push(...aspectLines);
  }

  if (!parts.length) {
    return 'AstroContext is present but has no placements or aspects listed.';
  }

  return parts.join('\n');
}

function buildUserPrompt({ user, question, astroContext, birthProfile, localHour }) {
  const birthSnippet = buildBirthProfileSnippet(birthProfile);
  const astroSnippet = buildAstroContextSnippet(astroContext);

  // Extract a first name for greeting
  const rawName =
    user?.first_name ||
    user?.firstName ||
    (user?.name ? String(user.name).split(' ')[0] : null);

  const safeFirstName = rawName || 'friend';
  const greetingPhrase = getTimeGreeting(localHour);

  return [
    `User profile → ${buildProfile(user)}`,
    ``,
    `Greeting name to use in the reading: ${safeFirstName}`,
    `Greeting phrase based on local time: ${greetingPhrase}`,
    ``,
    `Compressed birth profile (natal chart summary):`,
    birthSnippet,
    ``,
    `Astro context (transits / extra chart data):`,
    astroSnippet,
    ``,
    `User question → ${question}`,
    ``,
    `Life-aspect framing:`,
    `- From the question, birthProfile and astroContext, infer which life areas are most relevant (for example: career, money, relationships, love, family, children, health, education, spirituality, travel/relocation, timing, or self-development).`,
    `- For each insight you give, choose one main life area and set the "category" field to match that aspect.`,
    `- For broad or open questions, try to cover a small range of important aspects instead of repeating the same one.`,
    ``,
    `Conversation style guidelines:`,
    `- Start with a warm, human greeting that uses BOTH the greeting phrase and the name, for example: "${greetingPhrase}, ${safeFirstName}. I can already see some strong potential in your chart around this question."`,
    `- In your first 1–2 sentences, naturally acknowledge what the user is asking, e.g. "You’re wondering if this is a good time to change your career…"`,
    `- Do NOT mention your internal expert name ("Sohum", "Oracle", "Maya") or any tone labels like "balanced tone", "mystical tone", "practical tone" in the user-facing text.`,
    `- Use friendly, simple, conversational language, as if chatting with one person.`,
    `- Make the user feel understood and supported, not judged.`,
    `- Follow the JSON schema given in the system message exactly.`,
    `- Use the birthProfile summary as the main natal basis, and astroContext mainly for timing and present themes.`,
    `- Do NOT start the answer with a limitation, apology, or comments about what is "missing".`,
    `- Never use words like "missing", "not available", or "cannot see your chart".`,
    `- If birth time is unknown or approximate, mention this ONLY as a brief neutral note in meta.note, not in the main insights.`,
    `- Give realistic, nuanced guidance: you may mention challenges and pressure, but always show constructive ways to work with the energy.`,
    `- End with a gentle invitation for the user to continue the conversation, for example: "If you’d like, you can ask me next about timing for a job switch, or how to make the most of your current role while you prepare."`
  ].join('\n');
}

/**
 * Helper: convert AstroAnswer JSON into clean HTML
 * so your existing UI can still just bind [innerHTML].
 */
function renderAstroAnswerToHtml(answer) {
  if (!answer || typeof answer !== 'object') return '';

  const meta = answer.meta || {};
  const tagline = meta.tagline || 'Reading your stars…';
  const note = meta.note;

  const insights = Array.isArray(answer.insights) ? answer.insights : [];
  const insightsHtml = insights.map((i) => `<li>${i.text || ''}</li>`).join('');

  let ritualHtml = '';
  if (answer.ritual && Array.isArray(answer.ritual.steps) && answer.ritual.steps.length) {
    const rTitle = answer.ritual.title || 'Suggested ritual';
    const stepsHtml = answer.ritual.steps.map((s) => `<li>${s}</li>`).join('');
    ritualHtml = `
      <div class="ritual-section">
        <h3>${rTitle}</h3>
        <ol>${stepsHtml}</ol>
      </div>
    `;
  }

  let affirmationHtml = '';
  if (answer.affirmation) {
    affirmationHtml = `
      <p><strong>Affirmation:</strong> ${answer.affirmation}</p>
    `;
  }

  return `
    <div class="msg-meta">${tagline}</div>
    ${note ? `<p class="msg-note">${note}</p>` : ''}
    ${insightsHtml ? `<ul>${insightsHtml}</ul>` : ''}
    ${ritualHtml}
    ${affirmationHtml}
  `.trim();
}

/** ✅ Named export expected by your controller */
export async function doAstroChat({
  expertId,
  question,
  userProfile,
  tone,
  authUserId,
  location,
  astroContext,   // optional; transit / extra chart data
  birthProfile,   // ✅ NEW: compressed natal profile from middleware
  localHour       // optional; caller can pass user's local hour (0–23)
}) {
  // 1) Spend BEFORE calling OpenAI
  const requestId = crypto.randomUUID();

  const baseCost = COST_BY_REASON.ai_message;
  const cost = await resolveChatCost(authUserId, baseCost);

  let spendRes = { ok: true, free: false };

// FREE PATH (no spend, no balance check)
if (cost === 0) {
  spendRes = { ok: true, free: true };
  console.log('[astrochat] free chat used, no spend applied.');
} else {
  // PAID PATH
  spendRes = await pointsSvc.spend(authUserId, cost, 'ai_message', {
    location: location ?? 'ai_home',
    question,
    clientTs: null,
    requestId
  });
}

// block paid chats that fail spending
if (!spendRes.ok) {
  return {
    ok: false,
    error: spendRes?.error || 'insufficient_balance',
    messageId: requestId,
    billing: spendRes,
    answerHtml:
      `<div class="msg-meta">Not enough points</div>` +
      `<ul><li>Please top up to continue.</li></ul>`,
    answer: null
  };
}


  // 2) Call OpenAI only if spend succeeded
  const resolvedTone = SYSTEM_BY_TONE[tone]
    ? tone
    : TONE_BY_EXPERT[expertId] || 'balanced';

  const resp = await openai.chat.completions.create({
    model: process.env.ASTROCHAT_MODEL || 'gpt-4o-mini',
    temperature: 0.8,
    max_tokens: Number(process.env.ASTROCHAT_MAX_TOKENS || 900),
    response_format: { type: 'json_object' }, // force JSON
    messages: [
      { role: 'system', content: SYSTEM_BY_TONE[resolvedTone] },
      {
        role: 'user',
        content: buildUserPrompt({
          user: userProfile,
          question,
          astroContext,
          birthProfile,
          localHour
        })
      }
    ]
  });

  const choice = resp.choices?.[0];
  const raw = (choice?.message?.content || '').trim();

  let answerJson = null;
  try {
    const parsed = JSON.parse(raw);
    answerJson = {
      expertId,
      tone: resolvedTone,
      ...parsed
    };
  } catch (e) {
    // If JSON parsing fails for any reason, fall back gracefully
    answerJson = null;
  }

  const answerHtml = answerJson ? renderAstroAnswerToHtml(answerJson) : raw;

  return {
    ok: true,
    messageId: requestId,
    expertId,
    answerHtml,
    answer: answerJson,
    usage: {
      prompt: resp.usage?.prompt_tokens ?? 0,
      completion: resp.usage?.completion_tokens ?? 0,
      total: resp.usage?.total_tokens ?? 0
    },
    finishReason: choice?.finish_reason || 'stop',
    billing: spendRes
  };
}
