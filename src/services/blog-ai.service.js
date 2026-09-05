/**
 * AI helpers for IndiaPublicHolidays Explore article drafting.
 * Never auto-publishes — returns draft payloads for human review in Admin.
 */

const { chatJson } = require("./llm-providers.service");

const SYSTEM_GENERATE = `You are an editorial assistant for IndiaPublicHolidays.com.
Write practical, accurate Explore guides for Indian public holidays, festivals, leave planning, travel, and culture.
Use clear English for Indian readers. Do not invent official gazetted dates — if unsure, say to confirm with the state calendar / employer.
Reply with ONE complete STRICT JSON object only (no markdown), matching this shape:
{
  "title": string,
  "slug": string (kebab-case),
  "subtitle": string,
  "quickSummary": string (2 short sentences),
  "seoTitle": string,
  "seoDescription": string (<=155 chars),
  "keywords": string[],
  "readingMinutes": number,
  "coverEmoji": string (single emoji),
  "contentType": string,
  "topicId": string|null,
  "bodyParagraphs": string[] (4-5 short paragraphs, each 2-4 sentences),
  "faq": [{"q": string, "a": string}] (3-4 items),
  "holidayIds": string[],
  "festivalIds": string[],
  "stateCodes": string[],
  "whyNow": string (1-2 sentences on why this topic fits right now)
}
Keep the full JSON compact enough to finish completely — never truncate.`;

const SYSTEM_SUGGEST = `You are a content strategist for IndiaPublicHolidays.com.
Suggest timely Explore article ideas for the next few weeks in India (public holidays, festivals, long weekends, leave bridges, travel, family).
Reply with STRICT JSON only:
{
  "suggestions": [
    {
      "title": string,
      "angle": string,
      "whyNow": string,
      "contentType": string,
      "topicHint": string,
      "festivalIds": string[],
      "holidayIds": string[],
      "stateCodes": string[],
      "priority": "high"|"medium"|"low"
    }
  ]
}
Provide 5-8 suggestions, highest priority first. Prefer actionable leave/travel angles.`;

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function asArray(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) {
    return value.split(/[,|]/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function normalizeDraft(raw, defaults = {}) {
  const title = String(raw.title || defaults.topicHint || "Untitled guide").trim();
  const paragraphs = asArray(raw.bodyParagraphs);
  const fromSections = Array.isArray(raw.sections)
    ? raw.sections
        .map((s) => (typeof s === "string" ? s : s?.text || s?.content || ""))
        .map((t) => String(t).trim())
        .filter(Boolean)
    : [];
  const body = paragraphs.length ? paragraphs : fromSections;

  const faq = Array.isArray(raw.faq)
    ? raw.faq
        .map((item) => ({
          q: String(item?.q || item?.question || "").trim(),
          a: String(item?.a || item?.answer || "").trim(),
        }))
        .filter((f) => f.q && f.a)
    : [];

  return {
    title,
    slug: slugify(raw.slug || title),
    subtitle: String(raw.subtitle || "").trim(),
    quickSummary: String(raw.quickSummary || "").trim(),
    seoTitle: String(raw.seoTitle || title).trim(),
    seoDescription: String(raw.seoDescription || raw.quickSummary || "").trim().slice(0, 160),
    keywords: asArray(raw.keywords).slice(0, 12),
    readingMinutes: Math.max(1, Number(raw.readingMinutes) || Math.max(3, Math.ceil(body.join(" ").split(/\s+/).length / 180))),
    coverEmoji: String(raw.coverEmoji || "📝").trim().slice(0, 4) || "📝",
    contentType: String(raw.contentType || defaults.contentType || "article").trim(),
    topicId: raw.topicId || defaults.topicId || null,
    sections: body.map((text) => ({ type: "paragraph", text })),
    faq,
    holidayIds: asArray(raw.holidayIds || defaults.holidayIds),
    festivalIds: asArray(raw.festivalIds || defaults.festivalIds),
    stateCodes: asArray(raw.stateCodes || defaults.stateCodes),
    whyNow: String(raw.whyNow || "").trim(),
    status: "draft",
    published: false,
  };
}

async function generateExplorePost(provider, input = {}) {
  const now = new Date();
  const monthName = now.toLocaleString("en-IN", { month: "long", year: "numeric" });
  const topicLabel =
    input.topicTitle ||
    input.topicHint ||
    input.title ||
    "a timely Indian holiday / leave-planning guide";

  const user = [
    `Today's date: ${now.toISOString().slice(0, 10)} (${monthName}).`,
    `Write a full Explore article about: ${topicLabel}`,
    input.angle ? `Angle / brief: ${input.angle}` : null,
    input.contentType ? `Preferred contentType: ${input.contentType}` : null,
    input.topicId ? `Preferred topicId: ${input.topicId}` : null,
    input.topicTitle ? `Category title: ${input.topicTitle}` : null,
    input.holidayIds?.length ? `Related holiday IDs: ${input.holidayIds.join(", ")}` : null,
    input.festivalIds?.length ? `Related festival IDs: ${input.festivalIds.join(", ")}` : null,
    input.stateCodes?.length ? `Related state codes: ${input.stateCodes.join(", ")}` : null,
    input.targetMinutes ? `Target reading time ~${input.targetMinutes} minutes` : "Target reading time 4 minutes",
    input.tone ? `Tone: ${input.tone}` : "Tone: helpful, practical, warm",
    "Include concrete leave-bridge tips when relevant (Mon/Fri bridges, confirm employer/state).",
    "Keep bodyParagraphs to 4 short paragraphs and FAQ to 3 items so the JSON finishes completely.",
  ]
    .filter(Boolean)
    .join("\n");

  const raw = await chatJson(provider, SYSTEM_GENERATE, user, {
    temperature: 0.4,
    maxTokens: 8192,
  });
  return normalizeDraft(raw, input);
}

async function suggestExploreTopics(provider, input = {}) {
  const now = new Date();
  const monthName = now.toLocaleString("en-IN", { month: "long", year: "numeric" });
  const user = [
    `Today: ${now.toISOString().slice(0, 10)} (${monthName}).`,
    "Suggest the best Explore articles to publish now for IndiaPublicHolidays readers.",
    input.focus ? `Focus: ${input.focus}` : null,
    input.stateCodes?.length ? `Prioritize states: ${input.stateCodes.join(", ")}` : null,
    input.knownHolidays
      ? `Upcoming holiday context (may be incomplete): ${JSON.stringify(input.knownHolidays).slice(0, 1500)}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  const raw = await chatJson(provider, SYSTEM_SUGGEST, user, { temperature: 0.5 });
  const suggestions = Array.isArray(raw.suggestions) ? raw.suggestions : [];
  return {
    provider,
    generatedAt: now.toISOString(),
    suggestions: suggestions.slice(0, 8).map((s, i) => ({
      id: `idea-${i + 1}`,
      title: String(s.title || "Untitled idea").trim(),
      angle: String(s.angle || "").trim(),
      whyNow: String(s.whyNow || "").trim(),
      contentType: String(s.contentType || "article").trim(),
      topicHint: String(s.topicHint || s.title || "").trim(),
      festivalIds: asArray(s.festivalIds),
      holidayIds: asArray(s.holidayIds),
      stateCodes: asArray(s.stateCodes),
      priority: ["high", "medium", "low"].includes(s.priority) ? s.priority : "medium",
    })),
  };
}

module.exports = {
  generateExplorePost,
  suggestExploreTopics,
  normalizeDraft,
};
