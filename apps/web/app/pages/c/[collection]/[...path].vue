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
 * It renders three things, not two. A video resolves to an **overview** —
 * artwork, trailer, metadata — and only puts the player on screen when the URL
 * says `?play=1`. Clicking a card used to start playback immediately, which
 * gave nobody a chance to read what it was first.
 */
import { trailerYoutubeIdFor } from '@video/shared'

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
  thumbnailKey: string | null
  bannerKey: string | null
  trailerYoutubeId: string | null
  introStartSec: number | null
  introEndSec: number | null
  outroStartSec: number | null
  outroEndSec: number | null
  collection: ResolvedCollection
  season?: { id: string, slug: string, number: number | null } | null
}

interface ResolvedCollection {
  id: string
  slug: string
  title: string
  description: string | null
  state: string
  posterKey?: string | null
  bannerKey?: string | null
  trailerYoutubeId?: string | null
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

/**
 * Whether the player is on screen.
 *
 * Deliberately **not** in either fetch's `watch` array below. Both key on the
 * slug and the path only, so toggling `?play=1` is a query-only navigation on
 * the same route component: `useAsyncData` serves what it already has and no
 * request goes out. Adding `playing` there would turn every Play click into two
 * refetches and a visible flash — the absence of it is the design.
 */
const playing = computed(() => route.query.play === '1')

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
  year: number | null
  tags: string[]
  posterKey: string | null
  bannerKey: string | null
  trailerYoutubeId: string | null
  videosTruncated: boolean
  next: { id: string, video: { id: string } } | null
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

/** Seasons with their episodes, films last. The grouping is shared with the admin editor. */
const groups = computed(() =>
  groupVideosBySeason(detail.value?.seasons ?? [], detail.value?.videos ?? []),
)

/** Every in-collection link goes through here, so none of them can forget the season. */
function linkTo(entry: { slug: string, seasonId?: string | null }, play = false): string {
  const seasonSlug = entry.seasonId ? seasonSlugById.value.get(entry.seasonId) : undefined
  const target = {
    slug: entry.slug,
    collection: { slug: collection.value.slug },
    season: seasonSlug ? { slug: seasonSlug } : null,
  }

  return (play ? playPath(target) : overviewPath(target)) ?? '#'
}

/** The player's "next episode" resumes; every card opens an overview. */
const nextTo = computed(() => {
  if (!video.value) return null
  const index = ordered.value.findIndex(v => v.id === video.value!.id)
  const next = index >= 0 ? ordered.value[index + 1] : undefined
  return next ? linkTo(next, true) : null
})

/** What the collection's Play button offers, resolved server-side against progress. */
const nextEntry = computed(() => {
  const next = detail.value?.next
  return next ? ordered.value.find(v => v.id === next.video.id) ?? null : null
})

const resumeTo = computed(() => (nextEntry.value ? linkTo(nextEntry.value, true) : null))

const resumeLabel = computed(() => {
  const entry = nextEntry.value
  if (!entry) return 'Play'

  const season = entry.seasonId ? detail.value?.seasons.find(s => s.id === entry.seasonId) : null
  return season?.number ? `Play S${season.number} · ${entry.title}` : `Play ${entry.title}`
})

/**
 * The viewer's own progress, for the overview's Resume button.
 *
 * `VideoPlayer` fetches this for itself under its own key. Two small requests
 * when someone presses Play, rather than threading state into a component that
 * is meant to be self-contained.
 */
const { data: stats } = await useApiData<{ mine: { lastPositionSec: number } | null }>(
  () => `overview-stats-${collectionSlug.value}-${path.value}`,
  () => `/videos/${video.value!.id}/stats`,
  { watch: [collectionSlug, path], immediate: Boolean(video.value) },
)

const resumeAt = computed(() => {
  const position = stats.value?.mine?.lastPositionSec ?? 0
  const duration = video.value?.durationSec ?? 0
  // The same rule the player uses before offering to resume: not the first few
  // seconds, and not the very end.
  return position > 5 && duration > 0 && position < duration * 0.95 ? position : 0
})

const heroImage = computed(() =>
  video.value
    ? videoHeroImage(video.value, video.value.collection)
    : collectionHeroImage({
      id: collection.value.id,
      bannerKey: detail.value?.bannerKey ?? collectionView.value?.bannerKey ?? null,
      posterKey: detail.value?.posterKey ?? collectionView.value?.posterKey ?? null,
    }),
)

const heroTrailer = computed(() =>
  video.value
    ? trailerYoutubeIdFor(video.value, video.value.collection)
    : (detail.value?.trailerYoutubeId ?? collectionView.value?.trailerYoutubeId ?? null),
)

const videoMeta = computed(() =>
  [
    runtime(video.value?.durationSec ?? null),
    video.value?.season?.number ? `Season ${video.value.season.number}` : null,
  ]
    .filter(Boolean)
    .join(' · ') || null,
)

const episodeCount = computed(() => ordered.value.length)

const collectionMeta = computed(() =>
  [
    detail.value?.year ? String(detail.value.year) : null,
    episodeCount.value ? `${episodeCount.value} ${episodeCount.value === 1 ? 'video' : 'videos'}` : null,
    runtime(ordered.value.reduce((sum, entry) => sum + (entry.durationSec ?? 0), 0)),
  ]
    .filter(Boolean)
    .join(' · ') || null,
)

const player = ref<{ seek?: (s: number) => void } | null>(null)
const currentTime = ref(0)

const { isAdmin } = useSession()

useHead(() => ({ title: video.value?.title ?? collection.value?.title ?? 'Library' }))
</script>

<template>
  <div>
    <!-- A video, playing: the player and everything around it. -->
    <div v-if="video && playing" class="page-shell pt-24 pb-24">
      <nav class="mb-4 flex items-center gap-2 text-sm text-(--ui-text-muted)">
        <NuxtLink :to="`/c/${collection.slug}`" class="hover:text-white">
          {{ collection.title }}
        </NuxtLink>
        <span>/</span>
        <NuxtLink :to="linkTo(video)" class="hover:text-white">{{ video.title }}</NuxtLink>
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

