/**
 * The resolution badge.
 *
 * Only HD and above is called out. Below that the badge is **absent** rather
 * than shown as "SD" or "480p" — a badge exists to draw attention, and one on
 * every card draws attention to nothing.
 */

export type QualityLabel = '8K' | '4K' | 'QHD' | 'HD';

/**
 * Each tier has a minimum for the long edge and one for the short edge.
 *
 * Testing height alone would hide the badge on most cinema releases: a 1080p
 * film in 2.39:1 is 1920×800. Testing either raw dimension against either
 * threshold over-promotes portrait video: a 1080×1920 phone clip is 1080p, but
 * its 1920 height clears the QHD short-edge threshold of 1440.
 *
 * Comparing by **edge** rather than by axis gets both right, because a video's
 * resolution class does not change when you turn it on its side.
 */
const TIERS: { label: QualityLabel; longEdge: number; shortEdge: number }[] = [
  { label: '8K', longEdge: 7680, shortEdge: 4320 },
  { label: '4K', longEdge: 3840, shortEdge: 2160 },
  { label: 'QHD', longEdge: 2560, shortEdge: 1440 },
  { label: 'HD', longEdge: 1920, shortEdge: 1080 },
];

/**
 * Returns null when the video is below HD, or has not been probed yet.
 *
 * A dimension of `null` or `0` means unknown. With only one known, it is judged
 * on its own axis — that is the only thing that can be said about it.
 */
export function qualityLabel(width: number | null, height: number | null): QualityLabel | null {
  const w = width !== null && width > 0 ? width : null;
  const h = height !== null && height > 0 ? height : null;

  if (w === null && h === null) return null;

  if (w !== null && h !== null) {
    const longEdge = Math.max(w, h);
    const shortEdge = Math.min(w, h);

    return match((tier) => longEdge >= tier.longEdge || shortEdge >= tier.shortEdge);
  }

  // Only one dimension survived the probe. Judge it against its own axis:
  // a lone width of 1920 is HD, and a lone height of 1080 is also HD.
  return w !== null
    ? match((tier) => w >= tier.longEdge)
    : match((tier) => (h as number) >= tier.shortEdge);
}

function match(predicate: (tier: (typeof TIERS)[number]) => boolean): QualityLabel | null {
  return TIERS.find(predicate)?.label ?? null;
}
