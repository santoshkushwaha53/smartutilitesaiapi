const express = require('express');
const prisma  = require('../../../lib/prisma');
const auth    = require('../../../middleware/auth.middleware');
const { runIngestion } = require('../ingestion/run');
const aiResearch = require('../ingestion/ai-research');

const router = express.Router();

// ─── Sources ──────────────────────────────────────────────────────────────────

// GET /api/ingestion/sources
router.get('/sources', auth, async (_req, res) => {
  const sources = await prisma.holidaySource.findMany({ orderBy: [{ scope: 'asc' }, { stateCode: 'asc' }] });
  res.json(sources);
});

// POST /api/ingestion/sources
router.post('/sources', auth, async (req, res) => {
  const { name, scope, stateCode, url, kind, parserKey, isOfficial } = req.body;
  if (!name || !scope || !url) return res.status(400).json({ message: 'name, scope and url are required' });

  const source = await prisma.holidaySource.create({
    data: {
      name, scope, url,
      stateCode: scope === 'state' ? (stateCode || null) : null,
      kind: kind || 'html',
      parserKey: parserKey || 'generic-holiday-list',
      isOfficial: isOfficial !== false,
    },
  });
  res.status(201).json(source);
});

// PUT /api/ingestion/sources/:id
router.put('/sources/:id', auth, async (req, res) => {
  const { name, url, kind, parserKey, isOfficial, isActive, stateCode } = req.body;
  const source = await prisma.holidaySource.update({
    where: { id: req.params.id },
    data: { name, url, kind, parserKey, isOfficial, isActive, stateCode, updatedAt: new Date() },
  });
  res.json(source);
});

// DELETE /api/ingestion/sources/:id
router.delete('/sources/:id', auth, async (req, res) => {
  await prisma.holidaySource.delete({ where: { id: req.params.id } });
  res.json({ message: 'Deleted' });
});

// ─── Runs ─────────────────────────────────────────────────────────────────────

// POST /api/ingestion/run  { sourceIds?: string[] }
router.post('/run', auth, async (req, res) => {
  try {
    const run = await runIngestion({ triggeredBy: 'manual', sourceIds: req.body?.sourceIds || null });
    res.json(run);
  } catch (err) {
    res.status(500).json({ message: 'Ingestion run failed', error: err.message });
  }
});

// GET /api/ingestion/runs
router.get('/runs', auth, async (_req, res) => {
  const runs = await prisma.ingestionRun.findMany({ orderBy: { startedAt: 'desc' }, take: 50 });
  res.json(runs);
});

// ─── Review queue ─────────────────────────────────────────────────────────────

// GET /api/ingestion/queue?status=pending&year=2026&state=MH
router.get('/queue', auth, async (req, res) => {
  const { status, year, state } = req.query;
  const where = {};
  where.status = status || 'pending';
  if (year) where.year = Number(year);
  if (state && state !== 'ALL') where.stateCode = state.toUpperCase();

  const rows = await prisma.holidayCandidate.findMany({
    where,
    include: { source: { select: { name: true, isOfficial: true, url: true } } },
    orderBy: [{ year: 'asc' }, { date: 'asc' }],
  });
  res.json(rows);
});

// POST /api/ingestion/queue/:id/approve  { title?, date?, type?, holidayType?, states? } — overrides optional
router.post('/queue/:id/approve', auth, async (req, res) => {
  const candidate = await prisma.holidayCandidate.findUnique({ where: { id: req.params.id } });
  if (!candidate) return res.status(404).json({ message: 'Candidate not found' });
  if (candidate.status !== 'pending') return res.status(400).json({ message: `Candidate already ${candidate.status}` });

  const title = req.body?.title || candidate.title;
  const date  = req.body?.date  || candidate.date;
  const type  = req.body?.type  || candidate.type;
  const holidayType = req.body?.holidayType || candidate.holidayType;
  const states = req.body?.states || (candidate.stateCode ? [candidate.stateCode] : []);

  if (!date) return res.status(400).json({ message: 'A resolved date is required to approve this candidate' });

  const id = `${title.toLowerCase().replace(/\s+/g, '-')}-${(states[0] || 'national')}-${date}`;
  const holiday = await prisma.holiday.upsert({
    where: { id },
    update: { title, date, year: Number(date.slice(0, 4)), type, states: JSON.stringify(states), holidayType, updatedAt: new Date() },
    create: { id, title, date, year: Number(date.slice(0, 4)), type, states: JSON.stringify(states), holidayType },
  });

  await prisma.holidayCandidate.update({
    where: { id: candidate.id },
    data: { status: 'approved', resultHolidayId: holiday.id, reviewedAt: new Date(), reviewedBy: req.user?.email || 'admin' },
  });

  res.json({ holiday, candidateId: candidate.id });
});

