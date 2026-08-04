-- Imported title metadata (step 19).
--
-- Purely additive: every column is nullable or defaults to an empty array, so an
-- existing library reads exactly as it did before anything is imported.
--
-- The descriptive columns land on BOTH Collection and Video on purpose. A film
-- here is a video belonging to no collection, so putting them only on Collection
-- would leave half the library unable to carry any of it.

-- AlterTable
ALTER TABLE "Collection" ADD COLUMN     "certification" TEXT,
ADD COLUMN     "episodeCount" INTEGER,
ADD COLUMN     "genres" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "imdbId" TEXT,
ADD COLUMN     "metadataUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "originalLanguage" TEXT,
ADD COLUMN     "originalTitle" TEXT,
ADD COLUMN     "releaseDate" TIMESTAMP(3),
ADD COLUMN     "seasonCount" INTEGER,
ADD COLUMN     "seriesStatus" TEXT,
ADD COLUMN     "tagline" TEXT,
ADD COLUMN     "tmdbId" INTEGER,
ADD COLUMN     "tmdbRating" DOUBLE PRECISION,
ADD COLUMN     "tmdbType" TEXT,
ADD COLUMN     "tmdbVoteCount" INTEGER;

-- AlterTable
ALTER TABLE "Video" ADD COLUMN     "certification" TEXT,
ADD COLUMN     "genres" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "imdbId" TEXT,
ADD COLUMN     "metadataUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "originalLanguage" TEXT,
ADD COLUMN     "originalTitle" TEXT,
ADD COLUMN     "releaseDate" TIMESTAMP(3),
ADD COLUMN     "tagline" TEXT,
ADD COLUMN     "tmdbId" INTEGER,
ADD COLUMN     "tmdbRating" DOUBLE PRECISION,
ADD COLUMN     "tmdbType" TEXT,
ADD COLUMN     "tmdbVoteCount" INTEGER,
ADD COLUMN     "year" INTEGER;

-- AlterTable
ALTER TABLE "Person" ADD COLUMN     "imdbCheckedAt" TIMESTAMP(3),
ADD COLUMN     "imdbId" TEXT,
ADD COLUMN     "knownFor" TEXT,
ADD COLUMN     "tmdbId" INTEGER;

-- AlterTable
ALTER TABLE "Credit" ADD COLUMN     "department" TEXT,
ADD COLUMN     "jobTitle" TEXT;

-- CreateIndex
-- Both columns are nullable and Postgres treats NULLs as distinct, so this
-- constrains only the collections that have actually been matched: any number
-- may remain unmatched, but two cannot claim the same TMDB title.
CREATE UNIQUE INDEX "Collection_tmdbType_tmdbId_key" ON "Collection"("tmdbType", "tmdbId");

-- CreateIndex
CREATE UNIQUE INDEX "Person_tmdbId_key" ON "Person"("tmdbId");
