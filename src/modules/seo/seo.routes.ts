import { Router, Request, Response } from "express";
import { PrismaClient, Prisma } from "@prisma/client";

const router = Router();
const prisma = new PrismaClient();

// ─── GET /api/seo/pages ───────────────────────────────────────────────────────
// With ?path=/foo  → returns matching record or null
// Without filter   → returns { data: SeoPage[], total: number }
router.get("/pages", async (req: Request, res: Response) => {
  try {
    const routePathParam = req.query["path"];
    const routePath = typeof routePathParam === "string" ? routePathParam : undefined;

    if (routePath) {
      const record = await prisma.seoPage.findUnique({
        where: { routePath },
      });
      res.json(record ?? null);
      return;
    }

    const [data, total] = await prisma.$transaction([
      prisma.seoPage.findMany({ orderBy: { createdAt: "desc" } }),
      prisma.seoPage.count(),
    ]);

    res.json({ data, total });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch SEO pages" });
  }
});

// ─── POST /api/seo/pages ──────────────────────────────────────────────────────
router.post("/pages", async (req: Request, res: Response) => {
  try {
    const record = await prisma.seoPage.create({ data: req.body });
    res.status(201).json(record);
  } catch (err) {
    res.status(400).json({ error: "Failed to create SEO page", detail: String(err) });
  }
});

// ─── PUT /api/seo/pages/:id ───────────────────────────────────────────────────
router.put("/pages/:id", async (req: Request, res: Response) => {
  try {
    const id = String(req.params["id"]);
    const record = await prisma.seoPage.update({
      where: { id },
      data: req.body,
    });
    res.json(record);
  } catch (err) {
    res.status(400).json({ error: "Failed to update SEO page", detail: String(err) });
  }
});

// ─── DELETE /api/seo/pages/:id ────────────────────────────────────────────────
router.delete("/pages/:id", async (req: Request, res: Response) => {
  try {
    const id = String(req.params["id"]);
    await prisma.seoPage.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: "Failed to delete SEO page", detail: String(err) });
  }
});

// ─── POST /api/seo/pages/bulk-upsert ─────────────────────────────────────────
interface BulkUpsertRecord {
  routePath: string;
  title: string;
  description: string;
  canonicalPath: string;
  robots: string;
  ogType: string;
  ogImage: string;
  ogImageWidth: number;
  ogImageHeight: number;
  twitterCard: string;
  twitterSite?: string;
  ogSiteName: string;
  jsonLd: object | null;
  isActive: boolean;
}

function toCreateData(record: BulkUpsertRecord): Prisma.SeoPageCreateInput {
  return {
    routePath: record.routePath,
    title: record.title,
    description: record.description,
    canonicalPath: record.canonicalPath,
    robots: record.robots,
    ogType: record.ogType,
    ogImage: record.ogImage,
    ogImageWidth: record.ogImageWidth,
    ogImageHeight: record.ogImageHeight,
    twitterCard: record.twitterCard,
    twitterSite: record.twitterSite,
    ogSiteName: record.ogSiteName,
    jsonLd: record.jsonLd === null ? Prisma.JsonNull : (record.jsonLd as Prisma.InputJsonValue),
    isActive: record.isActive,
  };
}

router.post("/pages/bulk-upsert", async (req: Request, res: Response) => {
  const { records }: { records: BulkUpsertRecord[] } = req.body;

  if (!Array.isArray(records)) {
    res.status(400).json({ error: "Body must contain a 'records' array" });
    return;
  }

  let inserted = 0;
  let updated = 0;
  const errors: string[] = [];

  for (const record of records) {
    try {
      const existing = await prisma.seoPage.findUnique({
        where: { routePath: record.routePath },
        select: { id: true },
      });

      const data = toCreateData(record);

      await prisma.seoPage.upsert({
        where: { routePath: record.routePath },
        create: data,
        update: data,
      });

      if (existing) {
        updated++;
      } else {
        inserted++;
      }
    } catch (err) {
      errors.push(`routePath="${record.routePath}": ${String(err)}`);
    }
  }

  res.json({ inserted, updated, errors });
});

// ─── POST /api/seo/sitemap/regenerate ────────────────────────────────────────
router.post("/sitemap/regenerate", async (_req: Request, res: Response) => {
  res.json({ url: "https://smartutilitiesai.com/sitemap.xml" });
});

export default router;
