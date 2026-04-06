const express = require('express');
const { Prisma } = require('@prisma/client');
const prisma = require('../lib/prisma');

const router = express.Router();

function getSiteId(req) {
  const s = req.query.siteId;
  return typeof s === 'string' && s.trim() ? s.trim() : 'smartutilitiesai';
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&apos;');
}

router.get('/pages', async (req, res) => {
  try {
    const siteId = getSiteId(req);
    const routePath = typeof req.query.path === 'string' ? req.query.path : undefined;

    if (routePath) {
      const record = await prisma.seoPage.findUnique({
        where: { siteId_routePath: { siteId, routePath } },
      });
      return res.json(record ?? null);
    }

    const [data, total] = await prisma.$transaction([
      prisma.seoPage.findMany({
        where: { siteId },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.seoPage.count({ where: { siteId } }),
    ]);

    res.json({ data, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch SEO pages' });
  }
});

router.post('/pages', async (req, res) => {
  try {
    const siteId = getSiteId(req);
    const record = await prisma.seoPage.create({ data: { ...req.body, siteId } });
    res.status(201).json(record);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'Failed to create SEO page', detail: String(err) });
  }
});

router.put('/pages/:id', async (req, res) => {
  try {
    const siteId = getSiteId(req);
    const record = await prisma.seoPage.update({
      where: { id: req.params.id },
      data: { ...req.body, siteId },
    });
    res.json(record);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'Failed to update SEO page', detail: String(err) });
  }
});

router.delete('/pages/:id', async (req, res) => {
  try {
    await prisma.seoPage.delete({
      where: { id: req.params.id },
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'Failed to delete SEO page', detail: String(err) });
  }
});

router.post('/pages/bulk-upsert', async (req, res) => {
  const { records } = req.body;
  const siteId = getSiteId(req);

  if (!Array.isArray(records)) {
    return res.status(400).json({ error: "Body must contain a 'records' array" });
  }

  let inserted = 0;
  let updated = 0;
  const errors = [];

  for (const record of records) {
    try {
      const jsonLd = record.jsonLd === null ? Prisma.JsonNull : record.jsonLd;
      const data = { ...record, siteId, jsonLd };

      await prisma.seoPage.upsert({
        where: { siteId_routePath: { siteId, routePath: record.routePath } },
        create: data,
        update: data,
      });

      const existing = await prisma.seoPage.findUnique({
        where: { siteId_routePath: { siteId, routePath: record.routePath } },
        select: { createdAt: true, updatedAt: true },
      });

      const age = existing
        ? Math.abs(existing.updatedAt.getTime() - existing.createdAt.getTime())
        : 0;

      if (age < 500) inserted++;
      else updated++;
    } catch (err) {
      errors.push(`routePath="${record.routePath}": ${String(err)}`);
    }
  }

  res.json({ inserted, updated, errors });
});

router.post('/sitemap/regenerate', async (req, res) => {
  try {
    const siteId = getSiteId(req);

    const SITE_BASES = {
      smartutilitiesai: 'https://smartutilitiesai.com',
      indiaholidays: 'https://indiaholidays.com',
    };
    const BASE = SITE_BASES[siteId] ?? 'https://smartutilitiesai.com';

    const pages = await prisma.seoPage.findMany({
      where: { siteId, isActive: true },
      select: { routePath: true, canonicalPath: true, updatedAt: true },
      orderBy: { routePath: 'asc' },
    });

    const today = new Date().toISOString().split('T')[0];

    const priority = (path) => {
      const depth = path.split('/').filter(Boolean).length;
      if (depth === 0) return '1.0';
      if (depth === 1) return '0.9';
      if (depth === 2) return '0.8';
      return '0.6';
    };

    const urlEntries = pages.map((p) => {
      const loc = `${BASE}${p.canonicalPath || p.routePath}`;
      const lastmod = p.updatedAt ? p.updatedAt.toISOString().split('T')[0] : today;
      return [
        '  <url>',
        `    <loc>${escapeXml(loc)}</loc>`,
        `    <lastmod>${lastmod}</lastmod>`,
        `    <changefreq>weekly</changefreq>`,
        `    <priority>${priority(p.routePath)}</priority>`,
        '  </url>',
      ].join('\n');
    });

    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
      '        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
      '        xsi:schemaLocation="http://www.sitemaps.org/schemas/sitemap/0.9',
      '        http://www.sitemaps.org/schemas/sitemap/0.9/sitemap.xsd">',
      ...urlEntries,
      '</urlset>',
    ].join('\n');

    res.json({ url: `${BASE}/sitemap.xml`, xml, count: pages.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Sitemap generation failed', detail: String(err) });
  }
});

module.exports = router;
