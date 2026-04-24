const express = require("express");
const prisma = require("../lib/prisma");
const { authMiddleware } = require("../core/middlewares/auth.middleware");

const router = express.Router();

const CANONICAL_STATES = [
  { code: "AN", name: "Andaman and Nicobar Islands", type: "union-territory", emoji: "🏝️", tone: "ocean" },
  { code: "AP", name: "Andhra Pradesh", type: "state", emoji: "🌶️", tone: "sunrise" },
  { code: "AR", name: "Arunachal Pradesh", type: "state", emoji: "🏔️", tone: "forest" },
  { code: "AS", name: "Assam", type: "state", emoji: "🍃", tone: "tea" },
  { code: "BR", name: "Bihar", type: "state", emoji: "🌾", tone: "earth" },
  { code: "CG", name: "Chhattisgarh", type: "state", emoji: "🌿", tone: "leaf" },
  { code: "CH", name: "Chandigarh", type: "union-territory", emoji: "🏙️", tone: "lavender" },
    { code: "DL", name: "Delhi", type: "union-territory", emoji: "🏛️", tone: "royal" },
  { code: "DN", name: "Dadra and Nagar Haveli and Daman and Diu", type: "union-territory", emoji: "🌊", tone: "mint" },
  { code: "GA", name: "Goa", type: "state", emoji: "🏖️", tone: "tropical" },
  { code: "GJ", name: "Gujarat", type: "state", emoji: "🪔", tone: "sunset" },
  { code: "HP", name: "Himachal Pradesh", type: "state", emoji: "🏔️", tone: "snow" },
  { code: "HR", name: "Haryana", type: "state", emoji: "🌼", tone: "mustard" },
  { code: "JH", name: "Jharkhand", type: "state", emoji: "🌳", tone: "wood" },
  { code: "JK", name: "Jammu and Kashmir", type: "union-territory", emoji: "🏔️", tone: "saffron" },
  { code: "KA", name: "Karnataka", type: "state", emoji: "💻", tone: "indigo" },
  { code: "KL", name: "Kerala", type: "state", emoji: "🌴", tone: "emerald" },
  { code: "LA", name: "Ladakh", type: "union-territory", emoji: "🏔️", tone: "sky" },
  { code: "LD", name: "Lakshadweep", type: "union-territory", emoji: "🐚", tone: "lagoon" },
  { code: "MH", name: "Maharashtra", type: "state", emoji: "🛕", tone: "marigold" },
  { code: "ML", name: "Meghalaya", type: "state", emoji: "☁️", tone: "mist" },
  { code: "MN", name: "Manipur", type: "state", emoji: "🌺", tone: "orchid" },
  { code: "MP", name: "Madhya Pradesh", type: "state", emoji: "🐅", tone: "amber" },
  { code: "MZ", name: "Mizoram", type: "state", emoji: "🌄", tone: "peach" },
  { code: "NL", name: "Nagaland", type: "state", emoji: "🎋", tone: "pine" },
  { code: "OD", name: "Odisha", type: "state", emoji: "🌊", tone: "coral" },
  { code: "PB", name: "Punjab", type: "state", emoji: "🌾", tone: "gold" },
  { code: "PY", name: "Puducherry", type: "union-territory", emoji: "⛵", tone: "aqua" },
  { code: "RJ", name: "Rajasthan", type: "state", emoji: "🏜️", tone: "sand" },
  { code: "SK", name: "Sikkim", type: "state", emoji: "⛰️", tone: "jade" },
  { code: "TN", name: "Tamil Nadu", type: "state", emoji: "🪷", tone: "rose" },
  { code: "TR", name: "Tripura", type: "state", emoji: "🌺", tone: "berry" },
  { code: "TS", name: "Telangana", type: "state", emoji: "💎", tone: "violet" },
  { code: "UK", name: "Uttarakhand", type: "state", emoji: "🕉️", tone: "stone" },
  { code: "UP", name: "Uttar Pradesh", type: "state", emoji: "🕌", tone: "copper" },
  { code: "WB", name: "West Bengal", type: "state", emoji: "🐯", tone: "crimson" },
];

