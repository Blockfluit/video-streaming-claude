<script setup lang="ts">
import type { GenreFacet, LibraryCard, Page } from '@video/shared'

/**
 * Everything in the library, narrowable.
 *
 * "Everything" is two things, not one: a collection is a shelf, and a **film**
 * is a video no shelf claims. Anything on a shelf stays out — an episode, and
 * equally one of the eight films in a saga folder — because the shelf is one
 * card and the way in. Listing both would show a saga nine times over and bury
 * four films under forty instalments of one show.
 *
 * Searching is what keeps that honest: a shelf matches on the titles of the
 * videos on it, so "Prisoner of Azkaban" answers "Harry Potter" rather than
 * nothing. Without that half, hiding a shelf's videos would make them
 * unfindable — see `apps/api/src/common/films.ts`, which has the scar.
 *
 * Both used to be fetched separately and stitched together here, from two
 * requests capped at 100 each. That cannot page and cannot sort: the order was
 * only ever right inside whichever window had loaded, and a library past either
 * cap simply hid the rest. `GET /library` returns the union, so this page asks
 * one question and gets one answer.
 *
 * The URL holds every filter, because a narrowed library is something you
 * share, bookmark and come back to. `browse-filters.ts` owns both directions of
 * that mapping and is where the awkward cases are tested.
 *
 * It no longer holds *where you are* in the list. This paged fifty at a time,
 * with a control at the bottom naming the page you were on — which is a poor
 * shape for a wall of posters: the gesture at the bottom of one is to keep
 * scrolling, not to aim at a number. So the list grows as you reach the end of
 * it, and the arithmetic behind that — whether there is another request to make,
 * and how much to rebuild for someone coming back — lives in `browse-paging.ts`
 * where it can be tested without a scroll gesture.
 */

const route = useRoute()
const router = useRouter()
const { isAdmin } = useSession()

/** The filters, read from the URL — which is the only place they live. */
const filters = computed(() => parseBrowseFilters(route.query))

/**
 * Change one thing, and start the list again.
 *
 * Nothing to reset here any more — the filters are the whole of the URL now, and
 * everything loaded past the first page is discarded by the watcher below, which
 * cannot be forgotten the way an explicit reset here could be.
 */
function apply(change: Partial<BrowseFilters>): void {
  router.replace({ query: browseFiltersToQuery({ ...filters.value, ...change }) })
}

/*
 * The search box types locally and lands in the URL 250ms later.
 *
 * Debounced by hand — `refDebounced` is VueUse and not a dependency. Without
 * it every keystroke is a request and the answers can arrive out of order, so
 * the list settles on whatever the slowest one returned.
 */
const search = ref(filters.value.q)
let timer: ReturnType<typeof setTimeout> | undefined

watch(search, (value) => {
  clearTimeout(timer)
  timer = setTimeout(() => apply({ q: value }), 250)
})
onBeforeUnmount(() => clearTimeout(timer))

// The back button moves the URL without touching the box, so it is followed.
watch(
  () => filters.value.q,
  (value) => {
    if (value !== search.value) search.value = value
  },
)

const query = computed(() => browseSearchParams(filters.value))

const { data, status, error } = await useApiData<Page<LibraryCard>>(
  'browse-library',
  () => `/library?${query.value}`,
  // The URL is a function of the filters, so the fetch has to follow them.
  { watch: [query] },
)

/**
 * The genres the library actually holds.
 *
 * Fetched rather than hardcoded: `genres` is free text as far as the database
 * is concerned, and a control offering a vocabulary the library does not use is
 * a control that mostly returns nothing.
 */
const { data: genreFacets } = await useApiData<Page<GenreFacet>>(
  'browse-genres',
  '/library/genres?limit=100',
)

const genreOptions = computed(() => (genreFacets.value?.items ?? []).map((facet) => facet.genre))

/*
 * The fetcher for everything the scroll asks for.
 *
 * Resolved here, during setup, rather than inside the handler that uses it —
 * `useApi` reads the incoming request's headers, which is only legal
 * synchronously from setup, and a scroll handler runs a long way outside it.
 */
const api = useApi()

/*
 * `ANY` rather than `''` in every one of these. Reka UI reserves the empty
 * string for "cleared" and throws during render if given one as a value, which
 * takes the whole page down rather than just the control.
 */
