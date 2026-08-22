<script setup lang="ts">
import { MAX_PAGE_LIMIT, type Page } from '@video/shared'

/**
 * The person directory.
 *
 * Search before you add: the API refuses a duplicate name case-insensitively,
 * but the point of the search box is that nobody tries in the first place —
 * a directory full of near-duplicates is what kills a credits system.
 *
 * It used to ask for one window of a hundred — `MAX_PAGE_LIMIT`, the most the
 * endpoint will serve — and stop. `total` and `hasMore` both arrived in that
 * response and neither was ever read, so a library past a hundred people simply
 * hid the rest and the only way to reach person 101 was to already know their
 * name. Which is the wrong way round for the one screen whose job is to stop
 * you adding somebody who is already there.
 */
definePageMeta({ layout: 'admin', middleware: 'admin' })

interface Person {
  id: string
  slug: string
  name: string
  bio: string | null
  imdbId: string | null
  knownFor: string | null
  _count?: { credits: number }
}

const api = useApi()
const toast = useToast()

/** A hundred at a time — the most the endpoint will serve in one request. */
const PAGE_SIZE = MAX_PAGE_LIMIT

/*
 * The search box types locally and asks the API 250ms later.
 *
 * Debounced by hand — `refDebounced` is VueUse and not a dependency — the way
 * `browse.vue` does it. This page watched the input directly, so every keystroke
 * was a request and the answers could land out of order, leaving the list on
 * whatever the slowest one returned. That was survivable while there was one
 * window; with pages appended behind it, a mid-word refetch replaces page one
 * while the appended pages were fetched for a different question. The debounce
 * is part of this fix rather than tidying up beside it.
 */
const search = ref('')
/** What has actually been asked for. */
const q = ref('')

/**
 * Asks a different question, dropping the answers to the old one.
 *
 * The single place `q` changes, which is what makes the reset impossible to
 * forget: windows fetched at an offset mean nothing once the filter moves.
 */
function ask(term: string): void {
  if (term === q.value) return
  reset()
  q.value = term
}

useDebounced(search, (value) => ask(value.trim()))

const { data, refresh, error } = await useApiData<Page<Person>>(
  'admin-people',
  () => peopleQuery(q.value, 0, PAGE_SIZE),
  { watch: [q] },
)

/** The count is what says whether searching is worth it. Rendered in the header. */
const total = computed(() => data.value?.total ?? 0)

const {
  items: people,
  label: moreLabel,
  loading: loadingMore,
  loadMore,
  reset,
} = useLoadMore<Person>({
  first: () => data.value?.items ?? [],
  total: () => data.value?.total ?? 0,
  pageSize: PAGE_SIZE,
  question: () => q.value,
  query: offset => peopleQuery(q.value, offset, PAGE_SIZE),
  failure: 'Could not load more people',
})

/**
 * Back to one window, and re-ask.
 *
 * `refresh()` refetches the first window only, so an appended one would survive
 * a delete that shifted every row after it up by one — the list would then show
 * a row that has moved and skip the row that took its place, with nothing about
 * it looking wrong. Every mutation goes through here rather than `refresh`.
 */
async function reload(): Promise<void> {
  reset()
  await refresh()
}

const newName = ref('')
const resolving = ref(false)

/**
 * Fills in the IMDb ids an import could not.
 *
 * TMDB does not return a person's IMDb id alongside a title's credits, so they
 * are normally resolved lazily behind whoever gets looked at. That is fine for a
 * library being browsed and slow for one that has just had a hundred films
 * imported, which is what this is for.
 */
async function resolveLinks() {
  resolving.value = true
  try {
    const result = await api<{ resolved: number, checked: number }>(
      '/admin/metadata/people/resolve-links',
      { method: 'POST' },
    )
    await reload()
    toast.add({
      title: result.checked === 0
        ? 'Everybody who can be linked already is'
        : `Linked ${result.resolved} of ${result.checked}`,
      color: 'success',
    })
  }
  // Not `error`: that is the fetch's own ref, which the template reads to tell
  // an outage apart from an empty directory.
  catch (failure) {
    toast.add({ title: apiMessage(failure, 'Could not resolve links'), color: 'error' })
  }
  finally {
    resolving.value = false
  }
}

