import { onBeforeUnmount, watch, type WatchSource } from 'vue'

/**
 * Waiting for someone to stop typing.
 *
 * Written by hand nine times across seven files before this existed — the same
 * module-scoped `let timer`, the same `clearTimeout` then `setTimeout` at 250ms,
 * the same `onBeforeUnmount` clearing it again. Six of those copies carried a
 * comment explaining that `refDebounced` is VueUse and not a dependency, which
 * is still true: this is that same handful of lines, written once.
 *
 * The teardown is the part worth centralising. Without it a timer outlives the
 * component and fires against a page that has gone, and it is exactly the line a
 * tenth copy would forget. Debouncing itself matters because a request per
 * keystroke means answers can land out of order, leaving a list showing whatever
 * the *slowest* one returned.
 */

/** The interval every search box on this site already used. */
export const DEBOUNCE_MS = 250

/**
 * Runs `callback` once the watched value has been still for `delay`.
 *
 * Deliberately not immediate on the first change: every caller here is a search
 * box, where the first keystroke is the least useful moment to ask.
 */
export function useDebounced<T>(
  source: WatchSource<T>,
  callback: (value: T) => void,
  delay: number = DEBOUNCE_MS,
): void {
  let timer: ReturnType<typeof setTimeout> | undefined

  watch(source, (value) => {
    clearTimeout(timer)
    timer = setTimeout(() => callback(value as T), delay)
  })

  onBeforeUnmount(() => clearTimeout(timer))
}

/**
 * The same thing for something that is not a ref — a scroll or resize handler.
 *
 * Returns the debounced function to hand to the listener. Its timer is cleared
 * on unmount too, which matters more here: the listener is usually removed in
 * the same hook, and a pending timer would otherwise fire just after.
 */
export function useDebouncedCallback<A extends unknown[]>(
  callback: (...args: A) => void,
  delay: number = DEBOUNCE_MS,
): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined

  onBeforeUnmount(() => clearTimeout(timer))

  return (...args: A) => {
    clearTimeout(timer)
    timer = setTimeout(() => callback(...args), delay)
  }
}