/*
 * Each control names its own dimension in its resting state.
 *
 * A bar of bare values reads as "Any genre / Anything / Title / Any state",
 * where the middle two say nothing about what they do — "Title" in particular
 * looks like a filter for things called Title rather than the sort order. The
 * "any" option carries the noun, and the sort carries an icon, so the bar is
 * legible without labels above it eating a row of vertical space.
 */
const KIND_OPTIONS = [
  { label: 'Any type', value: ANY },
  { label: 'Films', value: 'FILM' },
  { label: 'Shows', value: 'SHOW' },
]

const SORT_OPTIONS = [
  { label: 'Title', value: 'title' },
  { label: 'Year', value: 'year' },
  { label: 'Recently added', value: 'added' },
]

const STATE_OPTIONS = [
  { label: 'Any state', value: ANY },
  ...BROWSE_STATES.map((state) => ({ label: stateLabel(state), value: state })),
]

/**
 * Everything after the first page.
 *
 * The first page stays with `useApiData` so the list still renders on the
 * server; the rest is fetched in the browser and kept here. Two sources rather
 * than one accumulator because `data` is replaced wholesale whenever the filters
 * change, and that replacement is exactly the behaviour wanted for the first
 * page and exactly wrong for the rest.
 */
const appended = ref<LibraryCard[]>([])
const loadingMore = ref(false)
const loadMoreFailed = ref(false)

const cards = computed(() => [...(data.value?.items ?? []), ...appended.value])
const total = computed(() => data.value?.total ?? 0)
const chips = computed(() => activeFilterChips(filters.value))

/** Whether there is another window to ask for — the sentinel's whole condition. */
const hasMore = computed(() => nextBrowsePage(cards.value.length, total.value) !== null)

/**
 * What the retired pager used to say: where you are in how much.
 *
 * A scrolling list has no page number, but "how far in am I" is a real question
 * and the count was already on screen — so it answers both while there is more
 * to come, and goes back to being a plain total once there is not.
 */
const countLabel = computed(() =>
  hasMore.value
    ? `${cards.value.length} of ${total.value} titles`
    : `${total.value} ${total.value === 1 ? 'title' : 'titles'}`,
)

// A different list entirely: drop everything the last one had loaded.
watch(query, () => {
  appended.value = []
  loadMoreFailed.value = false
})

/**
 * One more window, appended.
 *
 * Returns whether it actually added anything, which is what lets the fill loop
 * below terminate on any reason at all — nothing left, a request in flight, a
 * failure, or the filters having moved.
 *
 * That last one is the subtle one. The search box debounces into the URL, so a
 * request started before a keystroke can land after the list it belonged to has
 * been thrown away; appending it would staple results for "harry" onto a list
 * showing "hidden". The query string the request was built from is compared
 * against the current one rather than a flag being set, because two requests can
 * be in flight across a filter change and only the stale ones must be dropped.
 */
async function loadMore(): Promise<boolean> {
  if (loadingMore.value || loadMoreFailed.value) return false

  const next = nextBrowsePage(cards.value.length, total.value)
  if (!next) return false

  const asked = query.value
  loadingMore.value = true

  try {
    const fetched = await api<Page<LibraryCard>>(
      `/library?${browseSearchParams(filters.value, next.offset, next.limit)}`,
    )

    if (asked !== query.value) return false

    appended.value = [...appended.value, ...fetched.items]
    return fetched.items.length > 0
  }
  catch {
    // Stop, and say so. Silently giving up looks identical to the end of the
    // library, and the difference matters to whoever is looking for something.
    loadMoreFailed.value = true
    return false
  }
  finally {
    loadingMore.value = false
  }
}

/**
 * How much runway to keep below the fold, in pixels.
 *
 * Loading only once the sentinel is on screen means arriving at a spinner every
 * time; this fetches while it is still a screen away.
 */
const FILL_MARGIN = 600

const sentinel = ref<HTMLElement | null>(null)

/**
 * Whether the end of the list is within reach of the viewport.
 *
 * Measured rather than read off the observer. An `IntersectionObserver` reports
 * *changes*, delivered at the end of a frame — so after appending cards it has
 * not necessarily fired again, and a loop waiting on its flag stalls with the
 * sentinel still sitting on screen. That is not a corner case: on a wide monitor
 * one page of fifty is under three rows, so the first load never reaches the
 * fold and the observer, having already reported "visible", has nothing new to
 * say. Reading the rectangle asks the question directly and answers it now.
 */
