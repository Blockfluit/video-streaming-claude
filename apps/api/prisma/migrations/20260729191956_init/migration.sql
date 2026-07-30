-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'USER');

-- CreateEnum
CREATE TYPE "TokenKind" AS ENUM ('BOOTSTRAP', 'INVITE');

-- CreateEnum
CREATE TYPE "PublishState" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED', 'MISSING');

-- CreateEnum
CREATE TYPE "MediaOrigin" AS ENUM ('UPLOAD', 'INGEST', 'EXTRACTED');

-- CreateEnum
CREATE TYPE "ThumbnailSource" AS ENUM ('AUTO', 'MANUAL');

-- CreateEnum
CREATE TYPE "CreditRole" AS ENUM ('ACTOR', 'DIRECTOR', 'WRITER', 'PRODUCER', 'COMPOSER', 'CINEMATOGRAPHER', 'EDITOR', 'OTHER');

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('PROBE', 'THUMBNAIL', 'TRANSCODE', 'SUBTITLE_EXTRACT');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InviteToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "kind" "TokenKind" NOT NULL DEFAULT 'INVITE',
    "grantsRole" "Role" NOT NULL DEFAULT 'USER',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "redeemedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "redeemedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InviteToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "sid" TEXT NOT NULL,
    "sess" JSONB NOT NULL,
    "expire" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
);

-- CreateTable
CREATE TABLE "Collection" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "year" INTEGER,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "posterKey" TEXT,
    "folderKey" TEXT NOT NULL,
    "state" "PublishState" NOT NULL DEFAULT 'DRAFT',
    "origin" "MediaOrigin" NOT NULL DEFAULT 'INGEST',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Collection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Season" (
    "id" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "number" INTEGER,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "posterKey" TEXT,
    "folderKey" TEXT NOT NULL,

    CONSTRAINT "Season_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Video" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "seasonId" TEXT,
    "orderIndex" INTEGER,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "state" "PublishState" NOT NULL DEFAULT 'DRAFT',
    "origin" "MediaOrigin" NOT NULL DEFAULT 'INGEST',
    "storageKey" TEXT NOT NULL,
    "contentTag" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "fileMtime" TIMESTAMP(3) NOT NULL,
    "durationSec" DOUBLE PRECISION,
    "width" INTEGER,
    "height" INTEGER,
    "videoCodec" TEXT,
    "audioCodec" TEXT,
    "audioTracks" INTEGER,
    "probedAt" TIMESTAMP(3),
    "probeError" TEXT,
    "missingSince" TIMESTAMP(3),
    "playbackKey" TEXT,
    "playbackMime" TEXT,
    "needsConversion" BOOLEAN NOT NULL DEFAULT false,
    "sourceDeletedAt" TIMESTAMP(3),
    "thumbnailKey" TEXT,
    "thumbnailSource" "ThumbnailSource" NOT NULL DEFAULT 'AUTO',
    "introStartSec" DOUBLE PRECISION,
    "introEndSec" DOUBLE PRECISION,
    "outroStartSec" DOUBLE PRECISION,
    "outroEndSec" DOUBLE PRECISION,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Video_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaJob" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "type" "JobType" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "etaSeconds" INTEGER,
    "message" TEXT,
    "error" TEXT,
    "outputKey" TEXT,
    "createdById" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subtitle" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sourceKey" TEXT,
    "sourceFormat" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "origin" "MediaOrigin" NOT NULL DEFAULT 'INGEST',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Subtitle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Person" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "bio" TEXT,
    "photoKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Credit" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "role" "CreditRole" NOT NULL,
    "characterName" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "collectionId" TEXT,
    "videoId" TEXT,

    CONSTRAINT "Credit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Comment" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "timestampSec" DOUBLE PRECISION,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WatchlistItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "collectionId" TEXT,
    "videoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WatchlistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CuratedList" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "isVisible" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CuratedList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListItem" (
    "id" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "collectionId" TEXT,
    "videoId" TEXT,

    CONSTRAINT "ListItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WatchProgress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "lastPositionSec" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "maxPositionSec" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "secondsWatched" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "firstWatchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastWatchedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WatchProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WatchEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "playSessionId" TEXT NOT NULL,
    "positionSec" DOUBLE PRECISION NOT NULL,
    "deltaSec" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WatchEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "InviteToken_tokenHash_key" ON "InviteToken"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "InviteToken_redeemedById_key" ON "InviteToken"("redeemedById");

-- CreateIndex
CREATE INDEX "session_expire_idx" ON "session"("expire");

-- CreateIndex
CREATE UNIQUE INDEX "Collection_slug_key" ON "Collection"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Collection_folderKey_key" ON "Collection"("folderKey");

-- CreateIndex
CREATE INDEX "Collection_state_idx" ON "Collection"("state");

-- CreateIndex
CREATE UNIQUE INDEX "Season_folderKey_key" ON "Season"("folderKey");

-- CreateIndex
CREATE INDEX "Season_collectionId_idx" ON "Season"("collectionId");