// POST /api/ingestion/queue/:id/reject
router.post('/queue/:id/reject', auth, async (req, res) => {
  const candidate = await prisma.holidayCandidate.update({
    where: { id: req.params.id },
    data: { status: 'rejected', reviewedAt: new Date(), reviewedBy: req.user?.email || 'admin' },
  });
  res.json(candidate);
});

// POST /api/ingestion/queue/bulk-approve { ids: string[] }
router.post('/queue/bulk-approve', auth, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const results = [];
  for (const id of ids) {
    const candidate = await prisma.holidayCandidate.findUnique({ where: { id } });
    if (!candidate || candidate.status !== 'pending' || !candidate.date) {
      results.push({ id, ok: false });
      continue;
    }
    const states = candidate.stateCode ? [candidate.stateCode] : [];
    const holidayId = `${candidate.title.toLowerCase().replace(/\s+/g, '-')}-${(states[0] || 'national')}-${candidate.date}`;
    await prisma.holiday.upsert({
      where: { id: holidayId },
      update: { title: candidate.title, date: candidate.date, year: candidate.year, type: candidate.type, states: JSON.stringify(states), holidayType: candidate.holidayType, updatedAt: new Date() },
      create: { id: holidayId, title: candidate.title, date: candidate.date, year: candidate.year, type: candidate.type, states: JSON.stringify(states), holidayType: candidate.holidayType },
    });
    await prisma.holidayCandidate.update({
      where: { id },
      data: { status: 'approved', resultHolidayId: holidayId, reviewedAt: new Date(), reviewedBy: req.user?.email || 'admin' },
    });
    results.push({ id, ok: true });
  }
  res.json({ results });
});

// ─── AI research (Grok / xAI) ─────────────────────────────────────────────
// Never writes to the live Holiday table directly — results land as
// HolidayCandidate rows in the same review queue as scraped sources.

// POST /api/ingestion/ai/verify/:candidateId
// Cross-checks one pending candidate's date via web-search-grounded Grok.
// Updates the candidate's confidence/notes only; status stays "pending".
router.post('/ai/verify/:candidateId', auth, async (req, res) => {
  try {
    const candidate = await aiResearch.verifyCandidate(req.params.candidateId);
    res.json(candidate);
  } catch (err) {
    const status = err.code === 'XAI_NOT_CONFIGURED' ? 503 : 500;
    res.status(status).json({ message: err.message });
  }
});

// POST /api/ingestion/ai/research  { stateCode?: string, stateName?: string, year: number }
// Asks Grok to find the real holidays for a state (or central, if stateCode
// omitted) and queues each supportable one as a new pending candidate.
router.post('/ai/research', auth, async (req, res) => {
  const { stateCode, stateName, year } = req.body || {};
  if (!year) return res.status(400).json({ message: 'year is required' });

  try {
    const result = await aiResearch.researchGap({
      stateCode: stateCode ? String(stateCode).toUpperCase() : null,
      stateName,
      year: Number(year),
    });
    res.json(result);
  } catch (err) {
    const status = err.code === 'XAI_NOT_CONFIGURED' ? 503 : 500;
    res.status(status).json({ message: err.message });
  }
});

module.exports = router;
