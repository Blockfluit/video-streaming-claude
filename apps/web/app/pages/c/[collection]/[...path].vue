<script setup lang="ts">
/**
 * The one route for everything inside a collection.
 *
 * `/c/south-park/pilot` is ambiguous — `pilot` could be a season or a video —
 * so the router does not guess. `GET /collections/:slug/resolve` decides in one
 * round trip, and it checks **season slugs before video slugs**. Having the
 * rule in exactly one place is what stops the frontend and the API from
 * disagreeing about what a URL means.
 *
 * Every arm of this route is a *title page*: something to read before deciding
 * to watch. Playback lives at `/watch/:id`.
 */
interface ResolvedVideo {
  id: string
  slug: string
  title: string
  description: string | null
  tags: string[]
  state: string
  durationSec: number | null
  width: number | null
  height: number | null
  orderIndex: number | null
  seasonId: string | null
  thumbnailKey?: string | null
  collection: { id: string, slug: string, title: string, posterKey?: string | null }
  season?: { id: string, slug: string, number: number | null } | null
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

interface ResolvedSeason {
  id: string
  slug: string
  number: number | null
  title: string | null
  collection: ResolvedCollection
}

type Resolved =
  | { type: 'collection', data: ResolvedCollection }
  | { type: 'season', data: ResolvedSeason }
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

const video = computed(() =>
  resolved.value?.type === 'video' ? (resolved.value.data as ResolvedVideo) : null,
)

const season = computed(() =>
  resolved.value?.type === 'season' ? (resolved.value.data as ResolvedSeason) : null,
)

/** Just enough to build links and a heading, whichever shape resolved. */
const collection = computed(() => {
  if (video.value) return video.value.collection
  if (season.value) return season.value.collection
  return resolved.value!.data as ResolvedCollection
})

/**
 * The whole collection, for the episode list and for what "next episode"
 * means.
 *
 * This endpoint rather than `/videos?collectionId=` because it carries the
 * **seasons with their slugs**. A video row only knows its `seasonId`, and a
 * title-page URL needs the slug — building one without it silently drops the
 * season segment and links every episode of a show to a 404.
 */
const { data: detail } = await useApiData<{
  year: number | null
  seasons: { id: string, slug: string, number: number | null, title: string | null }[]
  videos: (ResolvedVideo & { seasonId: string | null })[]
}>(
  () => `detail-${collectionSlug.value}`,
  () => `/collections/${collectionSlug.value}`,
  { watch: [collectionSlug] },
)

const seasonSlugById = computed(
  () => new Map((detail.value?.seasons ?? []).map(s => [s.id, s.slug])),
)

const ordered = computed(() =>
  [...(detail.value?.videos ?? [])].sort(
    (a, b) =>
      (a.orderIndex ?? Number.POSITIVE_INFINITY) - (b.orderIndex ?? Number.POSITIVE_INFINITY)
      || a.title.localeCompare(b.title),
  ),
)

/** Every in-collection link goes through here, so none of them can forget the season. */
function linkTo(entry: { slug: string, seasonId?: string | null }): string {
  const seasonSlug = entry.seasonId ? seasonSlugById.value.get(entry.seasonId) : undefined
  return watchPath({
    slug: entry.slug,
    collection: { slug: collection.value.slug },
    season: seasonSlug ? { slug: seasonSlug } : null,
  }) ?? '#'
}

/**
 * The collection as the title page wants it. `year` only comes back on the
 * detail read, so it is grafted on rather than being expected from `resolve`.
 */
const collectionView = computed(() => ({
  id: collection.value.id,
  slug: collection.value.slug,
  title: collection.value.title,
  description: collection.value.description ?? null,
  year: detail.value?.year ?? null,
  posterKey: collection.value.posterKey,
}))

useHead(() => ({ title: video.value?.title ?? collection.value?.title ?? 'Library' }))
</script>

<template>
  <VideoSummary
    v-if="video"
    :video="video"
    :collection="video.collection"
    :season="video.season"
    :siblings="ordered"
    :link-to="linkTo"
  />

  <CollectionSummary
    v-else
    :collection="collectionView"
    :seasons="detail?.seasons ?? []"
    :videos="ordered"
    :season="season"
    :link-to="linkTo"
  />
</template>
