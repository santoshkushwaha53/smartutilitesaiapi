const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");
const { PrismaClient } = require("@prisma/client");
const { authMiddleware } = require("../core/middlewares/auth.middleware");

const router = express.Router();
const prisma = new PrismaClient();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const STATE_CODES = [
  "AN", "AP", "AR", "AS", "BR", "CG", "CH", "DN", "DL", "GA", "GJ", "HR", "HP", "JH",
  "JK", "KA", "KL", "LA", "LD", "MP", "MH", "MN", "ML", "MZ", "NL", "OD", "PB", "PY",
  "RJ", "SK", "TN", "TS", "TR", "UP", "UK", "WB",
];

const HOLIDAY_TYPES = new Set(["national", "state", "bank", "festival", "school"]);
const HOLIDAY_SCOPES = new Set(["gazetted", "restricted", "seasonal", "observance", "weekly-off"]);
const WISH_TYPES = new Set(["text", "image"]);
const HOLIDAY_TYPE_ALIASES = {
  regional: "state",
  stateut: "state",
  ut: "state",
  public: "national",
  observance: "festival",
};
const WISH_LANGUAGE_ALIASES = {
  english: "en",
  hindi: "hi",
  hinglish: "mixed",
  tamil: "ta",
  telugu: "te",
  bengali: "bn",
  marathi: "mr",
  gujarati: "gu",
  kannada: "kn",
  malayalam: "ml",
  punjabi: "pa",
};

function normalizeColumnName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function truthyCell(value) {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  return ["1", "y", "yes", "true", "x", "checked"].includes(normalized);
}

function parseWorkbook(file) {
  const workbook = XLSX.read(file.buffer, { type: "buffer", cellDates: true });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(firstSheet, { defval: "", raw: true });
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function toIsoFromDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function excelSerialToIso(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const parsed = XLSX.SSF.parse_date_code(value);
  if (!parsed) return "";
  return `${parsed.y}-${pad(parsed.m)}-${pad(parsed.d)}`;
}

function toIsoDate(value, row) {
  if (value instanceof Date) {
    const isoDate = toIsoFromDate(value);
    if (isoDate) return isoDate;
  }

  const serialDate = excelSerialToIso(value);
  if (serialDate) return serialDate;

  const rawDate = value ?? row.date ?? "";
  const dateValue = String(rawDate).trim();
  if (dateValue) {
    const match = dateValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) return dateValue;

    const dottedMatch = dateValue.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/);
    if (dottedMatch) {
      return `${dottedMatch[1]}-${pad(dottedMatch[2])}-${pad(dottedMatch[3])}`;
    }

    const slashMatch = dateValue.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (slashMatch) {
      const first = Number(slashMatch[1]);
      const second = Number(slashMatch[2]);
      const year = Number(slashMatch[3]);
      const month = first > 12 ? second : first;
      const day = first > 12 ? first : second;
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        return `${year}-${pad(month)}-${pad(day)}`;
      }
    }

    const parsedDate = new Date(dateValue);
    const parsedIso = toIsoFromDate(parsedDate);
    if (parsedIso) return parsedIso;
  }

  const year = Number(row.year || 0);
  const month = Number(row.month || 0);
  const day = Number(row.day || row.datevalue || 0);
  if (year && month && day) {
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  return "";
}

function pickStates(row) {
  const normalizedMap = Object.fromEntries(
    Object.entries(row).map(([key, value]) => [normalizeColumnName(key), value]),
  );

  const explicitStates = String(
    row.states || row.stateCodes || row.statecode || row.state || "",
  )
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean)
    .filter((code) => code !== "ALL");

  const fromColumns = STATE_CODES.filter((code) => truthyCell(normalizedMap[code.toLowerCase()]));
  const combined = [...new Set([...explicitStates, ...fromColumns])];
  return combined.sort();
}

function normalizeHolidayTypeValue(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return HOLIDAY_TYPE_ALIASES[normalized] || normalized;
}

