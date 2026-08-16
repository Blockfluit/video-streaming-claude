import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { Page } from '@video/shared'

/**
 * "Load 40 more (of 312)", and the window it appends.
 *
 * The admin library generalised this within its own file first — one
 * `loadWindow` for both halves of the page, "so the two halves cannot drift
 * apart on when they reset, what they ask for, or what they do with an answer
 * that arrived late". The person directory then wrote the same function again,
 * comments and all. The reasoning that justified writing it once for two lists
 * justifies writing it once for two pages.
 *
 * Four things have to happen in the right order, and each was a bug once:
 *
 * - **The offset comes from what is on screen**, not from a page counter, so a
 *   record added or removed between presses shifts the next window by exactly
 *   what it shifted the list by.
 * - **A late answer to an old question is dropped.** The filter can move while a
 *   request is in flight, and appending its result mixes two searches.
 * - **The label counts against `total`, not `hasMore`.** `hasMore` answers "is
 *   there more after the *first* window", which stops being the question the
 *   moment a second one is appended.
 * - **`reset()` on every mutation**, never a bare `refresh()`. Refetching the
 *   first window alone leaves appended windows in place across a delete that
 *   shifted every row after it up by one — the list then shows a row that has
 *   moved and skips the row that took its place, with nothing looking wrong.
 *
 * `loadMoreLabel` and `appendWindow` stay in `utils/paging.ts`: they are pure,
 * specced, and this is only the state around them.
 */

export interface LoadMore<T> {
  /** The first window plus everything appended, which is what the page renders. */
  items: ComputedRef<T[]>
  /** The button's text, or null when there is nothing left to offer. */
  label: ComputedRef<string | null>
  loading: Ref<boolean>
  loadMore: () => Promise<void>
  /** Back to one window. Call this after anything that changes the list. */
  reset: () => void
}

export function useLoadMore<T extends { id: string }>(options: {
  /** The first window, owned by `useApiData` and replaced wholesale on refetch. */
  first: () => T[]
  /** How many rows match the current question, for the label. */
  total: () => number
  pageSize: number
  /**
   * Identifies the question being asked. Compared by identity before an answer
   * is appended, so it can be a search string or a whole filter object.
   */
  question: () => unknown
  /** The URL for one window at `offset`. */
  query: (offset: number) => string
  /** What to say if the request fails. */
  failure: string
}): LoadMore<T> {
  const api = useApi()
  const toast = useToast()

  /**
   * The windows after the first.
   *
   * Separate from the first because `useApiData` is `useAsyncData`: one key, one
   * slot, and a refetch replaces its `data` wholesale. Keeping only the appended
   * rows here means nothing has to seed this, and the markup matches on both
   * sides of hydration — empty on the server, empty on the client's first render.
   */
  const more = ref<T[]>([]) as Ref<T[]>
  const loading = ref(false)

  const items = computed(() => [...options.first(), ...more.value])
  const label = computed(() =>
    loadMoreLabel(items.value.length, options.total(), options.pageSize),
  )

  async function loadMore(): Promise<void> {
    if (loading.value || label.value === null) return
    loading.value = true

    const asked = options.question()
    const offset = items.value.length

    try {
      const page = await api<Page<T>>(options.query(offset))
      // The answer to a question nobody is asking any more is dropped rather
      // than appended.
      if (asked !== options.question()) return
      more.value = appendWindow(more.value, page.items, items.value)
    }
    catch (failure) {
      toast.add({ title: apiMessage(failure, options.failure), color: 'error' })
    }
    finally {
      loading.value = false
    }
  }

  function reset(): void {
    more.value = []
  }

  return { items, label, loading, loadMore, reset }
}
