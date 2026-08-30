const cheerio = require('cheerio');

const MONTHS = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9,
  october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};

const JUNK_TITLE_PATTERNS = [
  /^(home|skip to|menu|search|login|sign in|subscribe|copyright|privacy|terms|read more|click here)/i,
  /^\d+$/,
];

const NOISE_TITLE_WORDS = /\b(cookies?|newsletter|advertisement|javascript|browser)\b/i;

function isJunkTitle(title) {
  if (!title || title.length < 3 || title.length > 90) return true;
  if (JUNK_TITLE_PATTERNS.some((re) => re.test(title.trim()))) return true;
  if (NOISE_TITLE_WORDS.test(title)) return true;
  return false;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Extracts { date, rawDateText, matchEnd, matchStart } for the first date-like
// pattern found in a line, or null. `contextYear` is used as a fallback when
// the line itself has no 4-digit year (common in table rows sitting under a
// "Holidays 2026" heading, where each row is just "1 Jan | Thu | New Year's Day").
function extractDate(line, targetYears, contextYear) {
  const patterns = [
    // 26 January 2026 / 26th January 2026
    { re: /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})\b/, order: 'dmy-name' },
    // January 26, 2026 / January 26 2026
    { re: /\b([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/, order: 'mdy-name' },
    // 2026-01-26
    { re: /\b(\d{4})-(\d{2})-(\d{2})\b/, order: 'ymd-num' },
    // 26-01-2026 or 26/01/2026
    { re: /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/, order: 'dmy-num' },
  ];

  for (const { re, order } of patterns) {
    const m = line.match(re);
    if (!m) continue;

    let year, month, day;
    if (order === 'dmy-name') {
      day = Number(m[1]); month = MONTHS[m[2].toLowerCase()]; year = Number(m[3]);
    } else if (order === 'mdy-name') {
      month = MONTHS[m[1].toLowerCase()]; day = Number(m[2]); year = Number(m[3]);
    } else if (order === 'ymd-num') {
      year = Number(m[1]); month = Number(m[2]); day = Number(m[3]);
    } else if (order === 'dmy-num') {
      day = Number(m[1]); month = Number(m[2]); year = Number(m[3]);
    }

    if (!month || month < 1 || month > 12 || !day || day < 1 || day > 31) continue;
    if (!targetYears.includes(year)) continue;

    return {
      date: `${year}-${pad2(month)}-${pad2(day)}`,
      rawDateText: m[0],
      strong: order === 'dmy-name' || order === 'mdy-name',
      index: m.index,
      matchLength: m[0].length,
    };
  }

  // Fallback: "1 Jan" / "1 January" with no year in the line at all — only
  // usable when a nearby heading told us which year this table belongs to.
  if (contextYear && targetYears.includes(contextYear)) {
    const m = line.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\b/);
    if (m) {
      const day = Number(m[1]);
      const month = MONTHS[m[2].toLowerCase()];
      if (month && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        return {
          date: `${contextYear}-${pad2(month)}-${pad2(day)}`,
          rawDateText: m[0],
          strong: false,
          index: m.index,
          matchLength: m[0].length,
        };
      }
    }
  }

  return null;
}

function titleFromLine(line, dateMatch) {
  const before = line.slice(0, dateMatch.index);
  const after = line.slice(dateMatch.index + dateMatch.matchLength);
  // Prefer whichever side has more usable text — holiday name is usually
  // either "Holiday Name — 26 January 2026" or "26 January 2026 — Holiday Name".
  const cleaned = (s) =>
    s.replace(/[-–—:|•,.\s]+$/, '').replace(/^[-–—:|•,.\s]+/, '').trim();
  const beforeClean = cleaned(before);
  const afterClean = cleaned(after);
  return beforeClean.length >= 3 ? beforeClean : afterClean;
}

// Many aggregator/state pages list holidays in year-grouped tables where each
// row is just "1 Jan | Thu | New Year's Day" with no year in the row itself —
// the year only appears in a heading above the table (e.g. "Tamil Nadu Public
// Holidays 2026"). We walk the document in order, tracking the most recently
// seen year-bearing heading, and stamp it onto rows that don't carry their own
// explicit 4-digit year.
function extractLines(rawContent, kind) {
  if (kind === 'pdf') {
    return rawContent.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((text) => ({ text, year: null }));
  }

  const $ = cheerio.load(rawContent);
  $('script, style, nav, footer').remove();

  const lines = [];
  let currentYear = null;

  $('h1, h2, h3, h4, caption, tr, li, p').each((_, el) => {
    const tag = el.tagName ? el.tagName.toLowerCase() : '';

    if (['h1', 'h2', 'h3', 'h4', 'caption'].includes(tag)) {
      const headingText = $(el).text().replace(/\s+/g, ' ').trim();
      const yearMatch = headingText.match(/\b(20\d{2})\b/);
      if (yearMatch) currentYear = Number(yearMatch[1]);
      return;
    }

    let text;
    if (tag === 'tr') {
      const cells = $(el)
        .find('td, th')
        .map((__, cell) => $(cell).text().replace(/\s+/g, ' ').trim())
        .get()
        .filter(Boolean);
      text = cells.filter((c) => !/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*$/i.test(c)).join(' | ');
    } else {
      text = $(el).text().replace(/\s+/g, ' ').trim();
    }

    if (!text) return;
    lines.push({ text, year: currentYear });
  });

  return lines;
}

// Returns an array of { title, date, rawDateText, confidence, rawExcerpt }
function parseCandidates(rawContent, source, targetYears) {
  const lines = extractLines(rawContent, source.kind);
  const seen = new Set();
  const candidates = [];

  for (const { text: line, year: contextYear } of lines) {
    const dateMatch = extractDate(line, targetYears, contextYear);
    if (!dateMatch) continue;

    const title = titleFromLine(line, dateMatch);
    if (isJunkTitle(title)) continue;

    const dedupeKey = `${dateMatch.date}::${title.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    let confidence = source.isOfficial ? 'medium' : 'low';
    if (source.isOfficial && dateMatch.strong) confidence = 'high';

    candidates.push({
      title,
      date: dateMatch.date,
      rawDateText: dateMatch.rawDateText,
      confidence,
      rawExcerpt: line.slice(0, 240),
    });
  }

  return candidates;
}

module.exports = { parseCandidates, extractDate, isJunkTitle };
