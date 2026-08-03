# Configurable home-page rows

## Context

The home page is half hardcoded and half curated. `index.vue` fires four fetches and renders
Continue Watching, then My List, then whatever `CuratedList` rows an admin built by hand. A
curated row is a bag of `ListItem`s an admin picked one at a time — there is no way to say
"the ten most watched" or "what arrived this week", and no ordering by recency or views exists
anywhere in the API (every list endpoint sorts by title).

The goal is one system: every shelf on the home page is a row an admin can add, name, order,
hide, and — for the computed ones — point at a rule rather than a hand-picked set. Continue
Watching and My List stop being special cases and become rows of a personal *source*.

## Design

A row is **a source, a kind, a limit, and filters**. Manual rows keep their `ListItem`s; every
other source computes its items per request.

### Schema (`apps/api/prisma/schema.prisma`)

```prisma
enum RowSource {
  MANUAL            // hand-picked ListItems — exactly what exists today
  RECENTLY_ADDED
  TRENDING          // watched most inside a rolling window
  MOST_VIEWED       // all-time view count
  CONTINUE_WATCHING // per-user
  MY_LIST           // per-user
}

/// AUTO rolls episodes up to their show, but a collection holding one video renders as
/// that video — so a film card plays rather than landing on a collection page.
enum RowKind { AUTO  COLLECTIONS  VIDEOS }
```

`CuratedList` gains `source RowSource @default(MANUAL)`, `kind RowKind @default(AUTO)`,
`maxItems Int @default(20)`, `windowDays Int?`, `tags String[] @default([])`.

Pinned so nothing has to guess: `maxItems` is 1–50 and is **ignored by `MANUAL`**, which stays
bounded by `MAX_ITEMS_PER_LIST` (200) because its contents are chosen rather than computed.
`windowDays` is 1–365, applies to `TRENDING` alone, and defaults to 14 — long enough that a
quiet week does not empty the shelf, short enough that it still means "lately".

Hand-written into the migration, because Prisma expresses neither and regenerating drops both
(same warning as `VideoRequest` and the polymorphic CHECKs):

```sql
-- A second Continue Watching shelf is only ever a mistake.
CREATE UNIQUE INDEX "CuratedList_personal_source_key" ON "CuratedList"("source")
  WHERE "source" IN ('CONTINUE_WATCHING', 'MY_LIST');
```

Also add `@@index([createdAt])` to `WatchEvent`. Trending scans a date range across all videos
and the existing `@@index([videoId, createdAt])` is the wrong column order for that.

**Backfill in the same migration**: shift every existing row's `position` by 2, then insert
`CONTINUE_WATCHING` at 0 and `MY_LIST` at 1. The home page then renders exactly as it does
today until an admin touches it — the change ships invisible.

### Resolving a row (`apps/api/src/lists/sources/`)

Every dynamic source reduces to the same three steps: **score videos → roll up → rank**. That
shape is what makes this testable rather than four bespoke queries.

- `rank.ts` (**pure, spec first**) — `rollUpAndRank(rows, kind, limit)` over
  `{ videoId, collectionId, score }[]`. `VIDEOS` keeps videos as they are; `COLLECTIONS`/`AUTO`
  combine each collection's videos (sum for views, max for recency). Sorts by score desc then
  **id asc** — score ties are the norm and a shelf that reshuffles between requests reads as a
  rendering bug. This is where the "a show's episodes count towards the show" rule lives.
- `recent.ts` — `_max: { createdAt }` per video. A show that just got a new season *is* recently
  added; ordering collections by their own `createdAt` would bury it.
- `viewed.ts` — `MOST_VIEWED` is `watchProgress.groupBy(['videoId'], _sum: { viewCount })`.
  `TRENDING` is `watchEvent.groupBy(['videoId'], _sum: { deltaSec })` where
  `createdAt >= now - windowDays`. Trending ranks on **seconds actually watched**, not opens:
  one bounded `groupBy`, and a video someone abandoned after ten seconds does not outrank one
  they finished. Counting distinct `playSessionId`s instead would need a row per session.
- `personal.ts` — delegates to the existing `WatchService.history` and `WatchlistService.list`
  rather than restating either. `MY_LIST` already resolves `next` via `nextEpisode`; Continue
  Watching carries `progress` for the card's bar.
- `manual.ts` — today's `itemsOf`, moved unchanged.

Prisma's `groupBy` cannot roll up to `collectionId` in one query. Rather than reach for
`$queryRaw` (there is none in this codebase) or over-fetch and hope, the aggregate rows come
back for the videos the caller may see and `rollUpAndRank` does the roll-up. That is bounded by
the number of *watched* videos in a private library. Note in a comment where the SQL rewrite
goes if it ever stops being.

**Visibility**: a dynamic source spreads `whereVisible(role)` into the aggregate query, so the
filter runs *before* the limit. Manual rows can filter after the fact because the pool is small
and admin-chosen; a dynamic row cannot, or asking for ten returns three because seven were
drafts. Tag filters use the existing `tags: { has: … }` spelling from `videos.service.ts`,
spread **before** the visibility rule so they can only narrow.

