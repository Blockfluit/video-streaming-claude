import { ref, type Ref } from 'vue'

/**
 * A search box that asks the API, where only the newest answer may win.
 *
 * `CreditsEditor` searches people and `RowEntryPicker` searches collections and
 * films. Below the query they were the same component, written twice: debounce
 * the box, stamp each request with an incrementing number, drop the answer if a
 * newer request has since gone out, and guard the results, the busy flag and the
 * error flag on that same comparison in `catch` and `finally`.
 *
 * The stamp is the part that has to be right. Without it a slow first request
 * lands after a fast second one and overwrites it, so the list settles on
 * whatever the *slowest* response returned — which looks like a flaky search
 * rather than a bug, and is why both copies had grown the same comment
 * independently.
 */

export interface RemoteSearch<T> {
  /** Bind this to the input. */
  query: Ref<string>
  results: Ref<T>
  busy: Ref<boolean>
  /** The last attempt failed. Cleared when the next one starts. */
  failed: Ref<boolean>
  /** Ask now, without waiting for the debounce — for an initial look. */
  run: () => Promise<void>
}

export function useRemoteSearch<T>(
  search: (query: string) => Promise<T>,
  options: {
    /** What `results` holds before anything is found, and after a failure. */
    empty: T
    /**
     * Whether a blank box is a question worth asking.
     *
     * The row picker says yes — a first look costs nothing on a small library
     * and saves typing to see what exists. The person picker says no: every
     * person in the library is not a useful answer to having typed nothing.
     */
    searchBlank?: boolean
    debounce?: number
  },
): RemoteSearch<T> {
  const query = ref('')
  const results = ref(options.empty) as Ref<T>
  const busy = ref(false)
  const failed = ref(false)

  /** Only the newest search may write the results, whatever order they arrive in. */
  let latest = 0

  async function run(): Promise<void> {
    const mine = (latest += 1)
    const term = query.value.trim()

    if (term.length === 0 && options.searchBlank !== true) {
      results.value = options.empty
      return
    }

    busy.value = true
    failed.value = false

    try {
      const found = await search(term)
      if (mine !== latest) return
      results.value = found
    }
    catch {
      if (mine === latest) {
        results.value = options.empty
        failed.value = true
      }
    }
    finally {
      if (mine === latest) busy.value = false
    }
  }

  useDebounced(query, () => void run(), options.debounce)

  return { query, results, busy, failed, run }
}
