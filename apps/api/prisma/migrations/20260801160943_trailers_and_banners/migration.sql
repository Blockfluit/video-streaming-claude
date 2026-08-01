-- AlterTable
ALTER TABLE "Collection" ADD COLUMN     "bannerKey" TEXT,
ADD COLUMN     "trailerYoutubeId" TEXT;

-- AlterTable
ALTER TABLE "Video" ADD COLUMN     "bannerKey" TEXT,
ADD COLUMN     "trailerYoutubeId" TEXT;
