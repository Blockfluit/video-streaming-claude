<script setup lang="ts">
/**
 * The one route for everything inside a collection.
 *
 * `/c/south-park/pilot` is ambiguous — `pilot` could be a season or a video —
 * so the router does not guess. `GET /collections/:slug/resolve` decides in one
 * round trip, and it checks **season slugs before video slugs**. Having the
 * rule in exactly one place is what stops the frontend and the API from
 * disagreeing about what a URL means.
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
  introStartSec: number | null
  introEndSec: number | null
  outroStartSec: number | null
  outroEndSec: number | null
  collection: { id: string, slug: string, title: string }
  season?: { id: string, slug: string, number: number | null } | null
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

const isVideo = computed(() => resolved.value?.type === 'video')
const video = computed(() => (isVideo.value ? (resolved.value!.data as ResolvedVideo) : null))
/** Just enough to build links and a breadcrumb, whichever shape resolved. */
const collection = computed(() =>
  isVideo.value
    ? (resolved.value!.data as ResolvedVideo).collection
    : (resolved.value!.data as ResolvedCollection),
)

/** The full record, and only when the page *is* a collection or season. */
const collectionView = computed(() =>
  isVideo.value ? null : (resolved.value!.data as ResolvedCollection),
)

/**
 * The whole collection, for the episode list and for what "next episode"
 * means.
 *
 * This endpoint rather than `/videos?collectionId=` because it carries the
 * **seasons with their slugs**. A video row only knows its `seasonId`, and a
 * watch URL needs the slug — building one without it silently drops the season
 * segment and links every episode of a show to a 404.
 */
const { data: detail } = await useApiData<{
  seasons: { id: string, slug: string, number: number | null }[]
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
  return overviewPath({
    slug: entry.slug,
    collection: { slug: collection.value.slug },
    season: seasonSlug ? { slug: seasonSlug } : null,
  }) ?? '#'
}

const nextTo = computed(() => {
  if (!video.value) return null
  const index = ordered.value.findIndex(v => v.id === video.value!.id)
  const next = index >= 0 ? ordered.value[index + 1] : undefined
  return next ? linkTo(next) : null
})

const player = ref<{ seek?: (s: number) => void } | null>(null)
const currentTime = ref(0)

const { isAdmin } = useSession()

useHead(() => ({ title: video.value?.title ?? collection.value?.title ?? 'Library' }))
</script>

<template>
  <div class="page-shell pt-24 pb-24">
    <!-- A video: the player, its details, and the rest of the collection. -->
    <template v-if="video">
      <nav class="mb-4 flex items-center gap-2 text-sm text-(--ui-text-muted)">
        <NuxtLink :to="`/c/${collection.slug}`" class="hover:text-white">
          {{ collection.title }}
        </NuxtLink>
        <span>/</span>
        <span class="text-(--ui-text)">{{ video.title }}</span>
      </nav>

      <div class="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div class="space-y-6">
          <VideoPlayer
            ref="player"
            :video-id="video.id"
            :title="video.title"
            :duration-sec="video.durationSec"
            :markers="video"
            :next-to="nextTo"
            @timeupdate="seconds => (currentTime = seconds)"
          />

          <div class="space-y-3">
            <div class="flex flex-wrap items-center gap-3">
              <h1 class="text-2xl font-bold tracking-tight">{{ video.title }}</h1>
              <QualityBadge :width="video.width" :height="video.height" />
              <UBadge v-if="video.state !== 'PUBLISHED'" color="warning" variant="subtle">
                {{ video.state }}
              </UBadge>
              <span v-if="runtime(video.durationSec)" class="text-sm text-(--ui-text-muted)">
                {{ runtime(video.durationSec) }}
              </span>
              <div class="ml-auto flex items-center gap-2">
                <AddToListButton :video-id="video.id" label />
                <!--
                  Straight to this video's editor, so fixing a title or a
                  marker does not mean walking back through the admin library
                  to find the row you were just looking at. Admins only — the
                  API refuses either way, but offering a button that 403s is
                  not an interface.
                -->
                <UButton
                  v-if="isAdmin"
                  :to="`/admin/videos/${video.id}`"
                  color="neutral"
                  variant="subtle"
                  icon="i-lucide-pencil"
                >
                  Edit
                </UButton>
              </div>
            </div>

            <p v-if="video.description" class="max-w-3xl text-(--ui-text-muted)">{{ video.description }}</p>

            <div v-if="video.tags?.length" class="flex flex-wrap gap-2">
              <UBadge
                v-for="tag in video.tags"
                :key="tag"
                color="neutral"
                variant="subtle"
                :to="`/browse?tag=${encodeURIComponent(tag)}`"
              >
                {{ tag }}
              </UBadge>
            </div>
          </div>

          <USeparator />

          <CreditsPanel :video-id="video.id" />

          <USeparator />

          <CommentThread
            :video-id="video.id"
            :current-time="currentTime"
            @seek="seconds => player?.seek?.(seconds)"
          />
        </div>

        <!-- The rest of the collection, so the next thing is one click away. -->
        <aside v-if="ordered.length > 1" class="space-y-3">
          <h2 class="text-sm font-semibold tracking-wide text-(--ui-text-muted) uppercase">
            More from {{ collection.title }}
          </h2>
          <ul class="space-y-2">
            <li v-for="entry in ordered" :key="entry.id">
              <NuxtLink
                :to="linkTo(entry)"
                class="flex gap-3 rounded-md p-2 transition-colors"
                :class="entry.id === video.id ? 'bg-(--ui-bg-accented)' : 'hover:bg-(--ui-bg-elevated)'"
              >
                <img
                  :src="`/api/videos/${entry.id}/thumbnail`"
                  alt=""
                  loading="lazy"
                  class="aspect-video w-28 shrink-0 rounded object-cover bg-(--ui-bg-elevated)"
                >
                <div class="min-w-0">
                  <p class="truncate text-sm font-medium">{{ entry.title }}</p>
                  <p class="text-xs text-(--ui-text-muted)">{{ runtime(entry.durationSec) }}</p>
                </div>
              </NuxtLink>
            </li>
          </ul>
        </aside>
      </div>
    </template>

    <!-- A collection or season: its artwork, and everything in it. -->
    <template v-else>
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
          :to="linkTo(entry)"
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
    </template>
  </div>
</template>
