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
const backTo = computed(() => (video.value ? watchPath(video.value) : '/browse'))

const player = ref<{ seek?: (s: number) => void } | null>(null)
const currentTime = ref(0)

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
        <!-- Everything worth reading about this video is one click away. -->
        <UButton :to="backTo" color="neutral" variant="subtle" icon="i-lucide-info" class="ml-auto">
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
