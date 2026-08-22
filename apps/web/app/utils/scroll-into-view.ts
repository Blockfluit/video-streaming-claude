/**
 * Bring something into view inside whatever is scrolling it.
 *
 * `nearest` on both axes is the whole point. The default (`start`) scrolls
 * every scrollable ancestor as far as it takes, which for a pill inside the
 * admin's horizontal nav means scrolling the *page* as a side effect of
 * lining up a strip 40px tall — you tap a section and the article you were
 * reading jumps. `nearest` moves each ancestor the least it can, and moves
 * the ones already showing the target not at all.
 *
 * Guarded rather than assumed: this runs from `onMounted` in components that
 * also render on the server, and an element can be gone by the time a watcher
 * fires. A missing target is a no-op, not a crash.
 */
export interface Revealable {
  scrollIntoView: (options: ScrollIntoViewOptions) => void
}

export function reveal(target: Revealable | null | undefined): void {
  if (!target || typeof target.scrollIntoView !== 'function') return
  target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}
