-- A single admin-tunable row for app-wide settings. No seed row: a missing
-- row means "use the hardcoded default" — see apps/api/src/common/settings.ts.

-- CreateTable
CREATE TABLE "AppSettings" (
    "id" TEXT NOT NULL,
    "minTitlesForMatch" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSettings_pkey" PRIMARY KEY ("id")
);
