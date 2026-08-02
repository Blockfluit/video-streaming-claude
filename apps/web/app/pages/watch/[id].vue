<script setup lang="ts">
/**
 * Playback, and nothing else.
 *
 * Keyed on the video id rather than the slug path the rest of the app uses,
 * because every surface that offers to *resume* something holds a video row and
 * not reliably its season's slug. The cost is a second way to address a video,
 * and it is paid for here: the link back to the title page and the next-episode
 * link are both built from this response, so no caller has to translate between
 * the two schemes. `links.ts` is still the only place either URL is written.
 *
 * The page carries the player and the comments. Cast, synopsis and the rest of
 * the collection live on the title page — the one you go back to.
 */
interface PlaybackVideo {
  id: string
  slug: string
  title: string
  description: string | null
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
  season: { id: string, slug: string, number: number | null } | null
}

const route = useRoute()
const videoId = computed(() => String(route.params.id))

const { data: video, error } = await useApiData<PlaybackVideo>(
  () => `playback-${videoId.value}`,
  () => `/videos/${videoId.value}/playback`,
  { watch: [videoId] },
)

if (error.value || !video.value) {
  throw createError({ statusCode: 404, statusMessage: 'Not found in this library', fatal: true })
}

/**
 * The rest of the collection, for what "next episode" means. The same endpoint
 * the title page uses, and for the same reason: a video row knows its
 * `seasonId` but not its season's slug.
 */
const { data: detail } = await useApiData<{
  videos: { id: string, slug: string, title: string, orderIndex: number | null, seasonId: string | null }[]
}>(
  () => `detail-${video.value!.collection.slug}`,
  () => `/collections/${video.value!.collection.slug}`,
  { watch: [() => video.value?.collection.slug] },
)

const ordered = computed(() =>
  [...(detail.value?.videos ?? [])].sort(
    (a, b) =>
      (a.orderIndex ?? Number.POSITIVE_INFINITY) - (b.orderIndex ?? Number.POSITIVE_INFINITY)
      || a.title.localeCompare(b.title),
  ),
)

/**
 * Next keeps *playing* rather than bouncing through a title page. Someone who
 * has reached the outro of episode three has already decided.
 */
const nextTo = computed(() => {
  const index = ordered.value.findIndex(entry => entry.id === video.value!.id)
  const next = index >= 0 ? ordered.value[index + 1] : undefined
  return next ? playPath(next) : null
})

/** Back to this video's own page, which is where the cast and the synopsis are. */
const backTo = computed(
  () =>
    watchPath({
      slug: video.value!.slug,
      collection: { slug: video.value!.collection.slug },
      season: video.value!.season,
    }) ?? `/c/${video.value!.collection.slug}`,
)

/**
 * The episode number is this video's **position in its season**, not its
 * `orderIndex` — which is not an episode number however much it looks like one.
 * The parser stores the number read off the filename; dragging an episode in
 * the admin UI rewrites the whole season 0-based. The title page numbers its
 * rows the same way, so the two agree.
 */
const episodeLabel = computed(() => {
  const seasonNumber = video.value?.season?.number
  if (seasonNumber === null || seasonNumber === undefined) return null

  const inSeason = ordered.value.filter(entry => entry.seasonId === video.value!.seasonId)
  const position = inSeason.findIndex(entry => entry.id === video.value!.id)
  return position < 0 ? `Season ${seasonNumber}` : `S${seasonNumber} E${position + 1}`
})

const player = ref<{ seek?: (s: number) => void } | null>(null)
const currentTime = ref(0)

useHead(() => ({ title: video.value?.title ?? 'Watch' }))
</script>

<template>
  <div v-if="video" class="page-shell pt-24 pb-24">
    <nav class="mb-4 flex flex-wrap items-center gap-2 text-sm text-(--ui-text-muted)">
      <NuxtLink :to="`/c/${video.collection.slug}`" class="transition-colors hover:text-(--ui-text)">
        {{ video.collection.title }}
      </NuxtLink>
      <span aria-hidden="true">/</span>
      <NuxtLink :to="backTo" class="text-(--ui-text) transition-colors hover:text-white">
        {{ video.title }}
      </NuxtLink>
    </nav>

    <div class="mx-auto max-w-6xl space-y-6">
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
        <h1 class="text-xl font-semibold tracking-tight">{{ video.title }}</h1>
        <span v-if="episodeLabel" class="text-sm text-(--ui-text-muted)">{{ episodeLabel }}</span>
        <QualityBadge :width="video.width" :height="video.height" />
        <UBadge v-if="video.state !== 'PUBLISHED'" color="warning" variant="subtle">
          {{ video.state }}
        </UBadge>
        <!-- Everything worth reading about this video is one click away. -->
        <UButton
          :to="backTo"
          color="neutral"
          variant="subtle"
          icon="i-lucide-info"
          class="ml-auto"
        >
          Details
        </UButton>
      </div>

      <USeparator />

      <!--
        Comments stay with the player: one pinned to a moment seeks the video
        that is on screen, which it cannot do from a page with no player on it.
      -->
      <CommentThread
        :video-id="video.id"
        :current-time="currentTime"
        @seek="seconds => player?.seek?.(seconds)"
      />
    </div>
  </div>
</template>
