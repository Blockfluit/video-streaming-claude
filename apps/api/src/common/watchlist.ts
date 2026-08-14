import type { PrismaService } from '../prisma/prisma.service';

/**
 * Whether one video or one collection is on a caller's My List.
 *
 * Here rather than in the watchlist module because two feature services need
 * it — `/videos/:id/stats` and `/collections/:slug/progress`, the per-caller
 * read each of those two screens already makes — and a second caller should
 * import a helper rather than reach into another feature.
 *
 * Deliberately **not** part of `GET /me/watchlist`: that endpoint is the list
 * itself, paged, and asking it "is this one saved" would mean either paging
 * through everything or teaching it a filter that exists only to answer a
 * question the screen has already asked something else.
 *
 * Neither caller may use this to *find* anything: both resolve their target
 * under `whereVisible(role)` and 404 first, so the flag cannot confirm the
 * existence of a record the caller is not allowed to see.
 */
export async function savedToList(
  prisma: PrismaService,
  userId: string,
  ref: { videoId: string } | { collectionId: string },
): Promise<boolean> {
  const saved = await prisma.watchlistItem.findFirst({
    where: { userId, ...ref },
    select: { id: true },
  });

  return saved !== null;
}
