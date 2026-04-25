const crypto = require("crypto");
const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { authMiddleware } = require("../core/middlewares/auth.middleware");

const router = express.Router();
const prisma = new PrismaClient();

function parseJsonArray(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function parseJsonObject(value, fallback = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function normalizeFestival(row) {
  return {
    id: String(row.id || ""),
    name: String(row.name || "").trim(),
    alternateName: row.alternateName || undefined,
    type: String(row.type || "cultural").trim().toLowerCase(),
    month: Number(row.month || 0),
    day: Number(row.day || 0),
    shortDesc: row.shortDesc || "",
    description: row.description || "",
    heroEmoji: row.heroEmoji || "",
    colorTone: row.colorTone || "",
    calendarType: row.calendarType || "",
    dateLabel: row.dateLabel || "",
    sortOrder: Number(row.sortOrder || 0),
    isActive: Boolean(row.isActive),
    heroImage: row.heroImage || "",
    images: parseJsonArray(row.images),
    regions: parseJsonArray(row.regions),
    statesCelebrated: parseJsonArray(row.statesCelebrated),
    tags: parseJsonArray(row.tags),
    significance: parseJsonArray(row.significance),
    whyCelebrate: parseJsonArray(row.whyCelebrate),
    howToCelebrate: parseJsonArray(row.howToCelebrate),
    rituals: parseJsonArray(row.rituals),
    foods: parseJsonArray(row.foods),
    wishes: parseJsonArray(row.wishes),
    timeline: parseJsonArray(row.timeline),
    faq: parseJsonArray(row.faq),
    cardTheme: parseJsonObject(row.cardTheme),
    seoTitle: row.seoTitle || "",
    seoDescription: row.seoDescription || "",
    seoKeywords: parseJsonArray(row.seoKeywords),
  };
}

function normalizeFestivalInput(payload) {
  const data = {
    id: String(payload.id || "").trim(),
    name: String(payload.name || "").trim(),
    alternateName: String(payload.alternateName || "").trim() || null,
    type: String(payload.type || "cultural").trim().toLowerCase(),
    month: Number(payload.month || 0),
    day: Number(payload.day || 0),
    description: String(payload.description || "").trim() || null,
    shortDesc: String(payload.shortDesc || "").trim() || null,
    heroEmoji: String(payload.heroEmoji || "").trim(),
    colorTone: String(payload.colorTone || "").trim(),
    calendarType: String(payload.calendarType || "").trim() || null,
    dateLabel: String(payload.dateLabel || "").trim() || null,
    sortOrder: Number(payload.sortOrder || 0),
    isActive: payload.isActive !== false,
    heroImage: String(payload.heroImage || "").trim() || null,
    images: JSON.stringify(parseJsonArray(payload.images)),
    regions: JSON.stringify(parseJsonArray(payload.regions)),
    statesCelebrated: JSON.stringify(parseJsonArray(payload.statesCelebrated).map((value) => String(value).trim().toUpperCase()).filter(Boolean)),
    tags: JSON.stringify(parseJsonArray(payload.tags)),
    significance: JSON.stringify(parseJsonArray(payload.significance)),
    whyCelebrate: JSON.stringify(parseJsonArray(payload.whyCelebrate)),
    howToCelebrate: JSON.stringify(parseJsonArray(payload.howToCelebrate)),
    rituals: JSON.stringify(parseJsonArray(payload.rituals)),
    foods: JSON.stringify(parseJsonArray(payload.foods)),
    wishes: JSON.stringify(parseJsonArray(payload.wishes)),
    timeline: JSON.stringify(parseJsonArray(payload.timeline)),
    faq: JSON.stringify(parseJsonArray(payload.faq)),
    cardTheme: JSON.stringify(parseJsonObject(payload.cardTheme)),
    seoTitle: String(payload.seoTitle || "").trim() || null,
    seoDescription: String(payload.seoDescription || "").trim() || null,
    seoKeywords: JSON.stringify(parseJsonArray(payload.seoKeywords)),
  };

  if (!data.id) {
    data.id = data.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || `festival-${crypto.randomUUID().slice(0, 8)}`;
  }

  return data;
}

function validateFestivalInput(festival) {
  if (!festival.name) return "Festival name is required";
  if (!festival.type) return "Festival type is required";
  if (!festival.month || !Number.isFinite(festival.month)) return "Festival month is required";
  return null;
}

router.get("/", async function (_req, res) {
  try {
    const rows = await prisma.festival.findMany({
      orderBy: [{ month: "asc" }, { day: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
    });

    return res.json({
      success: true,
      count: rows.length,
      festivals: rows.map(normalizeFestival),
    });
  } catch (error) {
    console.error("GET /api/festivals failed:", error);
    return res.status(500).json({ success: false, error: "Failed to load festivals" });
  }
});

router.get("/:id", async function (req, res) {
  try {
    const row = await prisma.festival.findUnique({ where: { id: String(req.params.id || "") } });
    if (!row) return res.status(404).json({ success: false, error: "Festival not found" });
    return res.json({ success: true, festival: normalizeFestival(row) });
  } catch (error) {
    console.error("GET /api/festivals/:id failed:", error);
    return res.status(500).json({ success: false, error: "Failed to load festival" });
  }
});

router.post("/", authMiddleware, async function (req, res) {
  try {
    const festival = normalizeFestivalInput(req.body || {});
    const validationError = validateFestivalInput(festival);
    if (validationError) return res.status(400).json({ success: false, error: validationError });

    const created = await prisma.festival.create({ data: festival });
    return res.status(201).json({ success: true, festival: normalizeFestival(created) });
  } catch (error) {
    console.error("POST /api/festivals failed:", error);
    return res.status(500).json({ success: false, error: "Failed to create festival" });
  }
});

router.put("/:id", authMiddleware, async function (req, res) {
  try {
    const festival = normalizeFestivalInput({ ...req.body, id: req.params.id });
    const validationError = validateFestivalInput(festival);
    if (validationError) return res.status(400).json({ success: false, error: validationError });

    const updated = await prisma.festival.update({
      where: { id: String(req.params.id || "") },
      data: { ...festival, id: undefined, updatedAt: new Date() },
    });

    return res.json({ success: true, festival: normalizeFestival(updated) });
  } catch (error) {
    console.error("PUT /api/festivals/:id failed:", error);
    return res.status(500).json({ success: false, error: "Failed to update festival" });
  }
});

router.delete("/:id", authMiddleware, async function (req, res) {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ success: false, error: "Festival id is required" });
    await prisma.festival.delete({ where: { id } });
    return res.json({ success: true, id });
  } catch (error) {
    console.error("DELETE /api/festivals/:id failed:", error);
    return res.status(500).json({ success: false, error: "Failed to delete festival" });
  }
});

module.exports = router;