### Schemas (`packages/shared/src/schemas/lists.ts`)

`createCuratedListSchema` / `updateCuratedListSchema` gain the five fields, with a
`superRefine` rejecting ones that do not apply to the chosen source — `windowDays` on a manual
row, `tags` on Continue Watching. The rule table is exported as `ROW_SOURCES` (label, which
fields apply, defaults) and the admin form renders from it, so the form and the endpoint cannot
drift about what a source accepts.

### API surface

`GET /lists` gains `source`, `kind`, `maxItems`, `windowDays`, `tags` on each row, and its item
shape becomes the superset `{ id, collection, video, next?, progress? }` — `next` and `progress`
are already produced by the watchlist and watch services. The controller passes `user.id`
alongside `user.role`; personal sources need it and every other source ignores it.

`whereVisible` still gates everything. `POST /lists/:id/items` and `PATCH /lists/:id/reorder`
refuse a non-`MANUAL` row with a 400 — its contents are not an admin's to arrange.

### Home page (`apps/web/app/pages/index.vue`)

Renders `GET /lists` in order and nothing else, so the four parallel fetches collapse to one and
the hardcoded Continue Watching / My List blocks go. The existing `card()` helper already
handles the video/collection/next cases; it gains the optional `progress` bar. The hero prefers
the first item of a `CONTINUE_WATCHING` row and falls back to `/collections?limit=1` as now —
so hiding that row also stops the hero leading with a resume, which is the coherent reading of
hiding it.

### Admin (`apps/web/app/pages/admin/lists.vue`)

"Add row" grows a source picker; the fields below it come from `ROW_SOURCES`, so a manual row
shows the item editor and a trending row shows window/limit/kind/tags. Because `GET /lists`
already resolves items, each row renders a **live preview** of what it currently contains —
which is the only way to tell what a filter combination actually does before publishing it.
Every `USelect` gets a sentinel rather than `''` (Reka UI throws on an empty value and takes the
page down) and an explicit `aria-label` naming the job, not the mechanism.

## Decisions taken while designing this

- **One row model, not two.** A dynamic row could have been a separate table beside
  `CuratedList`, but then two independent orderings have to interleave into one home page and
  neither owns the answer. A `source` discriminator keeps one ordering, one `isVisible`, one
  admin screen.
- **`AUTO` exists because every video lives in a collection.** There is no film/show flag in
  this schema — a film is a collection holding one video. `AUTO` rolls episodes up to their show
  and unwraps a one-video collection back to its video, so a film card plays instead of landing
  on a collection page. `COLLECTIONS` and `VIDEOS` are the explicit overrides.
- **Personal rows are deletable and re-addable, capped at one each.** They behave like every
  other row rather than being a second class of row with the delete button missing; a second
  Continue Watching shelf is only ever a mistake, which is what the partial unique says.
- **Trending ranks on seconds watched, not opens.** Rejected: counting distinct
  `playSessionId`s, which needs a row per session per video and rewards a bounce as much as a
  finished film.
- **Recently added keys on a collection's newest video.** Rejected: the collection's own
  `createdAt`, which buries a long-running show the week it gets a new season.

## Files

- `apps/api/prisma/schema.prisma`, plus a new migration carrying the partial unique, the
  `WatchEvent` index and the position backfill
- `apps/api/src/lists/sources/{rank,recent,viewed,personal,manual}.ts` + `rank.spec.ts`
- `apps/api/src/lists/lists.service.ts` — `list()`/`findBySlug()` dispatch on `source`;
  item-mutating methods refuse non-manual rows
- `apps/api/src/lists/lists.controller.ts`, `lists.module.ts` (imports Watch + Watchlist)
- `packages/shared/src/schemas/lists.ts` — the fields, the refinement, `ROW_SOURCES`
- `apps/web/app/pages/index.vue`, `apps/web/app/pages/admin/lists.vue`

## Verification

1. `rank.spec.ts` first, red before green: episodes summing into their show, `AUTO` unwrapping a
   one-video collection, `VIDEOS` not rolling up at all, and a score tie breaking on id.
2. `npm run test:all` — unit, stubbed-HTTP and real-Postgres tiers. The db tier is where the
   partial unique, the visibility-before-limit rule and the backfill belong; a stub cannot prove
   any of them. Give this checkout its own `TEST_DATABASE_URL=…/video_test_rows` if another
   worktree may be running.
3. `npm run test -w @video/web`, then `npm run test:e2e -w @video/web` — including
   `visible.spec.ts`, since the admin form adds controls and popovers teleported to `<body>`.
4. **In a browser, signed in as both roles** — curl proves SSR and nothing else, and both of the
   bare-array bugs in this codebase returned 200 to curl and broke on hydration. Check: a
   trending row populates after watching something; a draft never appears in any row; the home
   page still looks unchanged before any admin edit.
