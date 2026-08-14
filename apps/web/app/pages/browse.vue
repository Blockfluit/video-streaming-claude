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
 */

const route = useRoute()
const router = useRouter()
const { isAdmin } = useSession()

/** The filters, read from the URL — which is the only place they live. */
const filters = computed(() => parseBrowseFilters(route.query))

/**
 * Change one thing and go back to the first page.
 *
 * Anything but paging resets the offset: a search narrowed to three results
 * while you were on page seven otherwise lands on an empty page that looks
 * exactly like an empty library.
 */
function apply(change: Partial<BrowseFilters>): void {
  const next = { ...filters.value, ...change }
  if (!('offset' in change)) next.offset = 0

  router.replace({ query: browseFiltersToQuery(next) })
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

const cards = computed(() => data.value?.items ?? [])
const total = computed(() => data.value?.total ?? 0)
const chips = computed(() => activeFilterChips(filters.value))

const page = computed(() => Math.floor(filters.value.offset / BROWSE_PAGE_SIZE) + 1)

function goToPage(next: number): void {
  apply({ offset: (next - 1) * BROWSE_PAGE_SIZE })
}

useHead({ title: 'Browse' })
</script>

<template>
  <div class="page-shell space-y-6 pt-24 pb-16">
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

      <span class="ml-auto text-sm text-(--ui-text-muted)">
        {{ total }} {{ total === 1 ? 'title' : 'titles' }}
      </span>
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

    <div
      v-else-if="cards.length"
      class="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-4"
    >
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

    <div v-if="total > BROWSE_PAGE_SIZE" class="flex justify-center pt-2">
      <UPagination
        :page="page"
        :total="total"
        :items-per-page="BROWSE_PAGE_SIZE"
        @update:page="goToPage"
      />
    </div>
  </div>
</template>
