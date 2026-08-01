-- A video becomes a standalone entity that may belong to many collections, or none.
--
-- Season and running order were columns on Video, which only made sense while a
-- video had exactly one parent. They are properties of a *membership*: the same
-- episode can be episode 3 of a show and item 1 of a best-of row without either
-- fact overwriting the other. They move to CollectionVideo.
--
-- The library data is rebuilt rather than migrated. Every existing row was
-- shaped by the old "one top-level folder = one collection" rule, which the
-- drive level replaces — each drive would otherwise survive as a collection
-- named after a disk. Accounts, invites, sessions, people, lists and requests
-- are untouched; the rows below all hang off videos and collections.
--
-- CASCADE reaches only tables that reference these three, so Person, List, User
-- and VideoRequest keep their rows and lose the ones pointing at deleted media.
TRUNCATE TABLE "Video", "Collection", "Season" CASCADE;

-- CreateTable
CREATE TABLE "CollectionVideo" (
    "id" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "seasonId" TEXT,
    "orderIndex" INTEGER,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionVideo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CollectionVideo_collectionId_seasonId_orderIndex_idx" ON "CollectionVideo"("collectionId", "seasonId", "orderIndex");

-- CreateIndex
CREATE INDEX "CollectionVideo_videoId_idx" ON "CollectionVideo"("videoId");

-- CreateIndex
CREATE INDEX "CollectionVideo_seasonId_idx" ON "CollectionVideo"("seasonId");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionVideo_collectionId_videoId_key" ON "CollectionVideo"("collectionId", "videoId");

-- AddForeignKey
ALTER TABLE "CollectionVideo" ADD CONSTRAINT "CollectionVideo_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionVideo" ADD CONSTRAINT "CollectionVideo_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionVideo" ADD CONSTRAINT "CollectionVideo_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- DropForeignKey
ALTER TABLE "Video" DROP CONSTRAINT "Video_collectionId_fkey";

-- DropForeignKey
ALTER TABLE "Video" DROP CONSTRAINT "Video_seasonId_fkey";

-- DropIndex
DROP INDEX "Video_collectionId_seasonId_orderIndex_idx";

-- DropIndex
DROP INDEX "Video_collectionId_slug_key";

-- AlterTable
ALTER TABLE "Video" DROP COLUMN "collectionId",
DROP COLUMN "seasonId",
DROP COLUMN "orderIndex";

-- CreateIndex
-- Library-wide now: a video is addressed at /v/<slug> on its own, rather than
-- through whichever collection the visitor happened to arrive from.
CREATE UNIQUE INDEX "Video_slug_key" ON "Video"("slug");

-- AlterTable
-- A collection is a library idea, not a folder. One an admin creates by hand has
-- no folder behind it, and Postgres treats NULLs as distinct, so the unique
-- index still permits any number of them.
ALTER TABLE "Collection" ALTER COLUMN "folderKey" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Season" ALTER COLUMN "folderKey" DROP NOT NULL;
