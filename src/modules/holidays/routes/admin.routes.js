const express = require('express');
const prisma  = require('../../../lib/prisma');
const auth    = require('../../../middleware/auth.middleware');

const router = express.Router();

// GET /api/admin/stats
router.get('/stats', auth, async (_req, res) => {
  const [states, festivals, holidays, pages] = await Promise.all([
    prisma.state.count(),
    prisma.festival.count(),
    prisma.holiday.count({ where: { year: new Date().getFullYear() } }),
    prisma.seoPage.count(),
  ]);
  res.json({ states, festivals, holidays, pages });
});

module.exports = router;
