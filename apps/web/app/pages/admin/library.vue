<script setup lang="ts">
import { MAX_PAGE_LIMIT, type Page } from '@video/shared'
import type { ComputedRef, Ref } from 'vue'

import type { LibraryResource } from '~/utils/admin-library'

/**
 * Everything in the library, filterable by state — the way into any individual
 * record. Collections and videos side by side, since an admin looking for
 * "that thing" does not know or care which it is.
 *
 * It used to ask each endpoint for one window of a hundred — `MAX_PAGE_LIMIT`,
 * the most either will serve — and stop. `total` arrived in both responses and
 * was printed straight into the section headings, while `hasMore` was never
 * read at all: "Videos (1284)" over a hundred rows, with no way to reach row
 * 101. On the one screen whose job is to find a record, the only records you
 * could open were the ones you already knew the title of.
 */
definePageMeta({ layout: 'admin', middleware: 'admin' })

interface VideoRow {
  id: string
  title: string
  state: string
  durationSec: number | null
  width: number | null
  height: number | null
  needsConversion: boolean
  missingFields?: string[]
}

interface CollectionRow {
  id: string
  slug: string
  title: string
  state: string
  year: number | null
  missingFields?: string[]
}

/** A hundred at a time — the most either endpoint will serve in one request. */
const PAGE_SIZE = MAX_PAGE_LIMIT

/**
 * `ANY` is the shared "no filter" sentinel rather than an empty string: Reka UI
 * reserves `''` to mean "cleared", and an option carrying it throws during
 * render — which takes the whole page down, not just the select. `BROWSE_STATES`
 * and `stateLabel` come from the same place, so this control and the one on
 * `/browse` cannot end up offering different vocabularies.
 */
const STATES = [
  { label: 'Any state', value: ANY },
  ...BROWSE_STATES.map(value => ({ label: stateLabel(value), value })),
]

const route = useRoute()
const router = useRouter()
const api = useApi()
const toast = useToast()

/** What the controls hold. The search box types locally; the select does not. */
const q = ref(String(route.query.q ?? ''))
const state = ref(String(route.query.state ?? ANY))

/**
 * What has actually been asked for, as one value.
 *
 * Replaced wholesale rather than mutated, so its identity doubles as "which
 * question is this" — which is what an in-flight window is checked against
 * before it is appended.
 */
const asked = ref({ q: q.value.trim(), state: state.value })

/**
 * The windows after the first, per list.
 *
 * `useApiData` is `useAsyncData`: one key, one slot, and a refetch replaces its
 * `data` wholesale — so the first window stays where it is, server-rendered and
 * transferred in the payload, and only what has been *added* to it lives here.
 * Nothing seeds these from `data`, so the markup matches on both sides of
 * hydration because they are empty on the server and empty on the client's
 * first render.
 */
const moreCollections = ref<CollectionRow[]>([])
const moreVideos = ref<VideoRow[]>([])

/**
 * Asks a different question, dropping the answers to the old one.
 *
 * The single place `asked` changes, which is what makes the reset impossible to
 * forget: windows fetched at an offset mean nothing once the filter moves, and
 * leaving them behind would show page seven of the old question underneath page
 * one of the new one.
 */
function ask(nextQ: string, nextState: string): void {
  if (nextQ === asked.value.q && nextState === asked.value.state) return

  moreCollections.value = []
  moreVideos.value = []
  asked.value = { q: nextQ, state: nextState }
}

/*
 * The search box types locally and asks the API 250ms later.
 *
 * Debounced by hand — `refDebounced` is VueUse and not a dependency — the way
 * `browse.vue` does it. This page watched the input directly, so every keystroke
 * was two requests and the answers could land out of order, leaving both lists
 * on whatever the slowest one returned. That was survivable while there was one
 * window each; with pages appended behind them, a mid-word refetch replaces
 * window one while the appended windows were fetched for a different question.
 * The debounce is part of this fix rather than tidying up beside it.
 */
