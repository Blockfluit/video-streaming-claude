/**
 * The volume the viewer chose, kept across videos and across visits.
 *
 * The player uses the browser's native controls, so the only record of a
 * viewer turning something down is `HTMLMediaElement.volume` on an element that
 * is destroyed with the page. Every video therefore opened at whatever the
 * browser felt like — which for a library watched at night is the whole point
 * of the setting.
 *
 * This half is the part worth testing: turning a string that anyone can edit
 * back into a reading the player can apply. `el.volume` **throws** a
 * `TypeError` on `NaN` or a value outside 0–1, and it is applied in
 * `onMounted`, so an unusable reading has to become `null` — "leave the
 * browser's default alone" — instead of taking the whole player down with it.
 */

/**
 * Where the reading lives. Namespaced because `localStorage` is one flat
 * cupboard shared with everything else this origin ever stores.
 */
export const VOLUME_STORAGE_KEY = 'video:player-volume'

export interface VolumeSetting {
  volume: number
  muted: boolean
}

/**
 * A stored reading, or `null` when there is nothing usable to apply.
 *
 * `muted` is kept beside the level rather than folded into it: silent and muted
 * are different states to the native control, which draws a crossed-out speaker
 * for one and restores the slider when it is turned off. Storing only a zero
 * would lose the level to come back to.
 */
export function parseVolume(raw: string | null | undefined): VolumeSetting | null {
  if (!raw) return null

  let stored: unknown
  try {
    stored = JSON.parse(raw)
  } catch {
    // Someone else's key, a half-written value, or a reading from a version of
    // this code that stored something else. Not worth a word to the viewer.
    return null
  }

  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return null

  const { volume, muted } = stored as { volume?: unknown, muted?: unknown }
  if (typeof volume !== 'number' || !Number.isFinite(volume)) return null

  return {
    volume: Math.min(1, Math.max(0, volume)),
    // Only a real `true`. Coercing would read the string `"false"` as a reason
    // to start something silently, which is the one failure a viewer notices.
    muted: muted === true,
  }
}
