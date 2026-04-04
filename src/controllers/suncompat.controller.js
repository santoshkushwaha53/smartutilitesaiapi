import * as sunCompatService from '../services/suncompat.service.js';

const bad = (res, msg) => res.status(400).json({ ok: false, error: msg });

// controller stays the same
export async function getPair(req, res) {
  try {
    const { signA, signB } = req.query;
    if (!signA || !signB) return res.status(400).json({ ok:false, error:'signA and signB are required' });

    const data = await sunCompatService.fetchPair(signA, signB);
    if (!data) return res.status(404).json({ ok:false, error:'Pair not found' });

    return res.json({ ok:true, data });
  } catch (err) {
    console.error('[sun-compat:getPair]', err);
    return res.status(500).json({ ok:false, error:'Internal error' });
  }
}

export async function getMatrixForSlug(req, res) {
  try {
    const slug = req.params.slug;
    if (!slug) return bad(res, 'slug is required');

    const rows = await sunCompatService.fetchMatrix(slug);
    return res.json({ ok: true, count: rows.length, rows });
  } catch (err) {
    console.error('[sun-compat:getMatrix]', err);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
}
