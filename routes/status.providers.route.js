// routes/status.providers.route.js
import { Router } from 'express';

const router = Router();
const timeoutMs = 8000;

// Small helper: fetch with timeout + follow redirects; return meta for debugging
async function fetchWithMeta(url, opts = {}) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort('Timeout'), timeoutMs);
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ctrl.signal, ...opts });
    const ct = r.headers.get('content-type') || '';
    let body;
    if (ct.includes('application/json')) {
      body = await r.json().catch(() => null);
    } else {
      body = await r.text().catch(() => null);
    }
    return { ok: r.ok, status: r.status, ct, body };
  } finally {
    clearTimeout(to);
  }
}

async function check(name, fn) {
  const t0 = Date.now();
  try {
    const out = await fn();
    // If we got HTML, mark as 'degraded' even if HTTP 200 (common on free endpoints)
    const looksHtml = typeof out.body === 'string' && /<html|<!DOCTYPE/i.test(out.body);
    return {
      name,
      ok: out.ok && !looksHtml,
      degraded: out.ok && looksHtml,
      status: out.status,
      ct: out.ct,
      ms: Date.now() - t0
    };
  } catch (e) {
    const cause = e?.cause || {};
    return {
      name,
      ok: false,
      err: String(e?.message || e),
      code: cause.code || null,
      hostname: cause.hostname || null,
      address: cause.address || null,
      port: cause.port || null,
      ms: Date.now() - t0
    };
  }
}

// GET /api/horoscope/providers/status
router.get('/status', async (_req, res) => {
  const results = await Promise.all([
    // Community/free (non-critical to your app)
    check('aztro', () => fetchWithMeta('https://aztro.sameerkumar.website/?sign=leo&day=today', { method: 'POST' })),
    check('horoscope-app', () => fetchWithMeta('https://horoscope-app-api.vercel.app/api/v1/get-horoscope/today?sign=leo&day=today')),
    check('ohmanda', () => fetchWithMeta('https://ohmanda.com/api/horoscope/leo')),

    // Real dependencies
    check('openai-responses', async () => {
      const r = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY || ''}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ model: 'gpt-4o-mini', input: [{ role: 'user', content: 'ping' }] })
      });
      const ct = r.headers.get('content-type') || '';
      const body = ct.includes('application/json') ? await r.json().catch(() => null) : await r.text().catch(() => null);
      return { ok: r.ok, status: r.status, ct, body };
    }),
    check('prokerala-token', async () => {
      const form = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.PK_CLIENT_ID || '',
        client_secret: process.env.PK_CLIENT_SECRET || ''
      });
      const r = await fetch('https://api.prokerala.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form
      });
      const ct = r.headers.get('content-type') || '';
      const body = ct.includes('application/json') ? await r.json().catch(() => null) : await r.text().catch(() => null);
      return { ok: r.ok, status: r.status, ct, body };
    })
  ]);

  res.json({ results, ts: new Date().toISOString() });
});

export default router;
