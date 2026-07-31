<script setup lang="ts">
import type { Page } from '@video/shared'

/**
 * The home page: Continue Watching, then My List, then whatever rows an admin
 * has curated.
 *
 * The three are deliberately different things. Continue Watching is derived
 * from watch progress and nobody chose it; My List is explicit and personal;
 * curated rows are the same for everyone. All three are fetched in parallel —
 * one slow row must not hold up the other two.
 */
interface CardVideo {
  id: string
  slug: string
  title: string
  durationSec: number | null
  width?: number | null
  height?: number | null
  collection: { slug: string, title: string } | null
  season: { slug: string } | null
}

interface HistoryItem {
  video: CardVideo
  progress: { lastPositionSec: number }
}

interface SavedItem {
  id: string
  video: CardVideo | null
  collection: { id: string, slug: string, title: string, year: number | null } | null
  next: { id: string, video: CardVideo } | null
}

interface CuratedRow {
  id: string
  slug: string
  title: string
  items: {
    id: string
    video: CardVideo | null
    collection: { id: string, slug: string, title: string, year: number | null } | null
  }[]
}

const [{ data: history }, { data: watchlist }, { data: rows }] = await Promise.all([
  useApiData<Page<HistoryItem>>('home-continue', '/me/history?completed=false&limit=20'),
  useApiData<Page<SavedItem>>('home-watchlist', '/me/watchlist?limit=20'),
  useApiData<Page<CuratedRow>>('home-rows', '/lists?limit=10'),
])

const continueWatching = computed(() => history.value?.items ?? [])
const saved = computed(() => watchlist.value?.items ?? [])
// A row whose every entry is a draft comes back empty for a viewer; an empty
// shelf with a heading is worse than no shelf.
const curated = computed(() => (rows.value?.items ?? []).filter(row => row.items.length > 0))

const isEmpty = computed(
  () => continueWatching.value.length === 0
    && saved.value.length === 0
    && curated.value.length === 0,
)

/** A saved or curated entry is one of two things, and every card asks the same four questions. */
function card(entry: { video: CardVideo | null, collection: SavedItem['collection'], next?: SavedItem['next'] }) {
  if (entry.collection) {
    return {
      // A saved collection points at the episode it would play next, resolved
      // server-side against this viewer's progress.
      to: (entry.next ? watchPath(entry.next.video) : null) ?? collectionPath(entry.collection),
      title: entry.collection.title,
      subtitle: entry.next?.video.title ?? (entry.collection.year ? String(entry.collection.year) : null),
      imageUrl: `/api/collections/${entry.collection.id}/poster`,
      video: entry.next?.video ?? null,
    }
  }

  const video = entry.video as CardVideo
  return {
    to: watchPath(video) ?? '/browse',
    title: video.title,
    subtitle: video.collection?.title ?? null,
    imageUrl: `/api/videos/${video.id}/thumbnail`,
    video,
  }
}
</script>

<template>
  <UContainer class="py-8 space-y-10">
    <MediaRow title="Continue watching" :empty="continueWatching.length === 0" to="/history">
      <MediaCard
        v-for="item in continueWatching"
        :key="item.video.id"
        :to="watchPath(item.video) ?? '/browse'"
        :title="item.video.title"
        :subtitle="item.video.collection?.title"
        :image-url="`/api/videos/${item.video.id}/thumbnail`"
        :progress="progressPercent(item.progress.lastPositionSec, item.video.durationSec)"
      />
    </MediaRow>

    <MediaRow title="My list" :empty="saved.length === 0" to="/my-list">
      <MediaCard
        v-for="item in saved"
        :key="item.id"
        v-bind="card(item)"
      />
    </MediaRow>

    <MediaRow
      v-for="row in curated"
      :key="row.id"
      :title="row.title"
      :empty="row.items.length === 0"
    >
      <MediaCard
        v-for="item in row.items"
        :key="item.id"
        v-bind="card(item)"
        :width="card(item).video?.width"
        :height="card(item).video?.height"
      />
    </MediaRow>

    <!-- A new library is empty, and that is a state worth designing for. -->
    <div v-if="isEmpty" class="py-20 text-center space-y-3">
      <UIcon name="i-lucide-film" class="size-10 text-(--ui-text-dimmed)" />
      <h1 class="text-xl font-semibold">Nothing here yet</h1>
      <p class="text-(--ui-text-muted)">
        Once there is something to watch, it will show up here.
      </p>
      <UButton to="/browse" variant="subtle">Browse the library</UButton>
    </div>
  </UContainer>
</template>