let timer: ReturnType<typeof setTimeout> | undefined
watch(q, (value) => {
  clearTimeout(timer)
  timer = setTimeout(() => ask(value.trim(), state.value), 250)
})
onBeforeUnmount(() => clearTimeout(timer))

// The select is a single deliberate choice rather than a stream of keystrokes,
// so it asks at once.
watch(state, (value) => ask(asked.value.q, value))

const { data: collections, status: collectionsStatus } = await useApiData<Page<CollectionRow>>(
  'adm-lib-collections',
  () => libraryQuery('collections', asked.value.q, asked.value.state, 0, PAGE_SIZE),
  { watch: [asked] },
)
const { data: videos, status: videosStatus } = await useApiData<Page<VideoRow>>(
  'adm-lib-videos',
  () => libraryQuery('videos', asked.value.q, asked.value.state, 0, PAGE_SIZE),
  { watch: [asked] },
)

const collectionRows = computed(() => [...(collections.value?.items ?? []), ...moreCollections.value])
const videoRows = computed(() => [...(videos.value?.items ?? []), ...moreVideos.value])

/**
 * What each button offers, counted against `total` rather than `hasMore`.
 *
 * `hasMore` answers "is there more after the **first** window", which stopped
 * being the question the moment a second one was appended.
 */
const collectionsLabel = computed(
  () => loadMoreLabel(collectionRows.value.length, collections.value?.total ?? 0, PAGE_SIZE),
)
const videosLabel = computed(
  () => loadMoreLabel(videoRows.value.length, videos.value?.total ?? 0, PAGE_SIZE),
)

const loadingCollections = ref(false)
const loadingVideos = ref(false)

/**
 * One more window of one list, appended.
 *
 * Written once and used for both, so the two halves of the page cannot drift
 * apart on when they reset, what they ask for, or what they do with an answer
 * that arrived late.
 */
async function loadWindow<T extends { id: string }>(
  resource: LibraryResource,
  more: Ref<T[]>,
  onScreen: ComputedRef<T[]>,
  label: ComputedRef<string | null>,
  loading: Ref<boolean>,
): Promise<void> {
  if (loading.value || label.value === null) return
  loading.value = true

  // Asked for by what is on screen, so a record added or removed between
  // presses shifts the next window by exactly what it shifted the list by.
  const question = asked.value
  const offset = onScreen.value.length

  try {
    const page = await api<Page<T>>(
      libraryQuery(resource, question.q, question.state, offset, PAGE_SIZE),
    )
    // The answer to a question nobody is asking any more is dropped rather than
    // appended: the filter can move while this is in flight.
    if (question !== asked.value) return
    more.value = appendWindow(more.value, page.items, onScreen.value)
  }
  catch (failure) {
    toast.add({ title: apiMessage(failure, `Could not load more ${resource}`), color: 'error' })
  }
  finally {
    loading.value = false
  }
}

const loadMoreCollections = () =>
  loadWindow('collections', moreCollections, collectionRows, collectionsLabel, loadingCollections)
const loadMoreVideos = () =>
  loadWindow('videos', moreVideos, videoRows, videosLabel, loadingVideos)

/**
 * Nothing at all, rather than one message per empty list.
 *
 * Kept to a single element on purpose: a search matching only collections used
 * to print "Nothing matches." underneath the collections it had just matched,
 * and a second copy of the string is also a Playwright strict-mode violation.
 *
 * Held back while either request is in flight. `useAsyncData` starts a
 * client-side navigation with `data` still null, so an empty page and a page
 * that has not answered yet look identical — and announcing "Nothing matches."
 * for the moment before the library arrives is the page contradicting itself.
 */
const nothingMatches = computed(() =>
  collectionRows.value.length === 0
  && videoRows.value.length === 0
  && collectionsStatus.value !== 'pending'
  && videosStatus.value !== 'pending')

// Driven by what was asked rather than by the controls, so the shareable URL is
// the question the lists are answering — and the search lands in it debounced,
// rather than a `router.replace` per keystroke.
watch(asked, (question) => {
  router.replace({
    query: {
      q: question.q || undefined,
      state: question.state !== ANY ? question.state : undefined,
    },
  })
})

