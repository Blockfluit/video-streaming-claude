/**
 * Whether a trailer may start on its own.
 *
 * Split out as a pure function because it is the one piece of `<TrailerHero>`
 * worth testing: the browser tier here mounts no components deliberately, so a
 * rule living inside `onMounted` is a rule nothing checks.
 */

export interface MotionEnvironment {
  /** `matchMedia('(prefers-reduced-motion: reduce)').matches` */
  reducedMotion: boolean
  /** `navigator.connection?.saveData` */
  saveData: boolean
  /** `navigator.connection?.effectiveType`, absent in browsers without the API. */
  effectiveType?: string | null
}

/** Connections where a background video is a poor trade for the data it costs. */
const SLOW = new Set(['slow-2g', '2g', '3g'])

/**
 * False for reduced motion, save-data, or a slow connection. Unknown means yes.
 *
 * The default has to be permissive: `navigator.connection` exists only in
 * Chromium, so treating an absent reading as "slow" would mean Firefox and
 * Safari never saw a trailer and nobody would know why.
 */
export function shouldAutoplayTrailer(environment: MotionEnvironment): boolean {
  if (environment.reducedMotion) return false
  if (environment.saveData) return false

  const effectiveType = environment.effectiveType
  if (typeof effectiveType === 'string' && SLOW.has(effectiveType)) return false

  return true
}

/**
 * Reads the environment from the browser. Client-side only — `window` and
 * `navigator` do not exist in Nitro, which is why the hero decides on mount.
 */
export function readMotionEnvironment(): MotionEnvironment {
  const connection = (navigator as Navigator & {
    connection?: { saveData?: boolean, effectiveType?: string }
  }).connection

  return {
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    saveData: connection?.saveData === true,
    effectiveType: connection?.effectiveType ?? null,
  }
}