function sentinelInView(): boolean {
  const element = sentinel.value
  if (!element) return false

  return element.getBoundingClientRect().top <= window.innerHeight + FILL_MARGIN
}

let filling = false

/** Keep loading until the end of the list is off screen, or there is no more of it. */
async function fill(): Promise<void> {
  if (filling) return
  filling = true

  try {
    while (sentinelInView() && await loadMore()) {
      // Let the cards render, or the next measurement is of the old page.
      await nextTick()
    }
  }
  finally {
    filling = false
  }
}

/** The button under the grid, which also clears a failure so it can be retried. */
function loadMoreNow(): void {
  loadMoreFailed.value = false
  void fill()
}

/*
 * Coming back to where you were.
 *
 * This used to be free: the page number was in the URL, so the back button
 * restored it along with everything else. A scroll position is not something to
 * put in a URL — it would open a shared link a thousand cards down — so it is
 * remembered per browser session instead, under a key naming the list it belongs
 * to, and the list is rebuilt to the depth it had before the position is used.
 */
const placeKey = computed(() => browsePlaceKey(query.value))

function rememberPlace(): void {
  sessionStorage.setItem(
    placeKey.value,
    JSON.stringify({ count: cards.value.length, scrollY: window.scrollY }),
  )
}

let placeTimer: ReturnType<typeof setTimeout> | undefined

function onScroll(): void {
  clearTimeout(placeTimer)
  placeTimer = setTimeout(rememberPlace, 200)
}

async function restorePlace(): Promise<void> {
  const place = parseBrowsePlace(sessionStorage.getItem(placeKey.value))
  const target = restoreTarget(place, total.value)
  if (!place || target <= cards.value.length) return

  while (cards.value.length < target && await loadMore()) {
    await nextTick()
  }

  /*
   * After the cards, not before. Nuxt restores the scroll offset itself on a
   * back navigation, against a page holding only the first fifty — so it lands
   * clamped at the bottom of a short page, and this is the correction.
   */
  await nextTick()
  window.scrollTo(0, place.scrollY)
}

let observer: IntersectionObserver | undefined

onMounted(async () => {
  window.addEventListener('scroll', onScroll, { passive: true })

  // Before the observer exists, so a restore and a fill cannot both be walking
  // the list at once and cutting each other short on the in-flight guard.
  await restorePlace()

  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some(entry => entry.isIntersecting)) void fill()
    },
    { rootMargin: `${FILL_MARGIN}px 0px` },
  )
  if (sentinel.value) observer.observe(sentinel.value)
})

// The sentinel comes and goes with `hasMore`, so the observer follows it.
watch(sentinel, (element) => {
  if (!observer) return

  observer.disconnect()
  if (element) observer.observe(element)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  window.removeEventListener('scroll', onScroll)
  clearTimeout(placeTimer)
  // The last scroll may not have settled into a save yet, and leaving is
  // precisely when the position is worth having.
  rememberPlace()
})

useHead({ title: 'Browse' })
</script>

