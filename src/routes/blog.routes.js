const express = require('express');
const prisma   = require('../lib/prisma');

const router = express.Router();

// ─── Helper ───────────────────────────────────────────────────────────────────
function getSiteId(req) {
  const s = req.query.siteId;
  return typeof s === 'string' && s.trim() ? s.trim() : 'smartutilitiesai';
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOPICS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/blog/topics?siteId=
router.get('/topics', async (req, res) => {
  try {
    const siteId = getSiteId(req);
    const topics = await prisma.blogTopic.findMany({
      where: { siteId },
      orderBy: { order: 'asc' },
    });
    res.json(topics);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch topics' });
  }
});

// POST /api/blog/topics?siteId=  — create/upsert topic
router.post('/topics', async (req, res) => {
  try {
    const siteId = getSiteId(req);
    const { id, title, icon, accent, order, isActive } = req.body;
    if (!id || !title) return res.status(400).json({ error: 'id and title required' });

    const topic = await prisma.blogTopic.upsert({
      where: { siteId_id: { siteId, id } },
      update: { title, icon, accent, order: order ?? 0, isActive: isActive !== false },
      create: { id, siteId, title, icon: icon || '📝', accent: accent || 'blue', order: order ?? 0 },
    });
    res.json(topic);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to save topic' });
  }
});

// DELETE /api/blog/topics/:id?siteId=
router.delete('/topics/:id', async (req, res) => {
  try {
    const siteId = getSiteId(req);
    const id = req.params.id;
    await prisma.blogTopic.delete({ where: { siteId_id: { siteId, id } } });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to delete topic' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POSTS — LIST / SINGLE
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/blog/posts?siteId=&topicId=&featured=true&page=1&limit=20
router.get('/posts', async (req, res) => {
  try {
    const siteId  = getSiteId(req);
    const topicId = req.query.topicId;
    const featured = req.query.featured;
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const skip  = (page - 1) * limit;

    const where = {
      siteId,
      published: true,
      ...(topicId  ? { topicId  } : {}),
      ...(featured === 'true' ? { featured: true } : {}),
    };

    const [posts, total] = await Promise.all([
      prisma.blogPost.findMany({
        where,
        orderBy: { publishedAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true, slug: true, topicId: true, featured: true,
          title: true, subtitle: true, author: true,
          coverEmoji: true, accent: true,
          publishedAt: true, readingMinutes: true,
          seoTitle: true, seoDescription: true, keywords: true,
          quickSummary: true,
        },
      }),
      prisma.blogPost.count({ where }),
    ]);

    res.json({ data: posts, total, page, limit });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

// GET /api/blog/posts/all?siteId= — full posts list including sections (for BlogStore)
router.get('/posts/all', async (req, res) => {
  try {
    const siteId = getSiteId(req);
    const posts = await prisma.blogPost.findMany({
      where: { siteId, published: true },
      orderBy: { publishedAt: 'desc' },
    });
    res.json(posts);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

// GET /api/blog/posts/admin?siteId= — all posts incl. unpublished (admin use)
router.get('/posts/admin', async (req, res) => {
  try {
    const siteId = getSiteId(req);
    const posts = await prisma.blogPost.findMany({
      where: { siteId },
      orderBy: { publishedAt: 'desc' },
    });
    res.json(posts);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

// GET /api/blog/posts/:slug?siteId=
router.get('/posts/:slug', async (req, res) => {
  try {
    const siteId = getSiteId(req);
    const slug = req.params.slug;

    const post = await prisma.blogPost.findFirst({
      where: {
        siteId,
        slug,
        published: true,
      },
    });

    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    res.json(post);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch post' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POSTS — CREATE / UPDATE / DELETE
// ═══════════════════════════════════════════════════════════════════════════════

function postPayload(body, siteId) {
  const {
    slug, topicId, featured, published, title, subtitle, author,
    coverEmoji, accent, publishedAt, readingMinutes,
    seoTitle, seoDescription, keywords, quickSummary, sections, faq,
  } = body;

  return {
    siteId,
    slug,
    topicId,
    featured:       featured !== false,
    published:      published !== false,
    title:          title || '',
    subtitle:       subtitle || '',
    author:         author  || 'SmartUtilitiesAI',
    coverEmoji:     coverEmoji || '📝',
    accent:         accent     || 'blue',
    publishedAt:    publishedAt || new Date().toISOString().slice(0, 10),
    readingMinutes: readingMinutes || 5,
    seoTitle:       seoTitle  || '',
    seoDescription: seoDescription || '',
    keywords:       keywords  || [],
    quickSummary:   quickSummary   || '',
    sections:       sections  || [],
    faq:            faq       || [],
  };
}

// POST /api/blog/posts?siteId=  — create
router.post('/posts', async (req, res) => {
  try {
    const siteId = getSiteId(req);
    const { slug, topicId, title } = req.body;
    if (!slug || !topicId || !title) {
      return res.status(400).json({ error: 'slug, topicId and title are required' });
    }
    const post = await prisma.blogPost.create({ data: postPayload(req.body, siteId) });
    res.status(201).json(post);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'Slug already exists for this site' });
    console.error(e);
    res.status(500).json({ error: 'Failed to create post' });
  }
});

// PUT /api/blog/posts/:id?siteId=  — update by DB id
router.put('/posts/:id', async (req, res) => {
  try {
    const siteId = getSiteId(req);
    const id     = req.params.id;
    const { slug, topicId, title } = req.body;
    if (!slug || !topicId || !title) {
      return res.status(400).json({ error: 'slug, topicId and title are required' });
    }
    const post = await prisma.blogPost.update({
      where: { id },
      data: postPayload(req.body, siteId),
    });
    res.json(post);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to update post' });
  }
});

// DELETE /api/blog/posts/:id?siteId=
router.delete('/posts/:id', async (req, res) => {
  try {
    const id = req.params.id;
    await prisma.blogPost.delete({ where: { id } });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to delete post' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// BULK IMPORT — seed topics + posts from JSON
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/blog/import?siteId=   body: { topics: [], posts: [] }
router.post('/import', async (req, res) => {
  try {
    const siteId  = getSiteId(req);
    const { topics = [], posts = [] } = req.body;

    let topicsUpserted = 0, postsUpserted = 0;

    // Upsert topics
    for (const t of topics) {
      if (!t.id || !t.title) continue;
      await prisma.blogTopic.upsert({
        where: { siteId_id: { siteId, id: t.id } },
        update: { title: t.title, icon: t.icon, accent: t.accent, order: t.order ?? 0 },
        create: { id: t.id, siteId, title: t.title, icon: t.icon || '📝', accent: t.accent || 'blue', order: t.order ?? 0 },
      });
      topicsUpserted++;
    }

    // Upsert posts
    for (const p of posts) {
      if (!p.slug || !p.topicId || !p.title) continue;
      await prisma.blogPost.upsert({
        where: { siteId_slug: { siteId, slug: p.slug } },
        update: postPayload(p, siteId),
        create: postPayload(p, siteId),
      });
      postsUpserted++;
    }

    res.json({ topicsUpserted, postsUpserted });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Import failed', detail: e.message });
  }
});

module.exports = router;
