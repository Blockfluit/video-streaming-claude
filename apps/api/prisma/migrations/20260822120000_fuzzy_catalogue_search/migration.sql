-- Fuzzy search over the catalogue.
--
-- `/browse` searched with ILIKE 'contains', which only ever answered somebody who
-- already spelled a title the way the library spells it. "intersteller" found
-- nothing. Neither did "reloaded matrix", "star wa", or "amelie" against "Amélie".
--
-- Trigram similarity answers all four, and a typo is the *only* one of them that
-- needs an extension: prefix, word order and accent folding are all reachable
-- without it, and no `OR` of substrings recovers a misspelling. The alternative
-- is reading every title in the library on every keystroke, which is what
-- `lists/sources/computed.ts` says belongs in SQL rather than in a bigger number.
--
-- `unaccent` is already installed by 20260801164500_video_requests, so this is
-- the second extension rather than the first. Both are contrib modules present in
-- the `postgres:17` image, and `test/db/global-setup.ts` runs `migrate deploy` as
-- the same superuser role, so `video_test` picks this up too. A hardened managed
-- Postgres that forbids CREATE EXTENSION would need it enabled out of band.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Two indexed columns per table, because neither answers the other's half, and
-- that is measured rather than assumed. Against "Star Wars: Episode IV - A New
-- Hope" the query "star wa" scores 0.875 by `word_similarity` on "title" and
-- 0.222 by `similarity` on "normalisedTitle" — below any usable threshold.
-- Against "Amélie" the query "amelie" scores 0.400 on "title" and 1.000 on
-- "normalisedTitle". Indexing either one alone loses a requirement outright.
--
--   "title"           keeps its spaces, so `word_similarity` can find a short
--                     query inside a long title regardless of word order.
--   "normalisedTitle" is what packages/shared/src/title.ts already makes of a
--                     title — accents folded, case dropped, punctuation gone —
--                     maintained on every write by `titleData()`. It is also the
--                     only *folded* form that can be indexed at all, since
--                     `unaccent()` is STABLE rather than IMMUTABLE and an index
--                     on `lower(unaccent("title"))` is refused outright.
--
-- These are declared in schema.prisma as `@@index([...], type: Gin)` with a raw
-- operator class, so unlike the CHECK constraints and the partial unique index
-- they are NOT a standing hazard — regenerating this migration re-emits them.
-- The `CREATE EXTENSION` above is the part that must be re-appended by hand.
CREATE INDEX "Collection_title_trgm_idx"
    ON "Collection" USING GIN ("title" gin_trgm_ops);
CREATE INDEX "Collection_normalisedTitle_trgm_idx"
    ON "Collection" USING GIN ("normalisedTitle" gin_trgm_ops);
CREATE INDEX "Video_title_trgm_idx"
    ON "Video" USING GIN ("title" gin_trgm_ops);
CREATE INDEX "Video_normalisedTitle_trgm_idx"
    ON "Video" USING GIN ("normalisedTitle" gin_trgm_ops);

-- The cast is searched by substring, which a unique B-tree on `name` cannot
-- answer at all.
CREATE INDEX "Person_name_trgm_idx"
    ON "Person" USING GIN ("name" gin_trgm_ops);
