const prisma = require('../../../lib/prisma');
const { fetchSourceContent } = require('./fetch');
const { parseCandidates } = require('./parse');

function currentTargetYears() {
  const y = new Date().getFullYear();
  return [y, y + 1];
}

function normalizeTitle(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function findExistingHolidayMatch(candidate) {
  const rows = await prisma.holiday.findMany({ where: { date: candidate.date } });
  const wanted = normalizeTitle(candidate.title);

  return rows.find((row) => {
    const rowTitle = normalizeTitle(row.title);
    const titleMatches = rowTitle === wanted || rowTitle.includes(wanted) || wanted.includes(rowTitle);
    if (!titleMatches) return false;

    if (!candidate.stateCode) return true; // central/national candidate — date+title match is enough
    const states = JSON.parse(row.states || '[]');
    return states.length === 0 || states.includes(candidate.stateCode);
  });
}

async function findExistingPendingCandidate(sourceId, candidate) {
  return prisma.holidayCandidate.findFirst({
    where: {
      sourceId,
      date: candidate.date,
      stateCode: candidate.stateCode || null,
      title: candidate.title,
      status: 'pending',
    },
  });
}

async function runIngestion({ triggeredBy = 'manual', sourceIds = null } = {}) {
  const run = await prisma.ingestionRun.create({ data: { triggeredBy } });
  const targetYears = currentTargetYears();
  const errors = [];
  let sourcesChecked = 0;
  let sourcesFailed = 0;
  let candidatesFound = 0;
  let candidatesNew = 0;
  let candidatesDuplicate = 0;

  const where = { isActive: true };
  if (Array.isArray(sourceIds) && sourceIds.length) where.id = { in: sourceIds };
  const sources = await prisma.holidaySource.findMany({ where });

  for (const source of sources) {
    sourcesChecked += 1;
    try {
      const rawContent = await fetchSourceContent(source);
      const found = parseCandidates(rawContent, source, targetYears);
      candidatesFound += found.length;

      for (const candidate of found) {
        const year = Number(candidate.date.slice(0, 4));
        const stateCode = source.scope === 'state' ? source.stateCode : null;
        const type = source.scope === 'central' ? 'national' : 'state';

        const existingHoliday = await findExistingHolidayMatch({ ...candidate, stateCode });
        if (existingHoliday) {
          candidatesDuplicate += 1;
          continue;
        }

        const existingPending = await findExistingPendingCandidate(source.id, { ...candidate, stateCode });
        if (existingPending) continue; // already queued from a previous run

        await prisma.holidayCandidate.create({
          data: {
            sourceId: source.id,
            year,
            stateCode,
            title: candidate.title,
            date: candidate.date,
            rawDateText: candidate.rawDateText,
            type,
            holidayType: 'gazetted',
            confidence: candidate.confidence,
            rawExcerpt: candidate.rawExcerpt,
            sourceUrl: source.url,
          },
        });
        candidatesNew += 1;
      }

      await prisma.holidaySource.update({
        where: { id: source.id },
        data: { lastCheckedAt: new Date(), lastSuccessAt: new Date(), lastError: null },
      });
    } catch (err) {
      sourcesFailed += 1;
      errors.push({ sourceId: source.id, sourceName: source.name, message: err.message });
      await prisma.holidaySource.update({
        where: { id: source.id },
        data: { lastCheckedAt: new Date(), lastError: err.message },
      });
    }
  }

  return prisma.ingestionRun.update({
    where: { id: run.id },
    data: {
      finishedAt: new Date(),
      status: 'completed',
      sourcesChecked,
      sourcesFailed,
      candidatesFound,
      candidatesNew,
      candidatesDuplicate,
      errors,
    },
  });
}

module.exports = { runIngestion, currentTargetYears };
