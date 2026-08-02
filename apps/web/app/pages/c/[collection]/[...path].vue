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
  year?: number | null
  posterKey?: string | null
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

/** Set only when the URL named a season; the page then scopes its list to it. */
const season = computed(() =>
  resolved.value?.type === 'season'
    ? (resolved.value.data as ResolvedCollection & { number: number | null })
    : null,
)

/**
 * The whole collection: what to list on the page, in the order the collection
 * puts it in. That order is a fact about the membership, which is why it comes
 * from here rather than from a plain video listing.
 */
const { data: detail } = await useApiData<{
  year: number | null
  posterKey: string | null
  seasons: { id: string, slug: string, number: number | null, title: string | null }[]
  videos: {
    id: string
    slug: string
    title: string
    description: string | null
    state: string
    durationSec: number | null
    width: number | null
    height: number | null
    thumbnailKey: string | null
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

/**
 * The collection as the title page wants it. `year` and `posterKey` come back on
 * the detail read rather than from `resolve`, so they are grafted on.
 */
const collectionView = computed(() => ({
  id: collection.value.id,
  slug: collection.value.slug,
  title: collection.value.title,
  description: collection.value.description ?? null,
  year: detail.value?.year ?? null,
  posterKey: detail.value?.posterKey ?? null,
}))

useHead(() => ({ title: collection.value?.title ?? 'Library' }))
</script>

<template>
  <CollectionSummary
    :collection="collectionView"
    :seasons="detail?.seasons ?? []"
    :videos="ordered"
    :season="season"
  />
</template>
