const express = require('express');
const prisma  = require('../../../lib/prisma');
const auth    = require('../../../middleware/auth.middleware');

const router = express.Router();

// GET /api/holidays?year=2026&state=MH&type=national
router.get('/', async (req, res) => {
  const { year, state, type } = req.query;
  const where = {};
  if (year)  where.year = Number(year);
  if (type)  where.type = type;

  const rows = await prisma.holiday.findMany({ where, orderBy: { date: 'asc' } });

  // Filter by state in JS (states is a JSON array in DB)
  const result = state && state !== 'ALL'
    ? rows.filter(r => {
        const arr = JSON.parse(r.states || '[]');
        return arr.length === 0 || arr.includes(state.toUpperCase());
      })
    : rows;

  res.json(result.map(toClient));
});

// POST /api/holidays
router.post('/', auth, async (req, res) => {
  const { title, date, type, states, description, holidayType } = req.body;
  if (!title || !date || !type)
    return res.status(400).json({ message: 'title, date and type are required' });

  const year = Number(date.substring(0, 4));
  const id = req.body.id || `${title.toLowerCase().replace(/\s+/g, '-')}-${date}-${Date.now()}`;

  const row = await prisma.holiday.create({
    data: {
      id, title, date, year, type,
      states:      JSON.stringify(states || []),
      description,
      holidayType: holidayType || 'gazetted',
    },
  });
  res.status(201).json(toClient(row));
});

// PUT /api/holidays/:id
router.put('/:id', auth, async (req, res) => {
  const { title, date, type, states, description, holidayType } = req.body;
  const data = {
    title, date, type, description,
    holidayType: holidayType || undefined,
    updatedAt: new Date(),
  };
  if (date) data.year = Number(date.substring(0, 4));
  if (states !== undefined) data.states = JSON.stringify(states);

  const row = await prisma.holiday.update({ where: { id: req.params.id }, data });
  res.json(toClient(row));
});

// DELETE /api/holidays/:id
router.delete('/:id', auth, async (req, res) => {
  await prisma.holiday.delete({ where: { id: req.params.id } });
  res.json({ message: 'Deleted' });
});

// GET /api/holidays/stats — counts per year
router.get('/stats', async (_req, res) => {
  const grouped = await prisma.holiday.groupBy({
    by: ['year', 'type'],
    _count: { id: true },
    orderBy: { year: 'asc' },
  });
  res.json(grouped);
});

function toClient(row) {
  return {
    id:          row.id,
    title:       row.title,
    date:        row.date,
    type:        row.type,
    states:      JSON.parse(row.states || '[]'),
    description: row.description,
    holidayType: row.holidayType,
  };
}

module.exports = router;
