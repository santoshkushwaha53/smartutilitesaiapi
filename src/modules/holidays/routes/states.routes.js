const express = require('express');
const prisma  = require('../../../lib/prisma');
const auth    = require('../../../middleware/auth.middleware');

const router = express.Router();

// GET /api/states
router.get('/', async (_req, res) => {
  const states = await prisma.state.findMany({ orderBy: { name: 'asc' } });
  res.json(states);
});

// POST /api/states
router.post('/', auth, async (req, res) => {
  const { code, name, emoji, tone, type } = req.body;
  if (!code || !name || !type)
    return res.status(400).json({ message: 'code, name and type are required' });

  const state = await prisma.state.upsert({
    where: { code },
    update: { name, emoji: emoji || '', tone: tone || 'saff', type, updatedAt: new Date() },
    create: { code, name, emoji: emoji || '', tone: tone || 'saff', type },
  });
  res.status(201).json(state);
});

// PUT /api/states/:code
router.put('/:code', auth, async (req, res) => {
  const { name, emoji, tone, type } = req.body;
  const state = await prisma.state.update({
    where: { code: req.params.code },
    data: { name, emoji, tone, type, updatedAt: new Date() },
  });
  res.json(state);
});

// DELETE /api/states/:code
router.delete('/:code', auth, async (req, res) => {
  await prisma.state.delete({ where: { code: req.params.code } });
  res.json({ message: 'Deleted' });
});

// POST /api/states/seed  — seed all 36 default states at once
router.post('/seed', auth, async (req, res) => {
  const defaults = [
    { code:'AP', name:'Andhra Pradesh',       emoji:'🌶️', tone:'saff',   type:'state' },
    { code:'AR', name:'Arunachal Pradesh',    emoji:'🏔️', tone:'teal',   type:'state' },
    { code:'AS', name:'Assam',                emoji:'🍃', tone:'green',  type:'state' },
    { code:'BR', name:'Bihar',                emoji:'🌾', tone:'saff',   type:'state' },
    { code:'CG', name:'Chhattisgarh',         emoji:'🌳', tone:'green',  type:'state' },
    { code:'GA', name:'Goa',                  emoji:'🏖️', tone:'blue',   type:'state' },
    { code:'GJ', name:'Gujarat',              emoji:'🦁', tone:'saff',   type:'state' },
    { code:'HR', name:'Haryana',              emoji:'🚜', tone:'green',  type:'state' },
    { code:'HP', name:'Himachal Pradesh',     emoji:'⛰️', tone:'blue',   type:'state' },
    { code:'JH', name:'Jharkhand',            emoji:'🪨', tone:'teal',   type:'state' },
    { code:'KA', name:'Karnataka',            emoji:'💻', tone:'blue',   type:'state' },
    { code:'KL', name:'Kerala',               emoji:'🌴', tone:'teal',   type:'state' },
    { code:'MP', name:'Madhya Pradesh',       emoji:'🐅', tone:'green',  type:'state' },
    { code:'MH', name:'Maharashtra',          emoji:'🎬', tone:'purple', type:'state' },
    { code:'MN', name:'Manipur',              emoji:'🎋', tone:'pink',   type:'state' },
    { code:'ML', name:'Meghalaya',            emoji:'☁️', tone:'blue',   type:'state' },
    { code:'MZ', name:'Mizoram',              emoji:'🌿', tone:'teal',   type:'state' },
    { code:'NL', name:'Nagaland',             emoji:'🪶', tone:'pink',   type:'state' },
    { code:'OD', name:'Odisha',               emoji:'🛕', tone:'saff',   type:'state' },
    { code:'PB', name:'Punjab',               emoji:'🌾', tone:'green',  type:'state' },
    { code:'RJ', name:'Rajasthan',            emoji:'🏰', tone:'saff',   type:'state' },
    { code:'SK', name:'Sikkim',               emoji:'🏔️', tone:'blue',   type:'state' },
    { code:'TN', name:'Tamil Nadu',           emoji:'🛕', tone:'pink',   type:'state' },
    { code:'TG', name:'Telangana',            emoji:'🏙️', tone:'purple', type:'state' },
    { code:'TR', name:'Tripura',              emoji:'🌺', tone:'pink',   type:'state' },
    { code:'UP', name:'Uttar Pradesh',        emoji:'🕌', tone:'saff',   type:'state' },
    { code:'UK', name:'Uttarakhand',          emoji:'🕉️', tone:'blue',   type:'state' },
    { code:'WB', name:'West Bengal',          emoji:'🎭', tone:'pink',   type:'state' },
    { code:'AN', name:'Andaman and Nicobar Islands', emoji:'🏝️', tone:'blue', type:'ut' },
    { code:'CH', name:'Chandigarh',           emoji:'🏙️', tone:'teal',   type:'ut'    },
    { code:'DN', name:'Dadra and Nagar Haveli and Daman and Diu', emoji:'🌊', tone:'cyan', type:'ut' },
    { code:'DL', name:'Delhi (NCT)',          emoji:'🏛️', tone:'saff',   type:'ut'    },
    { code:'JK', name:'Jammu and Kashmir',    emoji:'🗻', tone:'blue',   type:'ut'    },
    { code:'LA', name:'Ladakh',               emoji:'❄️', tone:'teal',   type:'ut'    },
    { code:'LD', name:'Lakshadweep',          emoji:'🐚', tone:'blue',   type:'ut'    },
    { code:'PY', name:'Puducherry',           emoji:'🌺', tone:'pink',   type:'ut'    },
  ];

  const results = await Promise.all(
    defaults.map(s => prisma.state.upsert({ where: { code: s.code }, update: s, create: s }))
  );
  res.json({ message: `Seeded ${results.length} states`, count: results.length });
});

module.exports = router;
