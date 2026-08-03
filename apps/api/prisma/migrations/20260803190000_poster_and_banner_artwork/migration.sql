-- Artwork becomes two shapes: a 2:3 poster and a 16:9 banner, on videos and on
-- collections.
--
-- `thumbnailKey` was ALREADY the 16:9 still — same aspect, same capture, same
-- purpose — so it is RENAMED rather than dropped and recreated beside a new
-- column. Prisma cannot see through a rename and generates the destructive pair
-- instead, which would discard every piece of artwork in the library without
-- saying so. Hand-written for the same reason as the CHECK constraints and the
-- partial unique index elsewhere in this directory: re-append it if this
-- migration is ever regenerated.
--
-- The keys are rewritten to `derived/banners/` to match. The old files under
-- `derived/thumbnails/` are left where they are: a poster has to be generated
-- for every one of these rows regardless, so the reprobe that does that writes
-- both shapes fresh, and the artwork routes serve the stock image for the moment
-- in between rather than failing.

ALTER TYPE "ThumbnailSource" RENAME TO "ArtworkSource";

ALTER TABLE "Video" RENAME COLUMN "thumbnailKey" TO "bannerKey";
ALTER TABLE "Video" RENAME COLUMN "thumbnailSource" TO "bannerSource";

UPDATE "Video"
   SET "bannerKey" = 'banners/' || substring("bannerKey" from 12)
 WHERE "bannerKey" LIKE 'thumbnails/%';

-- No backfill. A poster is a *different crop* of the frame, not a copy of the
-- banner, so there is nothing correct to put here without re-reading the file;
-- these stay null until the next probe, and the artwork routes serve the stock
-- image in the meantime rather than 404ing.
ALTER TABLE "Video" ADD COLUMN "posterKey" TEXT;
ALTER TABLE "Video" ADD COLUMN "posterSource" "ArtworkSource" NOT NULL DEFAULT 'AUTO';

-- Nullable on purpose, and null is not "no artwork": it means "no admin
-- override", and the collection then shows its first video's picture.
ALTER TABLE "Collection" ADD COLUMN "bannerKey" TEXT;
