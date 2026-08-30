const axios = require('axios');

const USER_AGENT =
  'Mozilla/5.0 (compatible; IndiaPublicHolidaysBot/1.0; +https://indiapublicholidays.example/bot)';

// Fetches a source URL and returns raw text to parse — HTML is returned as-is
// (parsers strip tags themselves via cheerio), PDFs are converted to text.
async function fetchSourceContent(source) {
  const response = await axios.get(source.url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/pdf,*/*' },
    timeout: 20000,
    responseType: source.kind === 'pdf' ? 'arraybuffer' : 'text',
    maxRedirects: 5,
    validateStatus: (status) => status >= 200 && status < 400,
  });

  if (source.kind === 'pdf') {
    const pdfParse = require('pdf-parse');
    const parsed = await pdfParse(Buffer.from(response.data));
    return parsed.text;
  }

  return String(response.data);
}

module.exports = { fetchSourceContent };
