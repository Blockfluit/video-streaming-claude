-- CreateEnum
CREATE TYPE "IngestIssueKind" AS ENUM ('ROOT_LEVEL_FILE', 'PATH_TOO_DEEP', 'UNREADABLE_SEASON', 'ORPHAN_SUBTITLE', 'AMBIGUOUS_SUBTITLE', 'UNREADABLE_FILE', 'MISSING_FILE');

-- AlterTable
ALTER TABLE "Video" ADD COLUMN     "stateBeforeMissing" "PublishState";

-- CreateTable
CREATE TABLE "IngestIssue" (
    "id" TEXT NOT NULL,
    "kind" "IngestIssueKind" NOT NULL,
    "path" TEXT NOT NULL,
    "detail" TEXT,
    "videoId" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "IngestIssue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IngestIssue_resolvedAt_idx" ON "IngestIssue"("resolvedAt");

-- CreateIndex
CREATE INDEX "IngestIssue_videoId_idx" ON "IngestIssue"("videoId");

-- CreateIndex
CREATE UNIQUE INDEX "IngestIssue_kind_path_key" ON "IngestIssue"("kind", "path");

-- AddForeignKey
ALTER TABLE "IngestIssue" ADD CONSTRAINT "IngestIssue_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;