function normalizeHolidayScopeValue(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeHolidayRow(row, index) {
  const date = toIsoDate(row.date, row);
  const year = Number(row.year || (date ? date.slice(0, 4) : 0));
  const title = String(row.title || row.holiday || row.name || "").trim();
  const type = normalizeHolidayTypeValue(row.type || row.holidayTypeKey || "national");
  const holidayType = normalizeHolidayScopeValue(row.holidayType || row.scope || "gazetted");
  const description = String(row.description || row.note || "").trim();
  const states = pickStates(row);

  return {
    rowNumber: index + 2,
    id: String(row.id || "").trim(),
    title,
    date,
    year,
    month: Number(row.month || 0),
    day: Number(row.day || 0),
    type,
    holidayType,
    description,
    states,
  };
}

function validateHolidayRow(row) {
  if (!row.title) return "title is required";
  if (!row.date) return "date is required (YYYY-MM-DD) or provide year/month/day";
  if (!row.year || !Number.isFinite(row.year)) return "year is required";
  if (!HOLIDAY_TYPES.has(row.type)) return `type must be one of: ${[...HOLIDAY_TYPES].join(", ")}`;
  if (!HOLIDAY_SCOPES.has(row.holidayType)) return `holidayType must be one of: ${[...HOLIDAY_SCOPES].join(", ")}`;
  return null;
}

function buildHolidayId(row) {
  if (row.id) return row.id;
  const slug = row.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const statesKey = row.states.length ? row.states.join("-").toLowerCase() : "all";
  return `${slug || "holiday"}-${statesKey}-${row.date}-${crypto.randomUUID().slice(0, 6)}`;
}

async function upsertHoliday(row) {
  const statesJson = JSON.stringify(row.states);
  const existing = row.id
    ? await prisma.holiday.findUnique({ where: { id: row.id } })
    : await prisma.holiday.findFirst({
        where: {
          title: row.title,
          date: row.date,
          type: row.type,
          states: statesJson,
        },
      });

  if (existing) {
    await prisma.holiday.update({
      where: { id: existing.id },
      data: {
        title: row.title,
        date: row.date,
        year: row.year,
        type: row.type,
        states: statesJson,
        description: row.description || null,
        holidayType: row.holidayType,
        updatedAt: new Date(),
      },
    });
    return "updated";
  }

  await prisma.holiday.create({
    data: {
      id: buildHolidayId(row),
      title: row.title,
      date: row.date,
      year: row.year,
      type: row.type,
      states: statesJson,
      description: row.description || null,
      holidayType: row.holidayType,
      updatedAt: new Date(),
    },
  });
  return "created";
}

function previewPayload(rows) {
  const columns = rows.length ? Object.keys(rows[0]) : [];
  return {
    type: "holidays",
    count: rows.length,
    columns,
    preview: rows.slice(0, 5),
  };
}

function previewPayloadFor(type, rows) {
  const columns = rows.length ? Object.keys(rows[0]) : [];
  return {
    type,
    count: rows.length,
    columns,
    preview: rows.slice(0, 5),
  };
}

function normalizeWishLanguage(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return WISH_LANGUAGE_ALIASES[normalized] || normalized || "en";
}

function normalizeWishType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return WISH_TYPES.has(normalized) ? normalized : "text";
}

