const express = require("express");
const { PrismaClient } = require("@prisma/client");

const router = express.Router();
const prisma = new PrismaClient();

function parseStates(value) {
  if (Array.isArray(value)) {
    return value
      .map((v) => String(v).trim().toUpperCase())
      .filter(Boolean);
  }

  if (typeof value !== "string") return [];

  const raw = value.trim();
  if (!raw) return [];

  // try JSON array string: ["AP","AR"]
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map((v) => String(v).trim().toUpperCase())
        .filter(Boolean);
    }
  } catch (_err) {
    // ignore
  }

  // fallback: comma separated
  return raw
    .split(",")
    .map((v) => v.trim().toUpperCase())
    .filter(Boolean);
}

function normalizeHoliday(row) {
  const holidayType = String(row.holidayType || "").trim().toLowerCase();
  let type = String(row.type || "").trim().toLowerCase();
  const states = parseStates(row.states);

  if (!type) {
    if (holidayType === "restricted" || holidayType === "observance" || holidayType === "seasonal") {
      type = "festival";
    } else {
      type = "festival";
    }
  }

  let holidayClass = String(row.holidayClass || "").trim().toLowerCase();
  if (!holidayClass) {
    holidayClass = type;
  }

  const isNationalHoliday =
    Boolean(row.isNationalHoliday) ||
    type === "national" ||
    holidayClass === "national";

  const isRestrictedHoliday =
    Boolean(row.isRestrictedHoliday) ||
    holidayType === "restricted";

  const isSeasonalHoliday =
    Boolean(row.isSeasonalHoliday) ||
    holidayType === "seasonal";

  const isGazettedHoliday =
    Boolean(row.isGazettedHoliday) ||
    holidayType === "gazetted";

  return {
    id: String(row.id || ""),
    title: String(row.title || "").trim(),
    date: String(row.date || "").slice(0, 10),
    year: Number(row.year || 0),
    type,
    states,
    regionLabel: states.length ? undefined : "All India",
    description: row.description || "",
    holidayType: holidayType || undefined,
    holidayClass: holidayClass || undefined,
    isNationalHoliday,
    isGazettedHoliday,
    isRestrictedHoliday,
    isSeasonalHoliday,
    sourceType: "api",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function matchesKind(h, kind) {
  switch (kind) {
    case "all":
    case "public":
      return true;

    case "bank":
    case "bank-closures":
      return h.type === "bank" || h.holidayClass === "bank";

    case "national":
      return h.isNationalHoliday || h.type === "national" || h.holidayClass === "national";

    case "state":
      return h.type === "state" || h.holidayClass === "state";

    case "festival":
      return h.type === "festival" || h.holidayClass === "festival";

    default:
      return true;
  }
}

function matchesState(h, stateCode) {
  if (stateCode === "ALL") return true;

  const states = Array.isArray(h.states) ? h.states : [];
  if (!states.length) return true; // all-india/common holidays remain visible
  return states.includes(stateCode);
}

router.get("/", async function (req, res) {
  try {
    const year = Number(req.query.year);
    const kind = String(req.query.kind || "all").toLowerCase();
    const stateCode = String(req.query.stateCode || "ALL").toUpperCase();

    if (!Number.isFinite(year)) {
      return res.status(400).json({
        success: false,
        error: "Valid year is required",
      });
    }

    const rows = await prisma.holiday.findMany({
      where: { year },
      orderBy: [{ date: "asc" }, { title: "asc" }],
    });

    const holidays = rows
      .map(normalizeHoliday)
      .filter((h) => h.title && h.date)
      .filter((h) => matchesKind(h, kind))
      .filter((h) => matchesState(h, stateCode));

    return res.json({
      success: true,
      source: "api",
      year,
      kind,
      stateCode,
      count: holidays.length,
      holidays,
    });
  } catch (error) {
    console.error("GET /api/holidays failed:", error);

    return res.status(500).json({
      success: false,
      error: "Failed to load holidays",
    });
  }
});

module.exports = router;