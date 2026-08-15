<script setup lang="ts">
/**
 * Playback, and nothing else.
 *
 * A separate route from `/v/:slug` rather than a mode that page switches into,
 * so Back returns to the description and a link that starts playing can be
 * shared as one. Keyed on the slug like every other address in the app.
 *
 * The page carries the player and the comments. Synopsis, cast and the rest of
 * the collection live on `/v/:slug` — the page you go back to.
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
  state: string
  durationSec: number | null
  width: number | null
  height: number | null
  introStartSec: number | null
  introEndSec: number | null
  outroStartSec: number | null
  outroEndSec: number | null
  collections: Membership[]
}

const route = useRoute()
const slug = computed(() => String(route.params.slug))

const { data: video, error } = await useApiData<VideoDetail>(
  () => `playback-${slug.value}`,
  () => `/videos/by-slug/${encodeURIComponent(slug.value)}`,
  { watch: [slug] },
)

if (error.value) {
  throw createError({ statusCode: 404, statusMessage: 'No such video', fatal: true })
}

const primary = computed(() => video.value?.collections?.[0] ?? null)

/**
 * The rest of the collection, for what "next episode" means. Asked for only
 * when there is a collection to ask about — a standalone film has no next.
 */
const { data: siblings } = await useApiData<{
  items: { id: string, slug: string, title: string }[]
}>(
  () => `siblings-${primary.value?.collectionId ?? 'none'}`,
  () => `/videos?collectionId=${primary.value!.collectionId}&limit=100`,
  { watch: [primary], immediate: !!primary.value },
)

/**
 * Next keeps *playing* rather than bouncing through a description. Someone who
 * has reached the outro of episode three has already decided.
 */
const nextTo = computed(() => {
  const ordered = siblings.value?.items ?? []
  const index = ordered.findIndex(entry => entry.id === video.value?.id)
  const next = index >= 0 ? ordered[index + 1] : undefined
  return next ? playPath(next) : null
})

/** Back to this video's own page, which is where the cast and synopsis are. */
const backTo = computed(() => (video.value ? videoPath(video.value) : '/browse'))

/**
 * Where **Details** goes, which is not always `backTo`.
 *
 * For an episode it is the series: mid-episode, what someone wants back is the
 * show they picked it from, not a page about the episode they are looking at.
 * For a film — standalone or in a saga — it stays the film's own page, which
 * holds the synopsis and cast that no collection page repeats. `detailsPath`
 * owns that branch so it can be tested; the breadcrumb keeps `backTo`, because
 * the video's own name there must lead to the video.
 */
const detailsTo = computed(() => (video.value ? detailsPath(video.value) : '/browse'))

const player = ref<{ seek?: (s: number) => void } | null>(null)
const currentTime = ref(0)

const { isAdmin } = useSession()

useHead(() => ({ title: video.value?.title ?? 'Watch' }))
</script>

<template>
  <div v-if="video" class="page-shell pt-24 pb-24">
    <nav class="mb-4 flex flex-wrap items-center gap-2 text-sm text-(--ui-text-muted)">
      <template v-for="membership in video.collections" :key="membership.collectionId">
        <NuxtLink
          :to="collectionPath(membership.collection)"
          class="transition-colors hover:text-(--ui-text)"
        >
          {{ membership.collection.title }}
        </NuxtLink>
        <span aria-hidden="true">/</span>
      </template>
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
        <QualityBadge :width="video.width" :height="video.height" />
        <UBadge v-if="video.state !== 'PUBLISHED'" color="warning" variant="subtle">
          {{ video.state }}
        </UBadge>
        <!--
          The pair is kept together in one `ml-auto` group rather than pushed
          apart: with the margin on the first button, a second one lands beside
          the title and the row reads as two unrelated halves.
        -->
        <div class="ml-auto flex items-center gap-2">
          <!--
            Everything worth reading about this video is one click away — and for
            an episode that is the series, not the episode. See `detailsTo`.
          -->
          <UButton :to="detailsTo" color="neutral" variant="subtle" icon="i-lucide-info">
            Details
          </UButton>
          <!--
            A wrong title or a misplaced marker is noticed here, with the video
            playing — not on the page you came from. Admins only: the API
            refuses either way, but offering a button that 403s is not an
            interface.
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
