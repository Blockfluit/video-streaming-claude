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
    collection: { slug: string, title: string } | null
    season: { slug: string } | null
  }
  progress: {
    lastPositionSec: number
    secondsWatched: number
    completed: boolean
    lastWatchedAt: string
  }
}

const { data } = await useApiData<Page<HistoryItem>>('history', '/me/history?limit=100')
const items = computed(() => data.value?.items ?? [])

useHead({ title: 'History' })
</script>

<template>
  <div class="page-shell space-y-6 pt-24 pb-16">
    <h1 class="text-2xl font-semibold">History</h1>

    <ul v-if="items.length" class="divide-y divide-(--ui-border)">
      <li v-for="item in items" :key="item.video.id" class="py-3 flex items-center gap-4">
        <NuxtLink :to="watchPath(item.video) ?? '/browse'" class="grow min-w-0">
          <p class="font-medium truncate">{{ item.video.title }}</p>
          <p class="text-sm text-(--ui-text-muted) truncate">
            {{ item.video.collection?.title }}
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

    <p v-else class="py-20 text-center text-(--ui-text-muted)">Nothing watched yet.</p>
  </div>
</template>
