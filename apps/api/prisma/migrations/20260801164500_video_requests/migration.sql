-- Requests: a viewer asking for something the library does not have.
--
-- Hand-written rather than generated, because two things here are outside what
-- Prisma's schema can say: the partial unique index that makes "already
-- requested" atomic, and the backfill of the new comparison columns.

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('NEW', 'SEEN', 'PROCESSING', 'NOT_AVAILABLE', 'REJECTED', 'AVAILABLE');

-- AlterTable: the comparison key "is this already in the library?" runs on.
-- Defaulted to '' so the column can be NOT NULL before the backfill below runs;
-- '' is also the sentinel the service reads as "not comparable", so a row that
-- somehow escapes the backfill matches nothing rather than matching everything.
ALTER TABLE "Collection" ADD COLUMN "normalisedTitle" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Video" ADD COLUMN "normalisedTitle" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "VideoRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "normalisedTitle" TEXT NOT NULL,
    "year" INTEGER,
    "comment" TEXT,
    "status" "RequestStatus" NOT NULL DEFAULT 'NEW',
    "adminNote" TEXT,
    "statusChangedAt" TIMESTAMP(3),
    "statusChangedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VideoRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VideoRequest_status_createdAt_idx" ON "VideoRequest"("status", "createdAt");
CREATE INDEX "VideoRequest_userId_idx" ON "VideoRequest"("userId");
CREATE INDEX "VideoRequest_normalisedTitle_idx" ON "VideoRequest"("normalisedTitle");
CREATE INDEX "Collection_normalisedTitle_idx" ON "Collection"("normalisedTitle");
CREATE INDEX "Video_normalisedTitle_idx" ON "Video"("normalisedTitle");

-- One *open* request per title, any number of settled ones.
--
-- Prisma cannot express a filtered unique index, so this is hand-added and must
-- be re-appended if the migration is ever regenerated — same standing hazard as
-- the polymorphic CHECK constraints in the init migration.
--
-- It is what makes the duplicate check atomic: the service catches the unique
-- violation rather than looking first, because check-then-write has a gap and
-- two people can submit the same title inside it. Asking again for something
-- rejected a year ago stays legal, which is why the filter is on status.
CREATE UNIQUE INDEX "VideoRequest_open_normalisedTitle_key"
    ON "VideoRequest"("normalisedTitle")
    WHERE "status" IN ('NEW', 'SEEN', 'PROCESSING');

-- AddForeignKey
ALTER TABLE "VideoRequest" ADD CONSTRAINT "VideoRequest_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- The reviewer is a footnote on the row, not its owner: deleting an admin must
-- not delete the requests they answered.
ALTER TABLE "VideoRequest" ADD CONSTRAINT "VideoRequest_statusChangedById_fkey"
    FOREIGN KEY ("statusChangedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill the comparison columns for rows that already exist.
--
-- This SQL is a one-time transcription of `normaliseTitle` in
-- packages/shared/src/title.ts, which owns the rule from here on — every write
-- goes through `titleData()`. The two agree on everything a film is likely to
-- be called: trailing bracketed year dropped, accents folded, case dropped,
-- everything that is not a letter or a digit removed.
--
-- They can differ on input NFKD decomposes and unaccent does not (a rare
-- ligature, a non-Latin script). The cost of a divergence is one request not
-- being spotted as a duplicate, and editing the title re-derives the value
-- correctly — so this is a soft edge, not a trap.
CREATE EXTENSION IF NOT EXISTS unaccent;

UPDATE "Collection"
   SET "normalisedTitle" = regexp_replace(
         lower(unaccent(regexp_replace("title", '[([]\s*(1[5-9][0-9]{2}|2[01][0-9]{2})\s*[)\]]\s*$', ''))),
         '[^a-z0-9]+', '', 'g');

UPDATE "Video"
   SET "normalisedTitle" = regexp_replace(
         lower(unaccent(regexp_replace("title", '[([]\s*(1[5-9][0-9]{2}|2[01][0-9]{2})\s*[)\]]\s*$', ''))),
         '[^a-z0-9]+', '', 'g');