function normalizeStateInput(payload = {}) {
  return {
    code: String(payload.code || "").trim().toUpperCase(),
    name: String(payload.name || "").trim(),
    type: String(payload.type || "state").trim().toLowerCase(),
    emoji: String(payload.emoji || "").trim(),
    tone: String(payload.tone || "saff").trim() || "saff",
  };
}

function validateStateInput(state, requireCode = true) {
  if (requireCode && !state.code) {
    return "State code is required";
  }

  if (!state.name) {
    return "State name is required";
  }

  if (!["state", "union-territory"].includes(state.type)) {
    return "Type must be state or union-territory";
  }

  return null;
}

async function seedStatesIfEmpty() {
  const count = await prisma.state.count();
  if (count > 0) return count;

  await prisma.state.createMany({
    data: CANONICAL_STATES.map((state) => ({
      ...state,
      updatedAt: new Date(),
    })),
    skipDuplicates: true,
  });

  return prisma.state.count();
}

router.get("/", async (req, res) => {
  try {
    await seedStatesIfEmpty();

    const search = String(req.query.search || "").trim();
    const type = String(req.query.type || "all").trim().toLowerCase();

    const where = {
      ...(search
        ? {
            OR: [
              { code: { contains: search.toUpperCase() } },
              { name: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
      ...(type !== "all" ? { type } : {}),
    };

    const states = await prisma.state.findMany({
      where,
      orderBy: [{ type: "asc" }, { name: "asc" }],
    });

    const totals = states.reduce(
      (acc, state) => {
        if (state.type === "union-territory") acc.unionTerritories += 1;
        else acc.states += 1;
        return acc;
      },
      { states: 0, unionTerritories: 0 },
    );

    return res.json({
      success: true,
      count: states.length,
      totals,
      states,
    });
  } catch (error) {
    console.error("GET /api/states failed:", error);
    return res.status(500).json({ success: false, error: "Failed to load states" });
  }
});

router.post("/seed", authMiddleware, async (_req, res) => {
  try {
    await prisma.state.createMany({
      data: CANONICAL_STATES.map((state) => ({
        ...state,
        updatedAt: new Date(),
      })),
      skipDuplicates: true,
    });

    const count = await prisma.state.count();
    return res.status(200).json({ success: true, count });
  } catch (error) {
    console.error("POST /api/states/seed failed:", error);
    return res.status(500).json({ success: false, error: "Failed to seed states" });
  }
});

router.post("/", authMiddleware, async (req, res) => {
  try {
    const state = normalizeStateInput(req.body);
    const validationError = validateStateInput(state, true);
    if (validationError) {
      return res.status(400).json({ success: false, error: validationError });
    }

    const created = await prisma.state.create({
      data: {
        ...state,
        updatedAt: new Date(),
      },
    });

    return res.status(201).json({ success: true, state: created });
  } catch (error) {
    console.error("POST /api/states failed:", error);
    return res.status(500).json({ success: false, error: "Failed to create state" });
  }
});

router.put("/:code", authMiddleware, async (req, res) => {
  try {
    const code = String(req.params.code || "").trim().toUpperCase();
    const state = normalizeStateInput({ ...req.body, code });
    const validationError = validateStateInput(state, true);
    if (validationError) {
      return res.status(400).json({ success: false, error: validationError });
    }

    const updated = await prisma.state.update({
      where: { code },
      data: {
        name: state.name,
        type: state.type,
        emoji: state.emoji,
        tone: state.tone,
        updatedAt: new Date(),
      },
    });

    return res.json({ success: true, state: updated });
  } catch (error) {
    console.error("PUT /api/states/:code failed:", error);
    return res.status(500).json({ success: false, error: "Failed to update state" });
  }
});

router.delete("/:code", authMiddleware, async (req, res) => {
  try {
    const code = String(req.params.code || "").trim().toUpperCase();
    await prisma.state.delete({ where: { code } });
    return res.json({ success: true, code });
  } catch (error) {
    console.error("DELETE /api/states/:code failed:", error);
    return res.status(500).json({ success: false, error: "Failed to delete state" });
  }
});

module.exports = router;
