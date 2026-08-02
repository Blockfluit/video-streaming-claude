<script setup lang="ts">
import type { Page } from '@video/shared'

/**
 * Everything in the library, searchable.
 *
 * "Everything" is two things, not one. A collection is a shelf; a **standalone
 * video** — a film in a folder of its own — belongs to no shelf, so a page that
 * listed only collections could never show it however often it was published.
 * That is the bug this page had: the whole point of the model is that a video
 * stands on its own, and the one screen for finding things did not agree.
 *
 * Episodes deliberately stay out. They are reachable through their collection,
 * and listing them here would bury four films under forty episodes of one show.
 *
 * The API pages and filters by role, so a viewer simply never sees a draft —
 * there is nothing to hide here.
 */
interface CollectionCard {
  id: string
  slug: string
  title: string
  year: number | null
  tags: string[]
  state: string
}

interface VideoCard {
  id: string
  slug: string
  title: string
  durationSec: number | null
  tags: string[]
  state: string
}

/** One grid, so the two kinds sort together rather than in separate blocks. */
interface Card {
  key: string
  to: string
  title: string
  subtitle: string | null
  imageUrl: string
  badge: string | null
}

const route = useRoute()
const router = useRouter()

const q = ref(String(route.query.q ?? ''))
const tag = computed(() => (route.query.tag ? String(route.query.tag) : null))

/** `q` and `tag` mean the same thing to both endpoints, so they are built once. */
function search(): URLSearchParams {
  const params = new URLSearchParams({ limit: '100' })
  if (q.value) params.set('q', q.value)
  if (tag.value) params.set('tag', tag.value)
  return params
}

const { data, status } = await useApiData<Page<CollectionCard>>(
  'browse-collections',
  () => `/collections?${search().toString()}`,
  // The URL is a function of these, so the fetch has to follow them.
  { watch: [q, tag] },
)

const { data: loose, status: looseStatus } = await useApiData<Page<VideoCard>>(
  'browse-standalone',
  () => {
    const params = search()
    // The videos in no collection at all. Without this they are unreachable
    // from here, since they are not on any shelf to be listed under.
    params.set('standalone', 'true')
    return `/videos?${params.toString()}`
  },
  { watch: [q, tag] },
)

// Debounced into the URL, so a search is shareable and the back button works.
let timer: ReturnType<typeof setTimeout> | undefined
watch(q, (value) => {
  clearTimeout(timer)
  timer = setTimeout(() => {
    router.replace({ query: { ...route.query, q: value || undefined } })
  }, 250)
})

/**
 * Both windows merged and sorted by title.
 *
 * Two capped lists stitched together locally is not real paging, and it is the
 * same cap this page always had — worth knowing before the library outgrows it.
 */
const cards = computed<Card[]>(() => {
  const collections: Card[] = (data.value?.items ?? []).map(collection => ({
    key: `c:${collection.id}`,
    to: collectionPath(collection),
    title: collection.title,
    subtitle: collection.year ? String(collection.year) : null,
    imageUrl: `/api/collections/${collection.id}/poster`,
    badge: collection.state === 'PUBLISHED' ? null : collection.state,
  }))

  const videos: Card[] = (loose.value?.items ?? []).map(video => ({
    key: `v:${video.id}`,
    to: watchPath(video),
    title: video.title,
    subtitle: runtime(video.durationSec),
    imageUrl: `/api/videos/${video.id}/thumbnail`,
    badge: video.state === 'PUBLISHED' ? null : video.state,
  }))

  return [...collections, ...videos].sort((a, b) => a.title.localeCompare(b.title))
})

const pending = computed(() => status.value === 'pending' || looseStatus.value === 'pending')

useHead({ title: 'Browse' })
</script>

<template>
  <div class="page-shell space-y-6 pt-24 pb-16">
    <div class="flex items-center gap-4 flex-wrap">
      <h1 class="text-2xl font-semibold grow">Browse</h1>
      <UInput
        v-model="q"
        icon="i-lucide-search"
        placeholder="Search the library"
        class="w-64"
      />
    </div>

    <div v-if="tag" class="flex items-center gap-2">
      <span class="text-sm text-(--ui-text-muted)">Tagged</span>
      <UBadge color="primary" variant="subtle">{{ tag }}</UBadge>
      <ULink :to="{ query: { ...route.query, tag: undefined } }" class="text-sm">Clear</ULink>
    </div>

    <div v-if="cards.length" class="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-4">
      <MediaCard
        v-for="card in cards"
        :key="card.key"
        class="w-full"
        :to="card.to"
        :title="card.title"
        :subtitle="card.subtitle"
        :image-url="card.imageUrl"
        :badge="card.badge"
      />
    </div>

    <p v-else-if="!pending" class="py-20 text-center text-(--ui-text-muted)">
      {{ q ? `Nothing matches “${q}”.` : 'The library is empty.' }}
    </p>
  </div>
</template>