function normalizeWishBase(row, index) {
  return {
    rowNumber: index + 2,
    id: String(row.id || "").trim(),
    festivalId: String(row.festivalId || row.festivalSlug || row.slug || "").trim(),
    festivalName: String(row.festivalName || row.festival || row.name || "").trim(),
    type: normalizeWishType(row.type),
    tone: String(row.tone || "family").trim() || "family",
    message: String(row.message || row.text || row.wish || "").trim(),
    language: normalizeWishLanguage(row.language || row.lang || "en"),
    imageUrl: String(row.imageUrl || row.image || "").trim(),
    thumbUrl: String(row.thumbUrl || row.thumbnail || "").trim(),
    caption: String(row.caption || row.title || "").trim(),
    tags: String(row.tags || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    sortOrder: Number(row.sortOrder || 0),
    isActive: !["false", "0", "no", "inactive"].includes(String(row.isActive ?? "true").trim().toLowerCase()),
  };
}

function expandWishRows(row, index) {
  const base = normalizeWishBase(row, index);
  const expanded = [];

  const multiLanguageEntries = Object.entries(row)
    .filter(([key, value]) => /^message_/i.test(String(key)) && String(value || "").trim())
    .map(([key, value]) => ({
      ...base,
      id: base.id ? `${base.id}-${normalizeWishLanguage(String(key).replace(/^message_/i, ""))}` : "",
      type: "text",
      language: normalizeWishLanguage(String(key).replace(/^message_/i, "")),
      message: String(value).trim(),
    }));

  if (base.message) {
    expanded.push({
      ...base,
      type: base.type === "image" && !base.message ? "image" : "text",
    });
  }

  expanded.push(...multiLanguageEntries);

  if (base.imageUrl) {
    expanded.push({
      ...base,
      id: base.id ? `${base.id}-image` : "",
      type: "image",
      language: base.language || "en",
      message: "",
    });
  }

  return expanded.filter((wish, idx, arr) =>
    arr.findIndex((candidate) =>
      candidate.type === wish.type &&
      candidate.language === wish.language &&
      candidate.message === wish.message &&
      candidate.imageUrl === wish.imageUrl
    ) === idx
  );
}

function validateWishRow(row) {
  if (!row.festivalId && !row.festivalName) return "festivalId or festivalName is required";
  if (!WISH_TYPES.has(row.type)) return `type must be one of: ${[...WISH_TYPES].join(", ")}`;
  if (row.type === "image" && !row.imageUrl) return "imageUrl is required for image wishes";
  if (row.type === "text" && !row.message) return "message is required for text wishes";
  return null;
}

async function resolveFestival(row) {
  if (row.festivalId) {
    const exact = await prisma.festival.findUnique({ where: { id: row.festivalId } });
    if (exact) return exact;
  }

  if (row.festivalName) {
    const festivals = await prisma.festival.findMany();
    return festivals.find((festival) => festival.name.toLowerCase() === row.festivalName.toLowerCase()) || null;
  }

  return null;
}

async function upsertWish(row) {
  const festival = await resolveFestival(row);
  if (!festival) {
    throw new Error("Festival not found");
  }

  const existingWishes = (() => {
    try {
      const parsed = JSON.parse(festival.wishes || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })();

  const normalizedId = row.id || `wish-${crypto.randomUUID().slice(0, 8)}`;
  const nextEntry = {
    id: normalizedId,
    type: row.type,
    language: row.language || "en",
    tone: row.tone,
    message: row.message || "",
    tags: row.tags,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    imageUrl: row.imageUrl || undefined,
    thumbUrl: row.thumbUrl || undefined,
    caption: row.caption || undefined,
  };

  const existingIndex = existingWishes.findIndex((wish) => {
    if (row.id && String(wish.id || "") === row.id) return true;
    return (
      String(wish.type || "text") === row.type &&
      String(wish.language || "en") === (row.language || "en") &&
      String(wish.message || "") === String(row.message || "") &&
      String(wish.imageUrl || "") === String(row.imageUrl || "")
    );
  });

  let result = "created";
  if (existingIndex >= 0) {
    existingWishes[existingIndex] = { ...existingWishes[existingIndex], ...nextEntry };
    result = "updated";
  } else {
    existingWishes.push(nextEntry);
  }

  await prisma.festival.update({
    where: { id: festival.id },
    data: {
      wishes: JSON.stringify(existingWishes),
      updatedAt: new Date(),
    },
  });

  return result;
}

router.post("/preview", upload.single("file"), async (req, res) => {
  try {
    const type = String(req.body.type || "").trim().toLowerCase();
    if (!req.file) {
      return res.status(400).json({ message: "File is required." });
    }

    const rows = parseWorkbook(req.file);
    if (type === "holidays") {
      return res.json(previewPayload(rows));
    }

    if (type === "wishes") {
      const expanded = rows.flatMap((row, index) => expandWishRows(row, index));
      return res.json(previewPayloadFor("wishes", expanded));
    }

    return res.status(400).json({ message: "Unsupported import type." });
  } catch (error) {
    console.error("POST /api/import/preview failed:", error);
    return res.status(500).json({ message: "Failed to preview import file." });
  }
});

router.post("/holidays", authMiddleware, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "File is required." });
    }

    const rows = parseWorkbook(req.file);
    let created = 0;
    let updated = 0;
    const errors = [];

    for (let index = 0; index < rows.length; index += 1) {
      const normalized = normalizeHolidayRow(rows[index], index);
      const validationError = validateHolidayRow(normalized);
      if (validationError) {
        errors.push({ row: String(normalized.rowNumber), error: validationError });
        continue;
      }

      try {
        const result = await upsertHoliday(normalized);
        if (result === "created") created += 1;
        else updated += 1;
      } catch (error) {
        errors.push({
          row: String(normalized.rowNumber),
          error: error instanceof Error ? error.message : "Unknown import error",
        });
      }
    }

    return res.json({
      message: "Holiday import completed",
      created,
      updated,
      total: rows.length,
      errors,
    });
  } catch (error) {
    console.error("POST /api/import/holidays failed:", error);
    return res.status(500).json({ message: "Failed to import holiday file." });
  }
});

router.post("/wishes", authMiddleware, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "File is required." });
    }

    const rows = parseWorkbook(req.file);
    const expandedRows = rows.flatMap((row, index) => expandWishRows(row, index));
    let created = 0;
    let updated = 0;
    const errors = [];

    for (const row of expandedRows) {
      const validationError = validateWishRow(row);
      if (validationError) {
        errors.push({ row: String(row.rowNumber), error: validationError });
        continue;
      }

      try {
        const result = await upsertWish(row);
        if (result === "created") created += 1;
        else updated += 1;
      } catch (error) {
        errors.push({
          row: String(row.rowNumber),
          error: error instanceof Error ? error.message : "Unknown import error",
        });
      }
    }

    return res.json({
      message: "Wishes import completed",
      created,
      updated,
      total: expandedRows.length,
      errors,
    });
  } catch (error) {
    console.error("POST /api/import/wishes failed:", error);
    return res.status(500).json({ message: "Failed to import wishes file." });
  }
});

module.exports = router;