useHead({ title: 'All titles' })
</script>

<template>
  <div class="space-y-6">
    <h1 class="text-2xl font-bold tracking-tight">Library</h1>

    <div class="flex flex-wrap gap-3">
      <UInput v-model="q" icon="i-lucide-search" placeholder="Search titles" class="w-full sm:w-64" />
      <USelect v-model="state" :items="STATES" aria-label="Filter by state" class="w-full sm:w-40" />
    </div>

    <section v-if="collectionRows.length" class="space-y-2">
      <h2 class="text-sm font-semibold tracking-wide text-(--ui-text-muted) uppercase">
        Collections ({{ collections?.total ?? 0 }})
      </h2>
      <div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        <NuxtLink
          v-for="collection in collectionRows"
          :key="collection.id"
          :to="`/admin/collections/${collection.slug}`"
          class="flex items-center gap-3 rounded-lg border border-(--ui-border-accented) bg-(--ui-bg-elevated) p-3 transition-colors hover:border-(--ui-text-dimmed) hover:bg-(--ui-bg-accented)"
        >
          <img
            :src="`/api/collections/${collection.id}/poster`"
            alt=""
            loading="lazy"
            class="aspect-2/3 w-10 shrink-0 rounded bg-(--ui-bg-accented) object-cover"
          >
          <div class="min-w-0">
            <p class="truncate text-sm font-medium">{{ collection.title }}</p>
            <p class="text-xs text-(--ui-text-muted)">{{ collection.state }}</p>
          </div>
        </NuxtLink>
      </div>

      <!--
        The offer names what is left, because the number is the point: it says
        whether to keep pressing or to search instead. `color="neutral"` with
        `variant="subtle"` — accent colour marks things here, it does not set
        type on a control.
      -->
      <div v-if="collectionsLabel" class="flex justify-center pt-2">
        <UButton
          color="neutral"
          variant="subtle"
          :loading="loadingCollections"
          @click="loadMoreCollections"
        >
          {{ collectionsLabel }}
        </UButton>
      </div>
    </section>

    <section v-if="videoRows.length" class="space-y-2">
      <h2 class="text-sm font-semibold tracking-wide text-(--ui-text-muted) uppercase">
        Videos ({{ videos?.total ?? 0 }})
      </h2>
      <div class="table-scroll rounded-lg border border-(--ui-border)">
        <table class="w-full min-w-max text-sm">
          <tbody class="divide-y divide-(--ui-border)">
            <tr v-for="video in videoRows" :key="video.id" class="hover:bg-white/[0.03]">
              <td class="p-3">
                <div class="flex items-center gap-3">
                  <img
                    :src="`/api/videos/${video.id}/banner`"
                    alt=""
                    loading="lazy"
                    class="aspect-video w-16 shrink-0 rounded bg-(--ui-bg-accented) object-cover"
                  >
                  <span class="truncate font-medium">{{ video.title }}</span>
                </div>
              </td>
              <td class="p-3">
                <UBadge
                  :color="video.state === 'PUBLISHED' ? 'success' : video.state === 'MISSING' ? 'error' : 'neutral'"
                  variant="subtle"
                >
                  {{ video.state }}
                </UBadge>
              </td>
              <td class="p-3 text-(--ui-text-muted)">{{ runtime(video.durationSec) ?? '—' }}</td>
              <td class="p-3"><QualityBadge :width="video.width" :height="video.height" /></td>
              <td class="p-3 text-right">
                <UButton :to="`/admin/videos/${video.id}`" size="xs" color="neutral" variant="subtle">Edit</UButton>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="videosLabel" class="flex justify-center pt-2">
        <UButton
          color="neutral"
          variant="subtle"
          :loading="loadingVideos"
          @click="loadMoreVideos"
        >
          {{ videosLabel }}
        </UButton>
      </div>
    </section>

    <p v-if="nothingMatches" class="py-12 text-center text-(--ui-text-muted)">Nothing matches.</p>
  </div>
</template>
