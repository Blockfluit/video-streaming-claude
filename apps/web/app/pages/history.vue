<script setup lang="ts">
import type { Page } from '@video/shared'

/**
 * Everything watched, most recent first, with how far it got.
 *
 * Unlike the home page's Continue Watching row this includes finished videos —
 * it is a history, not a queue.
 */
interface HistoryItem {
  video: {
    id: string
    slug: string
    title: string
    durationSec: number | null
    /** Every collection this video is in; empty for a standalone one. */
    collections: { collection: { slug: string, title: string } }[]
  }
  progress: {
    lastPositionSec: number
    secondsWatched: number
    completed: boolean
    lastWatchedAt: string
  }
}

/*
 * `lazy` so the page paints the moment it is navigated to, rather than leaving
 * the previous screen frozen until this resolves. It costs nothing on a hard
 * load: `useAsyncData` registers `onServerPrefetch` regardless of `lazy`, so the
 * server still waits and still ships the rows in the HTML.
 */
const { data, status } = await useApiData<Page<HistoryItem>>(
  'history',
  '/me/history?limit=100',
  { lazy: true },
)
const items = computed(() => data.value?.items ?? [])

useHead({ title: 'History' })
</script>

<template>
  <div class="page-shell space-y-6 pt-24 pb-16">
    <h1 class="text-2xl font-semibold">History</h1>

    <ul v-if="items.length" class="divide-y divide-(--ui-border)">
      <li v-for="item in items" :key="item.video.id" class="py-3 flex items-center gap-4">
        <!--
          Back into playback rather than to the description: a history row is a
          resume surface, and its whole subject is where you got to.
        -->
        <NuxtLink :to="playPath(item.video)" class="grow min-w-0">
          <p class="font-medium truncate">{{ item.video.title }}</p>
          <p class="text-sm text-(--ui-text-muted) truncate">
            {{ collectionTitle(item.video) }}
          </p>
        </NuxtLink>

        <div class="w-40 shrink-0">
          <div class="h-1.5 rounded-full bg-(--ui-bg-elevated) overflow-hidden">
            <div
              class="h-full bg-(--ui-primary)"
              :style="{ width: `${progressPercent(item.progress.lastPositionSec, item.video.durationSec)}%` }"
            />
          </div>
        </div>

        <span class="w-24 shrink-0 text-right text-sm text-(--ui-text-muted) tabular-nums">
          {{ item.progress.completed ? 'Watched' : timecode(item.progress.lastPositionSec) }}
        </span>
      </li>
    </ul>

    <!--
      Ordered after the rows and before the empty state, and tested on
      `status` rather than on `items`.

      After the rows, so a refetch keeps the ones already on screen instead of
      collapsing the list back to placeholders. Before "Nothing watched yet", so
      a page that has not answered yet does not claim an empty history — the
      loading case of the rule the error branches elsewhere exist for.

      `!== 'success'` rather than `=== 'pending'`: the status is `idle` until the
      request actually starts, and `pending` would render nothing at all for
      that first frame.
    -->
    <div v-else-if="status !== 'success'" role="status" aria-label="Loading history">
      <SkeletonList />
    </div>

    <p v-else class="py-20 text-center text-(--ui-text-muted)">Nothing watched yet.</p>
  </div>
</template>
