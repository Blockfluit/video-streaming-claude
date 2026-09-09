import type { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_MIN_TITLES_FOR_MATCH } from './match/taste-profile';

/**
 * App-wide admin settings, read and written against a single, lazily-created
 * row.
 *
 * Here rather than in `common/match/` because it isn't match-specific in
 * principle — `minTitlesForMatch` is the first field, not the only reason
 * this file exists — and keeping it out of `common/match/` is what lets that
 * module's only external dependency stay `PrismaService` itself: plain
 * functions, not a NestJS-injected service, so `match.ts` can call this the
 * same way it calls everything else in `common/`.
 *
 * No seed migration: a missing row means "use the hardcoded default," the
 * same convention a fresh install's missing `RECENTLY_ADDED` home row uses.
 */

const SETTINGS_ROW_ID = 'singleton';

export interface AppSettingsView {
  minTitlesForMatch: number;
  /** Null until the row has ever been written — there is no seed row. */
  updatedAt: Date | null;
}

export async function getSettings(prisma: PrismaService): Promise<AppSettingsView> {
  const row = await prisma.appSettings.findUnique({ where: { id: SETTINGS_ROW_ID } });

  return {
    minTitlesForMatch: row?.minTitlesForMatch ?? DEFAULT_MIN_TITLES_FOR_MATCH,
    updatedAt: row?.updatedAt ?? null,
  };
}

/** What `match.ts` actually needs on its hot path — narrower than the admin view. */
export async function getMinTitlesForMatch(prisma: PrismaService): Promise<number> {
  const row = await prisma.appSettings.findUnique({
    where: { id: SETTINGS_ROW_ID },
    select: { minTitlesForMatch: true },
  });

  return row?.minTitlesForMatch ?? DEFAULT_MIN_TITLES_FOR_MATCH;
}

export async function updateSettings(
  prisma: PrismaService,
  patch: { minTitlesForMatch: number },
): Promise<AppSettingsView> {
  const row = await prisma.appSettings.upsert({
    where: { id: SETTINGS_ROW_ID },
    create: { id: SETTINGS_ROW_ID, ...patch },
    update: patch,
  });

  return { minTitlesForMatch: row.minTitlesForMatch, updatedAt: row.updatedAt };
}
