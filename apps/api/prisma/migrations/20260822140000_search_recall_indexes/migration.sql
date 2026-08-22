-- The index the search's fifth branch was missing.
--
-- `20260822120000_fuzzy_catalogue_search` indexed both title columns on both
-- tables and the cast, and the search still read every row of both on every
-- keystroke. The reason is not that those indexes are wrong; it is that they
-- were unreachable. The candidate query ORed five clauses together, and Postgres
-- can answer a disjunction from indexes only when *every* branch has one —
-- `"description" ILIKE '%x%'` had none, so the whole thing became a sequential
-- scan that also computed a trigram similarity per row for its ORDER BY.
--
-- `candidates.ts` now asks the five as a `UNION`, which is what lets each branch
-- be planned on its own. Measured over 20 000 videos: 173 ms as one `OR`, 8 ms
-- as a `UNION` of the three title branches, and this index is what keeps the
-- description branch from putting the scan straight back — `gin_trgm_ops`
-- answers `ILIKE '%word%'`, which took it from 49 ms to 0.5 ms.
--
-- A trigram index cannot serve a pattern shorter than three characters, so a
-- one- or two-letter search still scans. That is the same answer it gave before
-- this migration, for the same rows, and no search anybody types is two letters
-- long.
--
-- There is deliberately **no** index for the `genres` branch. The shape that
-- would need one is an expression over `array_to_string("genres", ' ')`, and
-- Postgres refuses it: that function is STABLE rather than IMMUTABLE, the same
-- trap `unaccent()` sprang on the folded title one migration earlier. So that
-- branch scans one narrow column, which is the cost `LibraryService.genres`
-- already weighed and took.
CREATE INDEX "Collection_description_trgm_idx"
    ON "Collection" USING GIN ("description" gin_trgm_ops);
CREATE INDEX "Video_description_trgm_idx"
    ON "Video" USING GIN ("description" gin_trgm_ops);
