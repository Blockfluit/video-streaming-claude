// apps/web/app/utils/zoom.ts
/**
 * Shared by `FeedbackAnnotator` and the admin screenshot viewer, which both
 * fit a natural-sized image to a container by width only (see
 * `FeedbackAnnotator`'s own comment on why: capping height too turns a tall
 * capture into an unusably thin sliver) and step a zoom multiplier on top of
 * that fit scale within fixed bounds.
 */
export function fitScale(containerWidth: number, naturalWidth: number): number {
  if (naturalWidth === 0) return 1
  return Math.min(1, containerWidth / naturalWidth)
}

export function clampZoom(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value * 100) / 100))
}
