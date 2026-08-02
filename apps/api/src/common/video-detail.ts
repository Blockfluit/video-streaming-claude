/**
 * The viewer-safe projection of a video.
 *
 * Deliberately not `VIDEO_SELECT` (`videos/videos.service.ts`), which is the
 * *admin* shape: that one carries `storageKey`, `playbackKey`, `originalName`
 * and `probeError` — server paths and diagnostics that belong on an enrichment
 * screen and nowhere near a viewer. This is the set the title page and the
 * player need and no more.
 *
 * It lives in `common/` rather than in either feature module because two of
 * them select it — `collections/resolve.service.ts` for `/collections/:slug/resolve`
 * and `videos/videos.service.ts` for `/videos/:id/playback`. Two copies of "what
 * a viewer may see about a video" is exactly how a storage key ends up shipped
 * to the browser: someone adds a column to one list and not the other.
 */
export const VIDEO_DETAIL = {
  id: true,
  slug: true,
  title: true,
  description: true,
  tags: true,
  state: true,
  seasonId: true,
  collectionId: true,
  orderIndex: true,
  durationSec: true,
  width: true,
  height: true,
  thumbnailKey: true,
  introStartSec: true,
  introEndSec: true,
  outroStartSec: true,
  outroEndSec: true,
} as const;
