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

function normalizeWish(raw, festival) {
  return {
    id: String(raw.id || ""),
    festivalId: festival.id,
    festivalName: festival.name,
    type: raw.type === "image" ? "image" : "text",
    language: ["en", "hi", "mixed"].includes(raw.language) ? raw.language : "en",
    tone: String(raw.tone || "family").trim() || "family",
    message: String(raw.message || "").trim(),
    tags: Array.isArray(raw.tags) ? raw.tags.map((tag) => String(tag).trim()).filter(Boolean) : [],
    isActive: raw.isActive !== false,
    sortOrder: Number(raw.sortOrder || 0),
  };
}

function normalizeWishInput(payload) {
  return {
    id: String(payload.id || "").trim() || `wish-${crypto.randomUUID().slice(0, 8)}`,
    festivalId: String(payload.festivalId || "").trim(),
    type: payload.type === "image" ? "image" : "text",
    language: ["en", "hi", "mixed"].includes(payload.language) ? payload.language : "en",
    tone: String(payload.tone || "family").trim() || "family",
    message: String(payload.message || "").trim(),
    tags: Array.isArray(payload.tags) ? payload.tags.map((tag) => String(tag).trim()).filter(Boolean) : [],
    isActive: payload.isActive !== false,
    sortOrder: Number(payload.sortOrder || 0),
  };
}

function validateWishInput(wish) {
  if (!wish.festivalId) return "Festival is required";
  if (!wish.message) return "Wish message is required";
  return null;
}

async function readFestivalWishes(festivalId) {
  const festival = await prisma.festival.findUnique({ where: { id: festivalId } });
  if (!festival) return null;
  const wishes = parseJsonArray(festival.wishes).map((wish) => normalizeWish(wish, festival));
  return { festival, wishes };
}

router.get("/", async function (_req, res) {
  try {
    const festivals = await prisma.festival.findMany({
      orderBy: [{ month: "asc" }, { day: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
    });

    const wishes = festivals.flatMap((festival) =>
      parseJsonArray(festival.wishes)
        .map((wish) => normalizeWish(wish, festival))
        .sort((a, b) => a.sortOrder - b.sortOrder || a.message.localeCompare(b.message))
    );

    return res.json(wishes);
  } catch (error) {
    console.error("GET /api/wishes failed:", error);
    return res.status(500).json({ success: false, error: "Failed to load wishes" });
  }
});

router.post("/", authMiddleware, async function (req, res) {
  try {
    const wish = normalizeWishInput(req.body || {});
    const validationError = validateWishInput(wish);
    if (validationError) return res.status(400).json({ success: false, error: validationError });

    const loaded = await readFestivalWishes(wish.festivalId);
    if (!loaded) return res.status(404).json({ success: false, error: "Festival not found" });

    const nextWishes = [...loaded.wishes, normalizeWish(wish, loaded.festival)];
    await prisma.festival.update({
      where: { id: loaded.festival.id },
      data: {
        wishes: JSON.stringify(nextWishes.map(({ festivalName, ...rest }) => rest)),
        updatedAt: new Date(),
      },
    });

    return res.status(201).json(normalizeWish(wish, loaded.festival));
  } catch (error) {
    console.error("POST /api/wishes failed:", error);
    return res.status(500).json({ success: false, error: "Failed to create wish" });
  }
});

router.put("/:id", authMiddleware, async function (req, res) {
  try {
    const wishId = String(req.params.id || "").trim();
    const wish = normalizeWishInput({ ...req.body, id: wishId });
    const validationError = validateWishInput(wish);
    if (validationError) return res.status(400).json({ success: false, error: validationError });

    const loaded = await readFestivalWishes(wish.festivalId);
    if (!loaded) return res.status(404).json({ success: false, error: "Festival not found" });

    const nextWishes = loaded.wishes.map((entry) =>
      entry.id === wishId ? normalizeWish(wish, loaded.festival) : entry
    );

    await prisma.festival.update({
      where: { id: loaded.festival.id },
      data: {
        wishes: JSON.stringify(nextWishes.map(({ festivalName, ...rest }) => rest)),
        updatedAt: new Date(),
      },
    });

    return res.json(normalizeWish(wish, loaded.festival));
  } catch (error) {
    console.error("PUT /api/wishes/:id failed:", error);
    return res.status(500).json({ success: false, error: "Failed to update wish" });
  }
});

router.delete("/:id", authMiddleware, async function (req, res) {
  try {
    const wishId = String(req.params.id || "").trim();
    if (!wishId) return res.status(400).json({ success: false, error: "Wish id is required" });

    const festivals = await prisma.festival.findMany();
    const festival = festivals.find((entry) =>
      parseJsonArray(entry.wishes).some((wish) => String(wish.id || "") === wishId)
    );

    if (!festival) return res.status(404).json({ success: false, error: "Wish not found" });

    const nextWishes = parseJsonArray(festival.wishes).filter((wish) => String(wish.id || "") !== wishId);
    await prisma.festival.update({
      where: { id: festival.id },
      data: {
        wishes: JSON.stringify(nextWishes),
        updatedAt: new Date(),
      },
    });

    return res.json({ success: true, id: wishId });
  } catch (error) {
    console.error("DELETE /api/wishes/:id failed:", error);
    return res.status(500).json({ success: false, error: "Failed to delete wish" });
  }
});

module.exports = router;
