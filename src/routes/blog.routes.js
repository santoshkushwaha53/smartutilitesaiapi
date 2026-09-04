const crypto = require("crypto");
const express = require("express");
const prisma = require("../lib/prisma");
const { authMiddleware } = require("../core/middlewares/auth.middleware");

const router = express.Router();

const IPH_SITE_ID = "indiapublicholidays";
const VALID_STATUSES = new Set(["draft", "scheduled", "published", "archived"]);
const LIST_SELECT = {
  id: true,
  slug: true,
  topicId: true,
  featured: true,
  trending: true,
  published: true,
  status: true,
  contentType: true,
  title: true,
  subtitle: true,
  author: true,
  coverEmoji: true,
  accent: true,
  featuredImage: true,
  thumbnailImage: true,
  publishedAt: true,
  readingMinutes: true,
  seoTitle: true,
  seoDescription: true,
  keywords: true,
  quickSummary: true,
  viewCount: true,
  holidayIds: true,
  festivalIds: true,
  stateCodes: true,
  relatedPostIds: true,
  createdAt: true,
  updatedAt: true,
};

function getSiteId(req) {
  const s = req.query.siteId ?? req.body?.siteId;
  return typeof s === "string" && s.trim() ? s.trim() : "smartutilitiesai";
}

function asStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item).trim()).filter(Boolean);
      }
    } catch {
      return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function resolveStatusAndPublished(body) {
  let status =
    typeof body.status === "string" && body.status.trim()
      ? body.status.trim().toLowerCase()
      : null;

  if (status && !VALID_STATUSES.has(status)) {
    status = null;
  }

  if (!status) {
    if (body.published === false) status = "draft";
    else if (body.published === true) status = "published";
    else status = "published";
  }

  const published = status === "published";
  return { status, published };
}

function postPayload(body, siteId, { forCreate = false } = {}) {
  const {
    id,
    slug,
    topicId,
    featured,
    trending,
    contentType,
    title,
    subtitle,
    author,
    coverEmoji,
    accent,
    featuredImage,
    thumbnailImage,
    publishedAt,
    readingMinutes,
    seoTitle,
    seoDescription,
    keywords,
    quickSummary,
    sections,
    faq,
    ogTitle,
    ogDescription,
    ogImage,
    canonicalUrl,
    holidayIds,
    festivalIds,
    stateCodes,
    relatedPostIds,
  } = body;

  const { status, published } = resolveStatusAndPublished(body);
  const defaultAuthor =
    siteId === IPH_SITE_ID ? "IndiaPublicHolidays" : "SmartUtilitiesAI";

  const data = {
    siteId,
    slug: String(slug || "").trim(),
    topicId: String(topicId || "").trim(),
    featured: featured === true,
    trending: trending === true,
    published,
    status,
    contentType: String(contentType || "article").trim() || "article",
    title: title || "",
    subtitle: subtitle || "",
    author: author || defaultAuthor,
    coverEmoji: coverEmoji || "📝",
    accent: accent || "blue",
    featuredImage: featuredImage || null,
    thumbnailImage: thumbnailImage || null,
    publishedAt: publishedAt || new Date().toISOString().slice(0, 10),
    readingMinutes: Number.isFinite(Number(readingMinutes))
      ? Number(readingMinutes)
      : 5,
    seoTitle: seoTitle || "",
    seoDescription: seoDescription || "",
    keywords: asStringArray(keywords),
    quickSummary: quickSummary || "",
    sections: Array.isArray(sections) ? sections : sections || [],
    faq: Array.isArray(faq) ? faq : faq || [],
    ogTitle: ogTitle || "",
    ogDescription: ogDescription || "",
    ogImage: ogImage || null,
    canonicalUrl: canonicalUrl || null,
    holidayIds: asStringArray(holidayIds),
    festivalIds: asStringArray(festivalIds),
    stateCodes: asStringArray(stateCodes).map((code) => code.toUpperCase()),
    relatedPostIds: asStringArray(relatedPostIds),
  };

  if (forCreate) {
    data.id =
      (typeof id === "string" && id.trim()) ||
      `post_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  }

  return data;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOPICS
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/topics", async (req, res) => {
  try {
    const siteId = getSiteId(req);
    const topics = await prisma.blogTopic.findMany({
      where: { siteId, ...(req.query.active === "true" ? { isActive: true } : {}) },
      orderBy: { order: "asc" },
    });
    res.json(topics);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch topics" });
  }
});

router.post("/topics", authMiddleware, async (req, res) => {
  try {
    const siteId = getSiteId(req);
    const { id, title, icon, accent, order, isActive } = req.body;
    if (!id || !title) {
      return res.status(400).json({ error: "id and title required" });
    }

    const topic = await prisma.blogTopic.upsert({
      where: { siteId_id: { siteId, id } },
      update: {
        title,
        icon,
        accent,
        order: order ?? 0,
        isActive: isActive !== false,
        updatedAt: new Date(),
      },
      create: {
        id,
        siteId,
        title,
        icon: icon || "📝",
        accent: accent || "blue",
        order: order ?? 0,
        updatedAt: new Date(),
      },
    });
    res.json(topic);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to save topic" });
  }
});

router.delete("/topics/:id", authMiddleware, async (req, res) => {
  try {
    const siteId = getSiteId(req);
    const id = req.params.id;
    await prisma.blogTopic.delete({ where: { siteId_id: { siteId, id } } });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to delete topic" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POSTS — LIST / SINGLE / RELATED
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/posts", async (req, res) => {
  try {
    const siteId = getSiteId(req);
    const topicId = req.query.topicId;
    const featured = req.query.featured;
    const trending = req.query.trending;
    const contentType = req.query.contentType;
    const status = req.query.status;
    const holidayId = req.query.holidayId;
    const festivalId = req.query.festivalId;
    const state = req.query.state;
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const includeUnpublished = req.query.includeUnpublished === "true";
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 50);
    const skip = (page - 1) * limit;

    const where = {
      siteId,
      ...(includeUnpublished
        ? {}
        : status
          ? { status: String(status) }
          : { published: true, status: "published" }),
      ...(topicId ? { topicId: String(topicId) } : {}),
      ...(featured === "true" ? { featured: true } : {}),
      ...(trending === "true" ? { trending: true } : {}),
      ...(contentType ? { contentType: String(contentType) } : {}),
      ...(holidayId
        ? { holidayIds: { array_contains: [String(holidayId)] } }
        : {}),
      ...(festivalId
        ? { festivalIds: { array_contains: [String(festivalId)] } }
        : {}),
      ...(state
        ? { stateCodes: { array_contains: [String(state).toUpperCase()] } }
        : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: "insensitive" } },
              { subtitle: { contains: search, mode: "insensitive" } },
              { quickSummary: { contains: search, mode: "insensitive" } },
              { slug: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const orderBy =
      trending === "true"
        ? [{ viewCount: "desc" }, { publishedAt: "desc" }]
        : [{ publishedAt: "desc" }];

    const [posts, total] = await Promise.all([
      prisma.blogPost.findMany({
        where,
        orderBy,
        skip,
        take: limit,
        select: LIST_SELECT,
      }),
      prisma.blogPost.count({ where }),
    ]);

    res.json({ data: posts, total, page, limit });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch posts" });
  }
});

router.get("/posts/featured", async (req, res) => {
  try {
    const siteId = getSiteId(req);
    const limit = Math.min(20, parseInt(req.query.limit, 10) || 6);
    const posts = await prisma.blogPost.findMany({
      where: {
        siteId,
        published: true,
        status: "published",
        featured: true,
      },
      orderBy: { publishedAt: "desc" },
      take: limit,
      select: LIST_SELECT,
    });
    res.json({ data: posts, total: posts.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch featured posts" });
  }
});

router.get("/posts/trending", async (req, res) => {
  try {
    const siteId = getSiteId(req);
    const limit = Math.min(20, parseInt(req.query.limit, 10) || 6);
    const posts = await prisma.blogPost.findMany({
      where: {
        siteId,
        published: true,
        status: "published",
        OR: [{ trending: true }, { viewCount: { gt: 0 } }],
      },
      orderBy: [{ trending: "desc" }, { viewCount: "desc" }, { publishedAt: "desc" }],
      take: limit,
      select: LIST_SELECT,
    });
    res.json({ data: posts, total: posts.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch trending posts" });
  }
});

// GET /api/blog/posts/holiday/:holidayId
router.get("/posts/holiday/:holidayId", async (req, res) => {
  try {
    const siteId = getSiteId(req);
    const holidayId = req.params.holidayId;
    const limit = Math.min(20, parseInt(req.query.limit, 10) || 10);
    const posts = await prisma.blogPost.findMany({
      where: {
        siteId,
        published: true,
        status: "published",
        holidayIds: { array_contains: [holidayId] },
      },
      orderBy: { publishedAt: "desc" },
      take: limit,
      select: LIST_SELECT,
    });
    res.json({ data: posts, total: posts.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch holiday posts" });
  }
});

// GET /api/blog/posts/related/:id — deterministic scoring
router.get("/posts/related/:id", async (req, res) => {
  try {
    const siteId = getSiteId(req);
    const id = req.params.id;
    const limit = Math.min(12, parseInt(req.query.limit, 10) || 6);

    const source = await prisma.blogPost.findFirst({
      where: { id, siteId },
    });
    if (!source) {
      return res.status(404).json({ error: "Post not found" });
    }

    const candidates = await prisma.blogPost.findMany({
      where: {
        siteId,
        published: true,
        status: "published",
        NOT: { id },
      },
      take: 80,
      orderBy: { publishedAt: "desc" },
      select: LIST_SELECT,
    });

    const sourceHolidays = asStringArray(source.holidayIds);
    const sourceFestivals = asStringArray(source.festivalIds);
    const sourceStates = asStringArray(source.stateCodes);
    const sourceTags = asStringArray(source.keywords);
    const sourceRelated = new Set(asStringArray(source.relatedPostIds));

    const scored = candidates
      .map((post) => {
        let score = 0;
        const holidays = asStringArray(post.holidayIds);
        const festivals = asStringArray(post.festivalIds);
        const states = asStringArray(post.stateCodes);
        const tags = asStringArray(post.keywords);

        if (sourceRelated.has(post.id)) score += 60;
        if (holidays.some((h) => sourceHolidays.includes(h))) score += 50;
        if (festivals.some((f) => sourceFestivals.includes(f))) score += 40;
        if (states.some((s) => sourceStates.includes(s))) score += 30;
        if (post.topicId === source.topicId) score += 20;
        if (post.contentType === source.contentType) score += 15;
        score += tags.filter((t) => sourceTags.includes(t)).length * 10;
        if (post.trending || post.viewCount > 0) score += 10;
        if (post.featured) score += 5;
        return { post, score };
      })
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    res.json({
      data: scored.map((row) => ({ ...row.post, score: row.score })),
      total: scored.length,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch related posts" });
  }
});

// GET /api/blog/posts/all?siteId= — full posts list including sections
router.get("/posts/all", async (req, res) => {
  try {
    const siteId = getSiteId(req);
    const posts = await prisma.blogPost.findMany({
      where: { siteId, published: true, status: "published" },
      orderBy: { publishedAt: "desc" },
    });
    res.json(posts);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch posts" });
  }
});

// GET /api/blog/posts/admin?siteId= — all posts incl. unpublished
router.get("/posts/admin", authMiddleware, async (req, res) => {
  try {
    const siteId = getSiteId(req);
    const posts = await prisma.blogPost.findMany({
      where: { siteId },
      orderBy: { publishedAt: "desc" },
    });
    res.json(posts);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch posts" });
  }
});

// GET /api/blog/posts/:slug?siteId=
router.get("/posts/:slug", async (req, res) => {
  try {
    const siteId = getSiteId(req);
    const slug = req.params.slug;
    const allowDraft = req.query.preview === "true";

    const post = await prisma.blogPost.findFirst({
      where: {
        siteId,
        slug,
        ...(allowDraft ? {} : { published: true, status: "published" }),
      },
    });

    if (!post) {
      return res.status(404).json({ error: "Post not found" });
    }

    res.json(post);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch post" });
  }
});

// POST /api/blog/posts/:id/view — increment view count (public)
router.post("/posts/:id/view", async (req, res) => {
  try {
    const id = req.params.id;
    const post = await prisma.blogPost.update({
      where: { id },
      data: { viewCount: { increment: 1 } },
      select: { id: true, viewCount: true },
    });
    res.json(post);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to record view" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POSTS — CREATE / UPDATE / DELETE / PUBLISH
// ═══════════════════════════════════════════════════════════════════════════════

router.post("/posts", authMiddleware, async (req, res) => {
  try {
    const siteId = getSiteId(req);
    const { slug, topicId, title } = req.body;
    if (!slug || !topicId || !title) {
      return res
        .status(400)
        .json({ error: "slug, topicId and title are required" });
    }
    const post = await prisma.blogPost.create({
      data: postPayload(req.body, siteId, { forCreate: true }),
    });
    res.status(201).json(post);
  } catch (e) {
    if (e.code === "P2002") {
      return res.status(409).json({ error: "Slug already exists for this site" });
    }
    console.error(e);
    res.status(500).json({ error: "Failed to create post" });
  }
});

router.put("/posts/:id", authMiddleware, async (req, res) => {
  try {
    const siteId = getSiteId(req);
    const id = req.params.id;
    const { slug, topicId, title } = req.body;
    if (!slug || !topicId || !title) {
      return res
        .status(400)
        .json({ error: "slug, topicId and title are required" });
    }
    const existing = await prisma.blogPost.findFirst({ where: { id, siteId } });
    if (!existing) {
      return res.status(404).json({ error: "Post not found" });
    }
    const post = await prisma.blogPost.update({
      where: { id },
      data: postPayload(req.body, siteId),
    });
    res.json(post);
  } catch (e) {
    if (e.code === "P2002") {
      return res.status(409).json({ error: "Slug already exists for this site" });
    }
    console.error(e);
    res.status(500).json({ error: "Failed to update post" });
  }
});

router.post("/posts/:id/publish", authMiddleware, async (req, res) => {
  try {
    const siteId = getSiteId(req);
    const id = req.params.id;
    const existing = await prisma.blogPost.findFirst({ where: { id, siteId } });
    if (!existing) {
      return res.status(404).json({ error: "Post not found" });
    }
    const publishedAt =
      req.body?.publishedAt ||
      existing.publishedAt ||
      new Date().toISOString().slice(0, 10);
    const post = await prisma.blogPost.update({
      where: { id },
      data: { status: "published", published: true, publishedAt },
    });
    res.json(post);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to publish post" });
  }
});

router.post("/posts/:id/unpublish", authMiddleware, async (req, res) => {
  try {
    const siteId = getSiteId(req);
    const id = req.params.id;
    const existing = await prisma.blogPost.findFirst({ where: { id, siteId } });
    if (!existing) {
      return res.status(404).json({ error: "Post not found" });
    }
    const post = await prisma.blogPost.update({
      where: { id },
      data: { status: "draft", published: false },
    });
    res.json(post);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to unpublish post" });
  }
});

router.post("/posts/:id/duplicate", authMiddleware, async (req, res) => {
  try {
    const siteId = getSiteId(req);
    const id = req.params.id;
    const existing = await prisma.blogPost.findFirst({ where: { id, siteId } });
    if (!existing) {
      return res.status(404).json({ error: "Post not found" });
    }

    const copySlug = `${existing.slug}-copy-${Date.now().toString(36)}`;
    const post = await prisma.blogPost.create({
      data: postPayload(
        {
          ...existing,
          slug: copySlug,
          title: `${existing.title} (Copy)`,
          status: "draft",
          published: false,
          featured: false,
          trending: false,
          viewCount: 0,
        },
        siteId,
        { forCreate: true }
      ),
    });
    res.status(201).json(post);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to duplicate post" });
  }
});

router.delete("/posts/:id", authMiddleware, async (req, res) => {
  try {
    const siteId = getSiteId(req);
    const id = req.params.id;
    const existing = await prisma.blogPost.findFirst({ where: { id, siteId } });
    if (!existing) {
      return res.status(404).json({ error: "Post not found" });
    }
    await prisma.blogPost.delete({ where: { id } });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to delete post" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// BULK IMPORT — seed topics + posts from JSON
// ═══════════════════════════════════════════════════════════════════════════════

router.post("/import", authMiddleware, async (req, res) => {
  try {
    const siteId = getSiteId(req);
    const { topics = [], posts = [] } = req.body;

    let topicsUpserted = 0;
    let postsUpserted = 0;

    for (const t of topics) {
      if (!t.id || !t.title) continue;
      await prisma.blogTopic.upsert({
        where: { siteId_id: { siteId, id: t.id } },
        update: {
          title: t.title,
          icon: t.icon,
          accent: t.accent,
          order: t.order ?? 0,
          isActive: t.isActive !== false,
          updatedAt: new Date(),
        },
        create: {
          id: t.id,
          siteId,
          title: t.title,
          icon: t.icon || "📝",
          accent: t.accent || "blue",
          order: t.order ?? 0,
          updatedAt: new Date(),
        },
      });
      topicsUpserted++;
    }

    for (const p of posts) {
      if (!p.slug || !p.topicId || !p.title) continue;
      const data = postPayload(p, siteId, { forCreate: true });
      await prisma.blogPost.upsert({
        where: { siteId_slug: { siteId, slug: p.slug } },
        update: postPayload(p, siteId),
        create: data,
      });
      postsUpserted++;
    }

    res.json({ topicsUpserted, postsUpserted });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Import failed", detail: e.message });
  }
});

// Seed Explore categories for IndiaPublicHolidays
router.post("/seed/indiapublicholidays", authMiddleware, async (_req, res) => {
  try {
    const siteId = IPH_SITE_ID;
    const topics = [
      { id: "iph-holiday-ideas", title: "Holiday Ideas", icon: "💡", accent: "saffron", order: 1 },
      { id: "iph-long-weekend", title: "Long Weekend", icon: "🌴", accent: "green", order: 2 },
      { id: "iph-travel", title: "Travel", icon: "🧳", accent: "blue", order: 3 },
      { id: "iph-family", title: "Family", icon: "👨‍👩‍👧‍👦", accent: "pink", order: 4 },
      { id: "iph-festival", title: "Festival", icon: "🪔", accent: "gold", order: 5 },
      { id: "iph-culture", title: "Culture", icon: "🏛️", accent: "navy", order: 6 },
      { id: "iph-history", title: "History", icon: "📜", accent: "brown", order: 7 },
      { id: "iph-lifestyle", title: "Lifestyle", icon: "🌿", accent: "teal", order: 8 },
      { id: "iph-quick-reads", title: "Quick Reads", icon: "⚡", accent: "orange", order: 9 },
      { id: "iph-did-you-know", title: "Did You Know", icon: "✨", accent: "purple", order: 10 },
    ];

    let topicsUpserted = 0;
    for (const t of topics) {
      await prisma.blogTopic.upsert({
        where: { siteId_id: { siteId, id: t.id } },
        update: {
          title: t.title,
          icon: t.icon,
          accent: t.accent,
          order: t.order,
          isActive: true,
          updatedAt: new Date(),
        },
        create: {
          id: t.id,
          siteId,
          title: t.title,
          icon: t.icon,
          accent: t.accent,
          order: t.order,
          updatedAt: new Date(),
        },
      });
      topicsUpserted++;
    }

    res.json({ siteId, topicsUpserted, topics });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to seed IPH topics", detail: e.message });
  }
});

module.exports = router;
