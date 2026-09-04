# Explore / Blog CMS — Phase 2 (IndiaPublicHolidays)

Extends existing `BlogPost` / `BlogTopic` + `/api/blog` for the IndiaPublicHolidays discovery platform.

## Site isolation

```
siteId=indiapublicholidays
```

SmartUtilitiesAI content remains on `siteId=smartutilitiesai` (default).

## New BlogPost fields

| Field | Type | Purpose |
|---|---|---|
| `status` | string | `draft` \| `scheduled` \| `published` \| `archived` |
| `trending` | boolean | Trending strip |
| `contentType` | string | article, quick-read, holiday-guide, … |
| `featuredImage` / `thumbnailImage` | string? | Editorial images |
| `ogTitle` / `ogDescription` / `ogImage` | SEO social |
| `canonicalUrl` | string? | Canonical |
| `viewCount` | int | Popularity |
| `holidayIds` | Json[] | Related `Holiday.id` |
| `festivalIds` | Json[] | Related festival ids/slugs |
| `stateCodes` | Json[] | Related state codes |
| `relatedPostIds` | Json[] | Related posts |

`published` stays in sync with `status === "published"` for legacy clients.

## Endpoints

Public (always pass `?siteId=indiapublicholidays`):

- `GET /api/blog/topics`
- `GET /api/blog/posts` — filters: `topicId`, `featured`, `trending`, `contentType`, `status`, `holidayId`, `festivalId`, `state`, `search`, `page`, `limit`
- `GET /api/blog/posts/featured`
- `GET /api/blog/posts/trending`
- `GET /api/blog/posts/holiday/:holidayId`
- `GET /api/blog/posts/related/:id` — scored recommendations
- `GET /api/blog/posts/:slug`
- `POST /api/blog/posts/:id/view`

Admin (Bearer JWT):

- `GET /api/blog/posts/admin`
- `POST /api/blog/posts`
- `PUT /api/blog/posts/:id`
- `DELETE /api/blog/posts/:id`
- `POST /api/blog/posts/:id/publish`
- `POST /api/blog/posts/:id/unpublish`
- `POST /api/blog/posts/:id/duplicate`
- `POST /api/blog/topics` / `DELETE /api/blog/topics/:id`
- `POST /api/blog/import`
- `POST /api/blog/seed/indiapublicholidays`

## Seed topics

```bash
node scripts/seed-iph-explore-topics.js
# or
POST /api/blog/seed/indiapublicholidays
```

Topic ids are prefixed `iph-*` because `BlogTopic.id` is a global primary key.

## Migration

`prisma/migrations/20260904100000_blog_explore_fields`
