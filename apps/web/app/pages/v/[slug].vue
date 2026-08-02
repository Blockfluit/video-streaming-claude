<script setup lang="ts">
/**
 * A video's own page.
 *
 * This is where a video lives now. It used to be reachable only at
 * `/c/<collection>/<season>/<video>`, which assumed one parent — and a video
 * may sit in several collections, or in none at all. A standalone film is not a
 * video missing its collection; it is the ordinary case.
 *
 * What it belongs to is shown rather than assumed: every collection holding it
 * gets a link, and the "more from" list is drawn for the first of them.
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
  introStartSec: number | null
  introEndSec: number | null
  outroStartSec: number | null
  outroEndSec: number | null
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

/** The collection the "more from" list is drawn from, when there is one. */
const primary = computed(() => video.value?.collections?.[0] ?? null)

/**
 * The rest of that collection.
 *
 * Fetched only when the video is in one — a standalone film has no siblings,
 * and asking for them would be a request whose answer is always empty.
 */
const { data: siblings } = await useApiData<{
  items: { id: string, slug: string, title: string, durationSec: number | null }[]
}>(
  () => `siblings-${primary.value?.collectionId ?? 'none'}`,
  () => `/videos?collectionId=${primary.value!.collectionId}&limit=100`,
  { watch: [primary], immediate: !!primary.value },
)

const ordered = computed(() => siblings.value?.items ?? [])

const nextTo = computed(() => {
  const index = ordered.value.findIndex(entry => entry.id === video.value?.id)
  const next = index >= 0 ? ordered.value[index + 1] : undefined
  return next ? watchPath(next) : null
})

const player = ref<{ seek?: (s: number) => void } | null>(null)
const currentTime = ref(0)

const { isAdmin } = useSession()

useHead(() => ({ title: video.value?.title ?? 'Library' }))
</script>

<template>
  <div v-if="video" class="page-shell pt-24 pb-24">
    <nav class="mb-4 flex flex-wrap items-center gap-2 text-sm text-(--ui-text-muted)">
      <template v-for="membership in video.collections" :key="membership.collectionId">
        <NuxtLink :to="collectionPath(membership.collection)" class="hover:text-white">
          {{ membership.collection.title }}
        </NuxtLink>
        <span>/</span>
      </template>
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

          <p v-if="video.description" class="max-w-3xl text-(--ui-text-muted)">
            {{ video.description }}
          </p>

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

      <aside v-if="primary && ordered.length > 1" class="space-y-3">
        <h2 class="text-sm font-semibold tracking-wide text-(--ui-text-muted) uppercase">
          More from {{ primary.collection.title }}
        </h2>
        <ul class="space-y-2">
          <li v-for="entry in ordered" :key="entry.id">
            <NuxtLink
              :to="watchPath(entry)"
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
</template>
