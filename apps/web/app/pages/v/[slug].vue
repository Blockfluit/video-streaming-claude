<script setup lang="ts">
/**
 * A video's own page — what you read before deciding to watch it.
 *
 * This is where a video lives. It used to be reachable only at
 * `/c/<collection>/<season>/<video>`, which assumed one parent — and a video may
 * sit in several collections, or in none at all. A standalone film is not a
 * video missing its collection; it is the ordinary case.
 *
 * It used to open the player straight away, with the synopsis, cast and comments
 * stacked underneath: everything you would read to decide sat below the fold of
 * the thing you had already committed to. Playback is at `/watch/<slug>` now and
 * this page describes.
 *
 * What it belongs to is shown rather than assumed: every collection holding it
 * gets a link, and the "more from" shelf is drawn for the first of them.
 */
interface Membership {
  collectionId: string
  seasonId: string | null
  orderIndex: number | null
  collection: { id: string, slug: string, title: string, state: string }
}

interface VideoDetail {
  id: string
  slug: string
  title: string
  description: string | null
  tags: string[]
  state: string
  durationSec: number | null
  width: number | null
  height: number | null
  thumbnailKey?: string | null
  collections: Membership[]
}

const route = useRoute()
const slug = computed(() => String(route.params.slug))

const { data: video, error } = await useApiData<VideoDetail>(
  () => `video-${slug.value}`,
  () => `/videos/by-slug/${encodeURIComponent(slug.value)}`,
  { watch: [slug] },
)

if (error.value) {
  throw createError({ statusCode: 404, statusMessage: 'No such video', fatal: true })
}

/** The collection the "more from" shelf is drawn from, when there is one. */
const primary = computed(() => video.value?.collections?.[0] ?? null)

/**
 * The rest of that collection.
 *
 * Fetched only when the video is in one — a standalone film has no siblings, and
 * asking for them would be a request whose answer is always empty.
 */
const { data: siblings } = await useApiData<{
  items: {
    id: string
    slug: string
    title: string
    durationSec: number | null
    width: number | null
    height: number | null
    state: string
    thumbnailKey?: string | null
  }[]
}>(
  () => `siblings-${primary.value?.collectionId ?? 'none'}`,
  () => `/videos?collectionId=${primary.value!.collectionId}&limit=100`,
  { watch: [primary], immediate: !!primary.value },
)

const otherVideos = computed(() =>
  (siblings.value?.items ?? []).filter(entry => entry.id !== video.value?.id),
)

/**
 * Where this viewer got to, which decides whether the button says Play or
 * Resume. The player asks for the same thing to offer a resume once metadata
 * arrives; asking here as well is what lets the button name a time before anyone
 * has committed to loading a stream.
 */
const { data: stats } = await useApiData<{ mine: { lastPositionSec: number } | null }>(
  () => `summary-stats-${video.value?.id ?? 'none'}`,
  () => `/videos/${video.value!.id}/stats`,
  { watch: [() => video.value?.id], immediate: !!video.value },
)

/** Under 5s in is not worth resuming; that is where the player draws it too. */
const resumeAt = computed(() => {
  const position = stats.value?.mine?.lastPositionSec ?? 0
  const duration = video.value?.durationSec ?? 0
  return position > 5 && duration > 0 && position < duration * 0.95 ? position : null
})

/**
 * `S1 E3`, from where this video sits in the collection being shown.
 *
 * The number is its **position among that collection's videos**, not its
 * `orderIndex`: the parser stores the number it read off a filename, and a
 * drag-reorder rewrites a season 0-based, so rendering `orderIndex` directly
 * labelled the first episode of a real show "E0".
 */
const episodeLabel = computed(() => {
  const membership = primary.value
  if (!membership?.seasonId) return null

  const inSeason = (siblings.value?.items ?? [])
  const position = inSeason.findIndex(entry => entry.id === video.value?.id)
  return position < 0 ? null : `Episode ${position + 1}`
})

const { isAdmin } = useSession()

useHead(() => ({ title: video.value?.title ?? 'Library' }))
</script>

<template>
  <div v-if="video">
    <HeroBackdrop :image="videoThumbnail(video)" size="tall">
      <div class="rise max-w-2xl space-y-4">
        <!--
          Every collection holding this video, not a guessed single parent. In
          muted text with a red rule rather than in red type: red on near-black
          passes WCAG and still reads poorly at 12px.
        -->
        <p
          v-if="video.collections.length"
          class="flex flex-wrap items-center gap-2 text-xs font-semibold tracking-[0.2em] text-(--ui-text-muted) uppercase"
        >
          <span aria-hidden="true" class="h-3 w-0.5 rounded-full bg-(--ui-primary)" />
          <template v-for="(membership, index) in video.collections" :key="membership.collectionId">
            <span v-if="index > 0" aria-hidden="true">·</span>
            <NuxtLink
              :to="collectionPath(membership.collection)"
              class="transition-colors hover:text-(--ui-text)"
            >
              {{ membership.collection.title }}
            </NuxtLink>
          </template>
        </p>

        <h1 class="text-4xl font-bold tracking-tight text-white sm:text-5xl">{{ video.title }}</h1>

        <div class="flex flex-wrap items-center gap-3 text-sm text-(--ui-text-muted)">
          <span v-if="episodeLabel">{{ episodeLabel }}</span>
          <span v-if="runtime(video.durationSec)">{{ runtime(video.durationSec) }}</span>
          <QualityBadge :width="video.width" :height="video.height" />
          <UBadge v-if="video.state !== 'PUBLISHED'" color="warning" variant="subtle">
            {{ video.state }}
          </UBadge>
        </div>

        <p v-if="video.description" class="text-(--ui-text-toned)">{{ video.description }}</p>

        <div class="flex flex-wrap items-center gap-3 pt-2">
          <!-- The one real call to action on the screen, so it is the solid one. -->
          <UButton :to="playPath(video)" size="lg" icon="i-lucide-play" class="font-semibold">
            {{ resumeAt === null ? 'Play' : `Resume from ${timecode(resumeAt)}` }}
          </UButton>
          <AddToListButton :video-id="video.id" label />
          <!--
            Straight to this video's editor, so fixing a title or a marker does
            not mean walking back through the admin library to find the row you
            were just looking at.
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
    </HeroBackdrop>

    <div class="page-shell relative z-1 -mt-4 space-y-8 pb-24">
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

      <CreditsPanel :video-id="video.id" />

      <MediaRow
        v-if="primary && otherVideos.length"
        :title="`More from ${primary.collection.title}`"
        :empty="false"
        :to="collectionPath(primary.collection)"
      >
        <MediaCard
          v-for="entry in otherVideos"
          :key="entry.id"
          class="w-56 sm:w-64"
          :to="watchPath(entry)"
          :title="entry.title"
          :subtitle="runtime(entry.durationSec)"
          :image-url="videoThumbnail(entry)"
          :width="entry.width"
          :height="entry.height"
          :badge="entry.state === 'PUBLISHED' ? null : entry.state"
        />
      </MediaRow>
    </div>
  </div>
</template>
