<script setup lang="ts">
import type { Page } from '@video/shared'

/**
 * Every collection, searchable. The API pages and filters by role, so a viewer
 * simply never sees a draft — there is nothing to hide here.
 */
interface CollectionCard {
  id: string
  slug: string
  title: string
  year: number | null
  tags: string[]
  state: string
  /** Null means there is none, so the card does not ask for it. */
  posterKey: string | null
}

const route = useRoute()
const router = useRouter()

const q = ref(String(route.query.q ?? ''))
const tag = computed(() => (route.query.tag ? String(route.query.tag) : null))

const { data, status } = await useApiData<Page<CollectionCard>>(
  'browse-collections',
  () => {
    const params = new URLSearchParams({ limit: '100' })
    if (q.value) params.set('q', q.value)
    if (tag.value) params.set('tag', tag.value)
    return `/collections?${params.toString()}`
  },
  // The URL is a function of these, so the fetch has to follow them.
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

const collections = computed(() => data.value?.items ?? [])

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

    <div v-if="collections.length" class="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-4">
      <MediaCard
        v-for="collection in collections"
        :key="collection.id"
        class="w-full"
        :to="collectionPath(collection)"
        :title="collection.title"
        :subtitle="collection.year ? String(collection.year) : null"
        :image-url="collectionPoster(collection)"
        :badge="collection.state === 'PUBLISHED' ? null : collection.state"
      />
    </div>

    <p v-else-if="status !== 'pending'" class="py-20 text-center text-(--ui-text-muted)">
      {{ q ? `Nothing matches “${q}”.` : 'The library is empty.' }}
    </p>
  </div>
</template>
