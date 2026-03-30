/**
 * Seed Kids Zone content from Angular asset JSON files into KidsContent table.
 * Run: node scripts/seed-kids.js
 */
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const prisma = require('../src/lib/prisma');

const ASSETS = path.resolve(__dirname, '../../indiaph/src/assets/data/kids');

// ── helpers ──────────────────────────────────────────────────────────────────

function j(v, fallback = []) {
  if (Array.isArray(v)) return JSON.stringify(v);
  if (typeof v === 'object' && v !== null) return JSON.stringify(v);
  return JSON.stringify(fallback);
}

function slug(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

async function upsert(item) {
  const id = item.id || `${item.type}-${item.slug}`;
  await prisma.kidsContent.upsert({
    where: { slug: item.slug },
    create: item,
    update: { ...item, id: undefined },
  });
}

// ── STORIES ──────────────────────────────────────────────────────────────────

async function seedStories() {
  const listFile = path.join(ASSETS, 'stories/kids-stories.json');
  const list = readJson(listFile);
  if (!list) { console.log('⚠  stories list not found'); return 0; }

  const items = list.items || list.stories || [];
  let count = 0;

  for (const item of items) {
    const storySlug = item.slug || item.id?.replace('story-', '');
    const detailFile = path.join(ASSETS, `stories/${storySlug}.json`);
    const detail = readJson(detailFile);
    const storyData = detail?.story || {};
    const content   = storyData.content || {};

    const record = {
      id:            item.id || `story-${storySlug}`,
      slug:          storySlug,
      type:          'story',
      title:         storyData.title  || item.title  || '',
      emoji:         storyData.emoji  || item.emoji  || '📖',
      summary:       storyData.summary || item.summary || '',
      festivalSlugs: j(storyData.festivalSlugs || item.festivalSlugs || []),
      ageGroup:      j(storyData.ageGroup      || item.ageGroup      || []),
      featured:      storyData.featured ?? item.featured ?? false,
      isActive:      true,
      sortOrder:     0,
      content: JSON.stringify({
        moral:          storyData.moral  || item.moral  || content.moral  || '',
        heroImage:      storyData.heroImage || content.heroImage || '',
        paragraphs:     content.paragraphs     || [],
        takeawayPoints: content.takeawayPoints || [],
        intro:          content.intro          || '',
        parentNote:     content.parentNote     || '',
        teacherNote:    content.teacherNote    || '',
        readTime:       storyData.readTime     || '',
        theme:          storyData.theme        || '',
      }),
    };

    await upsert(record);
    count++;
  }
  return count;
}

// ── QUIZZES ───────────────────────────────────────────────────────────────────

async function seedQuizzes() {
  const listFile = path.join(ASSETS, 'quizzes/kids-quiz-list.json');
  const list = readJson(listFile);
  if (!list) { console.log('⚠  quiz list not found'); return 0; }

  const packs = list.summaryPacks || list.items || [];
  let count = 0;

  for (const pack of packs) {
    const qSlug = pack.slug;
    const detailFile = path.join(ASSETS, `quizzes/${qSlug}.json`);
    const detail = readJson(detailFile);
    const packData = detail?.pack || {};

    const rawQuestions = packData.questions || [];
    const questions = rawQuestions.map(q => ({
      q:           q.question || q.q || '',
      options:     q.options  || [],
      correct:     q.answerIndex ?? q.correct ?? 0,
      explanation: q.explanation || '',
    }));

    const record = {
      id:            `quiz-${qSlug}`,
      slug:          qSlug,
      type:          'quiz',
      title:         packData.title       || pack.title       || '',
      emoji:         packData.emoji       || pack.emoji       || '🧩',
      summary:       packData.description || pack.description || '',
      festivalSlugs: j(packData.festivalSlugs || pack.festivalSlugs || []),
      ageGroup:      j(packData.ageGroup      || pack.ageGroup      || ['4-7','8-12']),
      featured:      packData.featured ?? pack.featured ?? false,
      isActive:      true,
      sortOrder:     0,
      content: JSON.stringify({
        difficulty:  packData.difficulty || pack.difficulty || 'easy',
        questions,
        questionCount: questions.length,
      }),
    };

    await upsert(record);
    count++;
  }
  return count;
}

// ── COLORING ──────────────────────────────────────────────────────────────────

async function seedColoring() {
  const listFile = path.join(ASSETS, 'coloring/kids-coloring-list.json');
  const list = readJson(listFile);
  if (!list) { console.log('⚠  coloring list not found'); return 0; }

  const items = list.items || list.coloring || [];
  let count = 0;

  for (const item of items) {
    const itemSlug = item.slug || slug(item.title);
    const record = {
      id:            `coloring-${itemSlug}`,
      slug:          itemSlug,
      type:          'coloring',
      title:         item.title   || '',
      emoji:         item.emoji   || '🎨',
      summary:       item.summary || item.description || '',
      festivalSlugs: j(item.festivalSlugs || item.festivals || []),
      ageGroup:      j(item.ageGroup || ['4-7','8-12']),
      featured:      item.featured ?? false,
      isActive:      true,
      sortOrder:     item.sortOrder || 0,
      content: JSON.stringify({
        difficulty:   item.difficulty   || item.content?.difficulty   || 'easy',
        printable:    item.printable    ?? item.content?.printable    ?? true,
        downloadable: item.downloadable ?? item.content?.downloadable ?? true,
        imageUrl:     item.imageUrl     || item.content?.imageUrl     || '',
        images:       item.images       || item.content?.images       || [],
        instructions: item.instructions || item.content?.instructions || [],
        festival:     item.festival     || (item.festivalSlugs||[])[0] || '',
      }),
    };
    await upsert(record);
    count++;
  }
  return count;
}

// ── FACTS ─────────────────────────────────────────────────────────────────────

async function seedFacts() {
  const listFile = path.join(ASSETS, 'facts/kids-facts.json');
  const list = readJson(listFile);
  if (!list) { console.log('⚠  facts not found'); return 0; }

  const items = list.items || list.facts || [];
  let count = 0;

  for (const item of items) {
    const itemSlug = item.slug || slug(item.title) + '-' + (item.id || count);
    const record = {
      id:            item.id || `fact-${itemSlug}`,
      slug:          itemSlug,
      type:          'fact',
      title:         item.title   || item.factTitle || '',
      emoji:         item.emoji   || '💡',
      summary:       item.summary || item.fact || item.text || '',
      festivalSlugs: j(item.festivalSlugs || item.festivals || []),
      ageGroup:      j(item.ageGroup || ['4-7','8-12']),
      featured:      item.featured ?? false,
      isActive:      true,
      sortOrder:     item.sortOrder || 0,
      content: JSON.stringify({
        category: item.category || item.content?.category || '',
        festival: item.festival || (item.festivalSlugs||[])[0] || '',
      }),
    };
    await upsert(record);
    count++;
  }
  return count;
}

// ── CRAFTS & GAMES (from kids-content.json) ───────────────────────────────────

async function seedCraftsAndGames() {
  const file = path.join(ASSETS, 'kids-content.json');
  const data = readJson(file);
  if (!data) { console.log('⚠  kids-content.json not found'); return [0,0]; }

  let crafts = 0, games = 0;

  for (const item of (data.crafts?.items || [])) {
    const itemSlug = item.slug || slug(item.title);
    const record = {
      id:            item.id || `craft-${itemSlug}`,
      slug:          itemSlug,
      type:          'craft',
      title:         item.title   || '',
      emoji:         item.emoji   || '✂️',
      summary:       item.summary || item.description || '',
      festivalSlugs: j(item.festivalSlugs || []),
      ageGroup:      j(item.ageGroup      || ['4-7','8-12']),
      featured:      item.featured ?? false,
      isActive:      true,
      sortOrder:     item.sortOrder || 0,
      content: JSON.stringify({
        difficulty:  item.difficulty  || item.content?.difficulty  || 'easy',
        timeMinutes: item.timeMinutes || item.content?.timeMinutes || 0,
        materials:   item.materials   || item.content?.materials   || [],
        steps:       item.steps       || item.content?.steps       || [],
        safetyNote:  item.safetyNote  || item.content?.safetyNote  || '',
        heroImage:   item.heroImage   || item.content?.heroImage   || '',
      }),
    };
    await upsert(record);
    crafts++;
  }

  for (const item of (data.games?.items || [])) {
    const itemSlug = item.slug || slug(item.title);
    const record = {
      id:            item.id || `game-${itemSlug}`,
      slug:          itemSlug,
      type:          'game',
      title:         item.title   || '',
      emoji:         item.emoji   || '🎮',
      summary:       item.summary || item.description || '',
      festivalSlugs: j(item.festivalSlugs || []),
      ageGroup:      j(item.ageGroup      || ['4-7','8-12']),
      featured:      item.featured ?? false,
      isActive:      true,
      sortOrder:     item.sortOrder || 0,
      content: JSON.stringify({
        pairs: item.pairs || item.content?.pairs || [],
      }),
    };
    await upsert(record);
    games++;
  }

  return [crafts, games];
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🌱 Seeding Kids Zone content…\n');

  const stories  = await seedStories();
  console.log(`  ✅ Stories:  ${stories}`);

  const quizzes  = await seedQuizzes();
  console.log(`  ✅ Quizzes:  ${quizzes}`);

  const coloring = await seedColoring();
  console.log(`  ✅ Coloring: ${coloring}`);

  const facts    = await seedFacts();
  console.log(`  ✅ Facts:    ${facts}`);

  const [crafts, games] = await seedCraftsAndGames();
  console.log(`  ✅ Crafts:   ${crafts}`);
  console.log(`  ✅ Games:    ${games}`);

  const total = stories + quizzes + coloring + facts + crafts + games;
  console.log(`\n🎉 Done! ${total} items seeded.`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