<template>
  <!--
    The wide shell, because this page is a wall of artwork rather than something
    to read. `.page-shell` alone caps at 110rem, which is exactly the width a
    1920 screen already gives it — so above that the grid stopped growing and a
    4K monitor showed the same nine columns in the middle of a lot of nothing.
  -->
  <div class="page-shell page-shell-wide space-y-6 pt-24 pb-16">
    <div class="flex items-center gap-4 flex-wrap">
      <h1 class="text-2xl font-semibold grow">Browse</h1>
      <UInput
        v-model="search"
        icon="i-lucide-search"
        placeholder="Search titles, genres and cast"
        class="w-72"
      />
    </div>

    <!--
      Every control names its own job in an aria-label. @nuxt/ui's triggers ship
      one of their own — USelectMenu's is "Show popup" — which shadows the
      visible text, so the accessible name of the control that picks a genre
      would otherwise say nothing about genres.
    -->
    <div class="flex flex-wrap items-center gap-3">
      <USelectMenu
        :model-value="filters.genres"
        :items="genreOptions"
        multiple
        placeholder="Any genre"
        aria-label="Filter by genre"
        class="w-52"
        @update:model-value="(genres: string[]) => apply({ genres })"
      />
      <USelect
        :model-value="filters.kind"
        :items="KIND_OPTIONS"
        aria-label="Filter by films or shows"
        class="w-36"
        @update:model-value="(value: string) => apply({ kind: asKind(value) })"
      />
      <USelect
        :model-value="filters.sort"
        :items="SORT_OPTIONS"
        icon="i-lucide-arrow-up-down"
        aria-label="Sort the library"
        class="w-44"
        @update:model-value="(value: string) => apply({ sort: asSort(value) })"
      />
      <!--
        Rendering only. `useSession` is a convenience, never an authority: the
        API narrows a state filter to what the caller's role may see, so a USER
        who writes `?state=DRAFT` by hand gets an empty page rather than drafts.
      -->
      <USelect
        v-if="isAdmin"
        :model-value="filters.state"
        :items="STATE_OPTIONS"
        aria-label="Filter by lifecycle state"
        class="w-40"
        @update:model-value="(value: string) => apply({ state: asState(value) })"
      />

      <span class="ml-auto text-sm text-(--ui-text-muted)">{{ countLabel }}</span>
    </div>

    <div v-if="chips.length" class="flex flex-wrap items-center gap-2">
      <UButton
        v-for="chip in chips"
        :key="chip.label"
        size="xs"
        color="neutral"
        variant="subtle"
        trailing-icon="i-lucide-x"
        :aria-label="`Remove the ${chip.label} filter`"
        @click="apply(chip.clear)"
      >
        {{ chip.label }}
      </UButton>
      <ULink class="text-sm" @click="router.replace({ query: {} })">Clear all</ULink>
    </div>

    <!--
      An outage and an empty library must not look alike. `useApiData` returns
      null for a failed request and for no results, so a page that reads only
      `data` reports a dead API as "The library is empty" and sends whoever
      reads it looking in entirely the wrong place.
    -->
    <p v-if="error" class="py-20 text-center text-(--ui-text-muted)">
      The library could not be loaded. Try again in a moment.
    </p>

    <div v-else-if="cards.length" class="poster-grid">
      <MediaCard
        v-for="card in cards"
        :key="`${card.kind}:${card.id}`"
        class="w-full"
        :to="card.kind === 'collection' ? collectionPath(card) : videoPath(card)"
        :title="card.title"
        :subtitle="
          card.kind === 'collection'
            ? card.year ? String(card.year) : null
            : runtime(card.durationSec)
        "
        :image-url="card.kind === 'collection' ? collectionPoster(card) : videoPoster(card)"
        :badge="card.state === 'PUBLISHED' ? null : card.state"
        :kind="card.kind === 'collection' ? collectionChip(card) : null"
      />
    </div>

    <p v-else-if="status !== 'pending'" class="py-20 text-center text-(--ui-text-muted)">
      {{
        hasActiveFilters(filters)
          ? 'Nothing matches those filters.'
          : 'The library is empty.'
      }}
    </p>

    <!--
      The end of the list, and what watches for it.

      The observer normally reaches this before a person does, so the button is
      usually a spinner by the time it is on screen. It is here anyway: infinite
      scroll with nothing to press is unreachable from a keyboard and invisible
      to a screen reader, and it is the one control that can retry after a failed
      load. A real button rather than something hidden — `visible.spec.ts` fails
      a control that is invisible and still focusable, and rightly.
    -->
    <div
      v-if="cards.length && hasMore"
      ref="sentinel"
      class="flex flex-col items-center gap-3 pt-2"
    >
      <p v-if="loadMoreFailed" class="text-sm text-(--ui-text-muted)">
        More of the library could not be loaded.
      </p>
      <UButton
        color="neutral"
        variant="subtle"
        :loading="loadingMore"
        @click="loadMoreNow"
      >
        {{ loadMoreFailed ? 'Try again' : 'Load more' }}
      </UButton>
    </div>

    <!--
      Browsing stops before the library does at `MAX_LIBRARY_OFFSET`, which is
      the endpoint refusing to read a hundred thousand rows to answer one page.
      Saying so beats a list that simply stops with a quarter of the count shown.
    -->
    <p
      v-else-if="cards.length && cards.length < total"
      class="pt-2 text-center text-sm text-(--ui-text-muted)"
    >
      That is as far as browsing goes — narrow the filters to reach the rest.
    </p>
  </div>
</template>