async function create() {
  const name = newName.value.trim()
  if (!name) return
  try {
    await api('/people', { method: 'POST', body: { name } })
    newName.value = ''
    /*
     * Show them.
     *
     * The directory is alphabetical and a window at a time, so on a library of
     * four hundred a new person lands on a page nobody is looking at — which is
     * indistinguishable from the add having done nothing. Searching for them is
     * also the loop this screen exists for: search before you add.
     */
    search.value = name
    // The debounce will ask for it, unless that is already the question — in
    // which case nothing would refetch at all.
    if (q.value === name) await reload()
  } catch (failure) {
    // Through `apiMessage`, like everything else on this screen: a zod refusal
    // arrives as `errors[]`, which reading `data.message` by hand misses — so a
    // named field and its reason became "Could not add that person."
    toast.add({ title: apiMessage(failure, 'Could not add that person.'), color: 'error' })
  }
}

async function remove(person: Person) {
  // The cascade takes their credits with them; a credit with no person is not
  // a fact about anything.
  await api(`/people/${person.id}`, { method: 'DELETE' })
  await reload()
}

useHead({ title: 'People' })
</script>

<template>
  <div class="space-y-6">
    <div>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h1 class="text-2xl font-bold tracking-tight">People</h1>
        <UButton
          color="neutral"
          variant="subtle"
          icon="i-lucide-link"
          :loading="resolving"
          @click="resolveLinks"
        >
          Resolve IMDb links
        </UButton>
      </div>
      <p class="text-sm text-(--ui-text-muted)">
        Cast and crew, shared across the library.
        <!--
          The count is what says whether searching is worth it — and it is the
          figure that made the missing pages obvious once it was on screen.
        -->
        <span v-if="total">· {{ total }} {{ total === 1 ? 'person' : 'people' }}</span>
      </p>
    </div>

    <div class="flex flex-wrap gap-2">
      <UInput v-model="search" icon="i-lucide-search" placeholder="Search" class="w-full sm:w-64" />
      <div class="ml-auto flex gap-2">
        <UInput v-model="newName" placeholder="New person" class="w-full sm:w-56" @keyup.enter="create" />
        <UButton icon="i-lucide-plus" @click="create">Add</UButton>
      </div>
    </div>

    <!--
      An outage and an empty directory must not look alike. `useApiData` returns
      null for a failed request and for no results alike, so a dead API read as
      "No people yet" and sent whoever saw it looking in the wrong place.
    -->
    <p v-if="error" class="py-20 text-center text-(--ui-text-muted)">
      The directory could not be loaded. Try again in a moment.
    </p>

    <div v-else-if="people.length" class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      <div
        v-for="person in people"
        :key="person.id"
        class="flex items-center gap-3 rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-3"
      >
        <div class="grid size-10 shrink-0 place-items-center rounded-full bg-(--ui-bg-elevated) text-xs font-semibold">
          {{ person.name.slice(0, 2).toUpperCase() }}
        </div>
        <div class="min-w-0 grow">
          <NuxtLink :to="personPath(person)" class="truncate text-sm font-medium hover:underline">
            {{ person.name }}
          </NuxtLink>
          <p class="text-xs text-(--ui-text-muted)">
            {{ person._count?.credits ?? 0 }} credits
            <!-- What they do, which is what a people search wants to show. -->
            <span v-if="person.knownFor"> · {{ person.knownFor }}</span>
          </p>
        </div>
        <ImdbLink :imdb-id="person.imdbId" kind="person" :label="person.name" />
        <UButton
          size="xs"
          variant="ghost"
          color="error"
          icon="i-lucide-trash-2"
          :aria-label="`Remove ${person.name}`"
          @click="remove(person)"
        />
      </div>
    </div>

    <p v-else class="py-20 text-center text-(--ui-text-muted)">
      {{ q ? 'Nobody matches.' : 'No people yet.' }}
    </p>

    <!--
      The offer names what is left, because the number is the point: it says
      whether to keep pressing or to search instead. `variant="subtle"` with
      `color="neutral"` — Add is the one call to action on this screen, and
      accent colour does not set type here.
    -->
    <div v-if="moreLabel" class="flex justify-center pt-2">
      <UButton color="neutral" variant="subtle" :loading="loadingMore" @click="loadMore">
        {{ moreLabel }}
      </UButton>
    </div>
  </div>
</template>
