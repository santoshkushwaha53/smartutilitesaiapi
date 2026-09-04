/**
 * Phase 2 — Explore CMS seed for IndiaPublicHolidays
 *
 * Usage (API running + DATABASE_URL set):
 *   node scripts/seed-iph-explore-topics.js
 *
 * Or authenticated:
 *   POST /api/blog/seed/indiapublicholidays
 */
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const siteId = "indiapublicholidays";

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

async function main() {
  let upserted = 0;
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
    upserted += 1;
  }
  console.log(`Seeded ${upserted} Explore topics for siteId=${siteId}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
