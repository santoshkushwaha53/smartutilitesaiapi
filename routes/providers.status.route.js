app.get('/api/horoscope/providers/status', async (_req, res) => {
  async function check(name, fn) {
    const started = Date.now();
    try { await fn(); return { name, ok: true, ms: Date.now() - started }; }
    catch (e) { return { name, ok: false, err: String(e.message || e), ms: Date.now() - started }; }
  }

  const results = await Promise.all([
    // Aztro: POST should return JSON
    check('aztro', () =>
      fetch('https://aztro.sameerkumar.website/?sign=leo&day=today', { method: 'POST' })
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    ),
    // Horoscope-App (Vercel)
    check('horoscope-app', () =>
      fetch('https://horoscope-app-api.vercel.app/api/v1/get-horoscope/today?sign=leo&day=today')
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    ),
    // Ohmanda
    check('ohmanda', () =>
      fetch('https://ohmanda.com/api/horoscope/leo')
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    )
  ]);

  res.json({ results, ts: new Date().toISOString() });
});
