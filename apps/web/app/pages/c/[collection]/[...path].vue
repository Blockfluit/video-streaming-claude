<script setup lang="ts">
/**
 * Collections and seasons, and the links people have already shared.
 *
 * `/c/south-park/pilot` is ambiguous — `pilot` could be a season or a video —
 * so the router does not guess. `GET /collections/:slug/resolve` decides in one
 * round trip, and it checks **season slugs before video slugs**. Having the
 * rule in exactly one place is what stops the frontend and the API from
 * disagreeing about what a URL means.
 *
 * A video resolved here is **redirected to `/v/<slug>`**, its own page. These
 * URLs assumed one parent per video, which stopped being true; they keep
 * working because a link someone shared should not rot, but they are no longer
 * where a video is shown.
 */
/** Only what the redirect needs: a resolved video is shown on its own page. */
interface ResolvedVideo {
  slug: string
}

interface ResolvedCollection {
  id: string
  slug: string
  title: string
  description: string | null
  state: string
}

type Resolved =
  | { type: 'collection', data: ResolvedCollection }
  | { type: 'season', data: ResolvedCollection & { collection: ResolvedCollection } }
  | { type: 'video', data: ResolvedVideo }

const route = useRoute()
const collectionSlug = computed(() => String(route.params.collection))
const path = computed(() => {
  const p = route.params.path
  return Array.isArray(p) ? p.join('/') : String(p ?? '')
})

const { data: resolved, error } = await useApiData<Resolved>(
  () => `resolve-${collectionSlug.value}-${path.value}`,
  () => `/collections/${collectionSlug.value}/resolve?path=${encodeURIComponent(path.value)}`,
  { watch: [collectionSlug, path] },
)

if (error.value) {
  throw createError({ statusCode: 404, statusMessage: 'Not found in this library', fatal: true })
}

// A shared link to a video lands on the video's own page.
if (resolved.value?.type === 'video') {
  await navigateTo(watchPath(resolved.value.data as ResolvedVideo), { redirectCode: 301 })
}

const collection = computed(() => resolved.value!.data as ResolvedCollection)
const collectionView = collection

/**
 * The whole collection: what to list on the page, in the order the collection
 * puts it in. That order is a fact about the membership, which is why it comes
 * from here rather than from a plain video listing.
 */
const { data: detail } = await useApiData<{
  seasons: { id: string, slug: string, number: number | null }[]
  videos: {
    id: string
    slug: string
    title: string
    state: string
    durationSec: number | null
    width: number | null
    height: number | null
    seasonId: string | null
    orderIndex: number | null
  }[]
}>(
  () => `detail-${collectionSlug.value}`,
  () => `/collections/${collectionSlug.value}`,
  { watch: [collectionSlug] },
)

const ordered = computed(() =>
  [...(detail.value?.videos ?? [])].sort(
    (a, b) =>
      (a.orderIndex ?? Number.POSITIVE_INFINITY) - (b.orderIndex ?? Number.POSITIVE_INFINITY)
      || a.title.localeCompare(b.title),
  ),
)

useHead(() => ({ title: collection.value?.title ?? 'Library' }))
</script>

<template>
  <div class="page-shell pt-24 pb-24">
    <div class="flex flex-col gap-6 sm:flex-row sm:items-end">
      <img
        :src="`/api/collections/${collection.id}/poster`"
        alt=""
        class="aspect-2/3 w-44 shrink-0 rounded-lg object-cover bg-(--ui-bg-elevated) ring-1 ring-(--ui-border)"
      >
      <div class="space-y-3">
        <h1 class="text-4xl font-bold tracking-tight">{{ collection.title }}</h1>
        <p v-if="collectionView?.description" class="max-w-2xl text-(--ui-text-muted)">
          {{ collectionView.description }}
        </p>
        <AddToListButton :collection-id="collection.id" label />
      </div>
    </div>

    <div class="mt-10 grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-4">
      <MediaCard
        v-for="entry in ordered"
        :key="entry.id"
        class="w-full"
        :to="watchPath(entry)"
        :title="entry.title"
        :subtitle="runtime(entry.durationSec)"
        :image-url="`/api/videos/${entry.id}/thumbnail`"
        :width="entry.width"
        :height="entry.height"
        :badge="entry.state === 'PUBLISHED' ? null : entry.state"
      />
    </div>

    <p v-if="ordered.length === 0" class="py-20 text-center text-(--ui-text-muted)">
      Nothing in this collection yet.
    </p>
  </div>
</template>