          <div class="flex flex-wrap items-center gap-3">
            <h1 class="text-2xl font-bold tracking-tight">{{ video.title }}</h1>
            <QualityBadge :width="video.width" :height="video.height" />
            <span v-if="runtime(video.durationSec)" class="text-sm text-(--ui-text-muted)">
              {{ runtime(video.durationSec) }}
            </span>
          </div>

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
    </div>

    <!-- A video, not playing: the overview. -->
    <template v-else-if="video">
      <TrailerHero
        :title="video.title"
        :eyebrow="collection.title"
        :meta="videoMeta"
        :description="video.description"
        :image-url="heroImage"
        :trailer-youtube-id="heroTrailer"
      >
        <UButton :to="linkTo(video, true)" size="lg" icon="i-lucide-play" class="font-semibold">
          {{ resumeAt ? `Resume at ${timecode(resumeAt)}` : 'Play' }}
        </UButton>
        <AddToListButton :video-id="video.id" label />
        <!--
          Straight to this video's editor, so fixing a title or a marker does
          not mean walking back through the admin library to find the row you
          were just looking at. Admins only — the API refuses either way, but
          offering a button that 403s is not an interface.
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
      </TrailerHero>

      <div class="page-shell relative z-1 -mt-16 space-y-8 pb-24">
        <div class="flex flex-wrap items-center gap-3">
          <QualityBadge :width="video.width" :height="video.height" />
          <UBadge v-if="video.state !== 'PUBLISHED'" color="warning" variant="subtle">
            {{ video.state }}
          </UBadge>
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

        <USeparator />

        <CreditsPanel :video-id="video.id" />

        <!-- The rest of the collection. -->
        <template v-if="ordered.length > 1">
          <USeparator />
          <section class="space-y-4">
            <h2 class="text-sm font-semibold tracking-wide text-(--ui-text-muted) uppercase">
              More from {{ collection.title }}
            </h2>
            <div class="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-4">
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
          </section>
        </template>
      </div>
    </template>

    <!-- A collection or season: its artwork, and everything in it, by season. -->
    <template v-else>
      <TrailerHero
        :title="collection.title"
        eyebrow="Collection"
        :meta="collectionMeta"
        :description="collectionView?.description"
        :image-url="heroImage"
        :trailer-youtube-id="heroTrailer"
      >
        <UButton
          v-if="resumeTo"
          :to="resumeTo"
          size="lg"
          icon="i-lucide-play"
          class="font-semibold"
        >
          {{ resumeLabel }}
        </UButton>
        <AddToListButton :collection-id="collection.id" label />
        <UButton
          v-if="isAdmin"
          :to="`/admin/collections/${collection.slug}`"
          color="neutral"
          variant="subtle"
          icon="i-lucide-pencil"
        >
          Edit
        </UButton>
      </TrailerHero>

      <div class="page-shell relative z-1 -mt-16 space-y-10 pb-24">
        <div v-if="detail?.tags?.length" class="flex flex-wrap gap-2">
          <UBadge
            v-for="tag in detail.tags"
            :key="tag"
            color="neutral"
            variant="subtle"
            :to="`/browse?tag=${encodeURIComponent(tag)}`"
          >
            {{ tag }}
          </UBadge>
        </div>

        <!--
          Grouped by season rather than flattened into one grid. A show with two
          hundred episodes was an unreadable wall of cards, and the seasons were
          already in this response and simply ignored.
        -->
        <section v-for="group in groups" :key="group.season?.id ?? 'loose'" class="space-y-4">
          <h2 v-if="groups.length > 1 || group.season" class="text-lg font-semibold tracking-tight">
            {{ seasonLabel(group.season) }}
          </h2>
          <div class="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-4">
            <MediaCard
              v-for="entry in group.videos"
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
        </section>

        <!--
          The API has already said the list is capped. Saying so beats silently
          showing 500 of 600 episodes, which reads as missing data.
        -->
        <p v-if="detail?.videosTruncated" class="text-sm text-(--ui-text-muted)">
          Showing the first {{ episodeCount }} videos in this collection.
        </p>

        <p v-if="episodeCount === 0" class="py-20 text-center text-(--ui-text-muted)">
          Nothing in this collection yet.
        </p>
      </div>
    </template>
  </div>
</template>
