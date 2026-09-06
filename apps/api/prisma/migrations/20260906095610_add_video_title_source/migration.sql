-- CreateEnum
CREATE TYPE "TitleSource" AS ENUM ('AUTO', 'MANUAL');

-- AlterTable
ALTER TABLE "Video" ADD COLUMN     "titleSource" "TitleSource" NOT NULL DEFAULT 'AUTO';
