<script setup lang="ts">
import type { Page } from '@video/shared'

/**
 * Everything in the library, filterable by state — the way into any individual
 * record. Collections and videos side by side, since an admin looking for
 * "that thing" does not know or care which it is.
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

/**
 * `ANY` is a sentinel rather than an empty string: Reka UI reserves `''` to mean
 * "cleared", and an option carrying it throws during render — which takes the
 * whole page down, not just the select.
 */
const ANY = 'ANY'
const STATES = [
  { label: 'Any state', value: ANY },
  { label: 'Draft', value: 'DRAFT' },
  { label: 'Published', value: 'PUBLISHED' },
  { label: 'Archived', value: 'ARCHIVED' },
  { label: 'Missing', value: 'MISSING' },
]

const route = useRoute()
const router = useRouter()

const q = ref(String(route.query.q ?? ''))
const state = ref(String(route.query.state ?? 'ANY'))

const query = computed(() => {
  const params = new URLSearchParams({ limit: '100' })
  if (q.value) params.set('q', q.value)
  if (state.value && state.value !== ANY) params.set('state', state.value)
  return params.toString()
})

const { data: videos } = await useApiData<Page<VideoRow>>(
  'adm-lib-videos',
  () => `/videos?${query.value}`,
  { watch: [query] },
)
const { data: collections } = await useApiData<Page<CollectionRow>>(
  'adm-lib-collections',
  () => `/collections?${query.value}`,
  { watch: [query] },
)

watch([q, state], () => {
  router.replace({
    query: {
      q: q.value || undefined,
      state: state.value && state.value !== ANY ? state.value : undefined,
    },
  })
})


useHead({ title: 'All titles' })
</script>

<template>
  <div class="space-y-6">
    <h1 class="text-2xl font-bold tracking-tight">Library</h1>

    <div class="flex flex-wrap gap-3">
      <UInput v-model="q" icon="i-lucide-search" placeholder="Search titles" class="w-64" />
      <USelect v-model="state" :items="STATES" class="w-40" />
    </div>

    <section v-if="collections?.items?.length" class="space-y-2">
      <h2 class="text-sm font-semibold tracking-wide text-(--ui-text-muted) uppercase">
        Collections ({{ collections.total }})
      </h2>
      <div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        <NuxtLink
          v-for="collection in collections.items"
          :key="collection.id"
          :to="`/c/${collection.slug}`"
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
    </section>

    <section class="space-y-2">
      <h2 class="text-sm font-semibold tracking-wide text-(--ui-text-muted) uppercase">
        Videos ({{ videos?.total ?? 0 }})
      </h2>
      <div v-if="videos?.items?.length" class="overflow-hidden rounded-lg border border-(--ui-border)">
        <table class="w-full text-sm">
          <tbody class="divide-y divide-(--ui-border)">
            <tr v-for="video in videos.items" :key="video.id" class="hover:bg-white/[0.03]">
              <td class="p-3">
                <div class="flex items-center gap-3">
                  <img
                    :src="`/api/videos/${video.id}/thumbnail`"
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
      <p v-else class="py-12 text-center text-(--ui-text-muted)">Nothing matches.</p>
    </section>
  </div>
</template>
