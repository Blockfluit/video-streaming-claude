-- CreateEnum
CREATE TYPE "RowSource" AS ENUM ('MANUAL', 'RECENTLY_ADDED', 'TRENDING', 'MOST_VIEWED', 'CONTINUE_WATCHING', 'MY_LIST');

-- CreateEnum
CREATE TYPE "RowKind" AS ENUM ('AUTO', 'COLLECTIONS', 'VIDEOS');

-- AlterTable
ALTER TABLE "CuratedList" ADD COLUMN     "kind" "RowKind" NOT NULL DEFAULT 'AUTO',
ADD COLUMN     "maxItems" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "source" "RowSource" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "windowDays" INTEGER;

-- CreateIndex
CREATE INDEX "CuratedList_position_idx" ON "CuratedList"("position");

-- CreateIndex
CREATE INDEX "WatchEvent_createdAt_idx" ON "WatchEvent"("createdAt");

-- Prisma cannot express a partial unique index, so this half is hand-written and
-- has to be re-appended if this migration is ever regenerated — the same warning
-- as VideoRequest's open-request index and the polymorphic CHECK constraints.
--
-- The personal sources resolve per caller, so a second Continue Watching row is
-- not a configuration anyone wants: it is the same shelf twice. Filtered to those
-- two, because every other source is legitimately repeatable — two trending rows
-- over different windows and tags is the point.
CREATE UNIQUE INDEX "CuratedList_personal_source_key" ON "CuratedList"("source")
    WHERE "source" IN ('CONTINUE_WATCHING', 'MY_LIST');

-- Continue Watching and My List were hardcoded above the curated rows on the home
-- page. They become rows here, and these two inserts are what stop that being a
-- visible change: they land at 0 and 1, ahead of everything that already exists,
-- so the page renders exactly as it did until an admin moves something.
--
-- `position` is deliberately not unique, so shifting every row by two needs no
-- ordering care — there is nothing for it to collide with.
UPDATE "CuratedList" SET "position" = "position" + 2;

INSERT INTO "CuratedList" ("id", "slug", "title", "position", "source", "kind", "maxItems", "createdAt", "updatedAt")
VALUES
    ('seedrow_continue_watching', 'continue-watching', 'Continue watching', 0, 'CONTINUE_WATCHING', 'VIDEOS', 20, NOW(), NOW()),
    ('seedrow_my_list',           'my-list',          'My list',           1, 'MY_LIST',           'AUTO',   20, NOW(), NOW());