-- CreateIndex
CREATE UNIQUE INDEX "Season_collectionId_number_key" ON "Season"("collectionId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Season_collectionId_slug_key" ON "Season"("collectionId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "Video_storageKey_key" ON "Video"("storageKey");

-- CreateIndex
CREATE INDEX "Video_collectionId_seasonId_orderIndex_idx" ON "Video"("collectionId", "seasonId", "orderIndex");

-- CreateIndex
CREATE INDEX "Video_state_idx" ON "Video"("state");

-- CreateIndex
CREATE INDEX "Video_contentTag_idx" ON "Video"("contentTag");

-- CreateIndex
CREATE UNIQUE INDEX "Video_collectionId_slug_key" ON "Video"("collectionId", "slug");

-- CreateIndex
CREATE INDEX "MediaJob_status_createdAt_idx" ON "MediaJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "MediaJob_videoId_idx" ON "MediaJob"("videoId");

-- CreateIndex
CREATE UNIQUE INDEX "Subtitle_storageKey_key" ON "Subtitle"("storageKey");

-- CreateIndex
CREATE INDEX "Subtitle_videoId_idx" ON "Subtitle"("videoId");

-- CreateIndex
CREATE UNIQUE INDEX "Subtitle_videoId_language_label_key" ON "Subtitle"("videoId", "language", "label");

-- CreateIndex
CREATE UNIQUE INDEX "Person_slug_key" ON "Person"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Person_name_key" ON "Person"("name");

-- CreateIndex
CREATE INDEX "Credit_collectionId_idx" ON "Credit"("collectionId");

-- CreateIndex
CREATE INDEX "Credit_videoId_idx" ON "Credit"("videoId");

-- CreateIndex
CREATE INDEX "Credit_personId_idx" ON "Credit"("personId");

-- CreateIndex
CREATE INDEX "Comment_videoId_createdAt_idx" ON "Comment"("videoId", "createdAt");

-- CreateIndex
CREATE INDEX "Comment_userId_idx" ON "Comment"("userId");

-- CreateIndex
CREATE INDEX "WatchlistItem_userId_createdAt_idx" ON "WatchlistItem"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WatchlistItem_userId_collectionId_key" ON "WatchlistItem"("userId", "collectionId");

-- CreateIndex
CREATE UNIQUE INDEX "WatchlistItem_userId_videoId_key" ON "WatchlistItem"("userId", "videoId");

-- CreateIndex
CREATE UNIQUE INDEX "CuratedList_slug_key" ON "CuratedList"("slug");

-- CreateIndex
CREATE INDEX "ListItem_listId_position_idx" ON "ListItem"("listId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ListItem_listId_collectionId_key" ON "ListItem"("listId", "collectionId");

-- CreateIndex
CREATE UNIQUE INDEX "ListItem_listId_videoId_key" ON "ListItem"("listId", "videoId");

-- CreateIndex
CREATE INDEX "WatchProgress_videoId_idx" ON "WatchProgress"("videoId");

-- CreateIndex
CREATE INDEX "WatchProgress_userId_lastWatchedAt_idx" ON "WatchProgress"("userId", "lastWatchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WatchProgress_userId_videoId_key" ON "WatchProgress"("userId", "videoId");

-- CreateIndex
CREATE INDEX "WatchEvent_videoId_createdAt_idx" ON "WatchEvent"("videoId", "createdAt");

-- CreateIndex
CREATE INDEX "WatchEvent_playSessionId_idx" ON "WatchEvent"("playSessionId");

-- AddForeignKey
ALTER TABLE "InviteToken" ADD CONSTRAINT "InviteToken_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InviteToken" ADD CONSTRAINT "InviteToken_redeemedById_fkey" FOREIGN KEY ("redeemedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Season" ADD CONSTRAINT "Season_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Video" ADD CONSTRAINT "Video_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Video" ADD CONSTRAINT "Video_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Video" ADD CONSTRAINT "Video_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaJob" ADD CONSTRAINT "MediaJob_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaJob" ADD CONSTRAINT "MediaJob_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subtitle" ADD CONSTRAINT "Subtitle_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Credit" ADD CONSTRAINT "Credit_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Credit" ADD CONSTRAINT "Credit_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Credit" ADD CONSTRAINT "Credit_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchlistItem" ADD CONSTRAINT "WatchlistItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchlistItem" ADD CONSTRAINT "WatchlistItem_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchlistItem" ADD CONSTRAINT "WatchlistItem_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListItem" ADD CONSTRAINT "ListItem_listId_fkey" FOREIGN KEY ("listId") REFERENCES "CuratedList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListItem" ADD CONSTRAINT "ListItem_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListItem" ADD CONSTRAINT "ListItem_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchProgress" ADD CONSTRAINT "WatchProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchProgress" ADD CONSTRAINT "WatchProgress_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchEvent" ADD CONSTRAINT "WatchEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchEvent" ADD CONSTRAINT "WatchEvent_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-added: Prisma cannot express CHECK constraints.
--
-- ListItem, Credit and WatchlistItem are each polymorphic over exactly one of
-- (collection, video). Without these, a row can reference both or neither and
-- every consumer has to defend against a shape the schema claims is impossible.
--
-- `<>` is XOR over the two NOT NULL tests, so exactly one side must be present.
-- Keep these when regenerating this migration.
-- ---------------------------------------------------------------------------

ALTER TABLE "ListItem"      ADD CONSTRAINT list_item_exactly_one
  CHECK (("collectionId" IS NULL) <> ("videoId" IS NULL));

ALTER TABLE "Credit"        ADD CONSTRAINT credit_exactly_one
  CHECK (("collectionId" IS NULL) <> ("videoId" IS NULL));

ALTER TABLE "WatchlistItem" ADD CONSTRAINT watchlist_item_exactly_one
  CHECK (("collectionId" IS NULL) <> ("videoId" IS NULL));
