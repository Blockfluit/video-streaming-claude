<script setup lang="ts">
import type { Page } from '@video/shared'

/**
 * The home page: a hero, then Continue Watching, My List, and whatever rows an
 * admin has curated.
 *
 * The three shelves are deliberately different things. Continue Watching is
 * derived from watch progress and nobody chose it; My List is explicit and
 * personal; curated rows are the same for everyone. All are fetched in
 * parallel — one slow row must not hold up the others.
 */
interface CardVideo {
  id: string
  slug: string
  title: string
  description?: string | null
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

interface FeaturedCollection {
  id: string
  slug: string
  title: string
  description: string | null
  year: number | null
}

const [{ data: history }, { data: watchlist }, { data: rows }, { data: collections }] = await Promise.all([
  useApiData<Page<HistoryItem>>('home-continue', '/me/history?completed=false&limit=20'),
  useApiData<Page<SavedItem>>('home-watchlist', '/me/watchlist?limit=20'),
  useApiData<Page<CuratedRow>>('home-rows', '/lists?limit=10'),
  useApiData<Page<FeaturedCollection>>('home-featured', '/collections?limit=1'),
])

const continueWatching = computed(() => history.value?.items ?? [])
const saved = computed(() => watchlist.value?.items ?? [])
// A row whose every entry is a draft comes back empty for a viewer; an empty
// shelf with a heading is worse than no shelf.
const curated = computed(() => (rows.value?.items ?? []).filter(row => row.items.length > 0))

/**
 * The hero prefers something already started — the most likely thing you came
 * back for — and falls back to the first collection in the library.
 */
const hero = computed(() => {
  const resuming = continueWatching.value[0]
  if (resuming) {
    return {
      eyebrow: 'Continue watching',
      title: resuming.video.title,
      meta: resuming.video.collection?.title ?? null,
      description: resuming.video.description ?? null,
      to: watchPath(resuming.video) ?? '/browse',
      image: `/api/videos/${resuming.video.id}/thumbnail`,
      resume: progressPercent(resuming.progress.lastPositionSec, resuming.video.durationSec),
    }
  }

  const featured = collections.value?.items?.[0]
  if (!featured) return null

  return {
    eyebrow: 'Featured',
    title: featured.title,
    meta: featured.year ? String(featured.year) : null,
    description: featured.description,
    to: collectionPath(featured),
    image: `/api/collections/${featured.id}/poster`,
    resume: 0,
  }
})

const isEmpty = computed(
  () => continueWatching.value.length === 0
    && saved.value.length === 0
    && curated.value.length === 0
    && hero.value === null,
)

/** A saved or curated entry is one of two things, and every card asks the same questions. */
function card(entry: { video: CardVideo | null, collection: SavedItem['collection'], next?: SavedItem['next'] }) {
  if (entry.collection) {
    return {
      // A saved show points at the episode it would play next, resolved
      // server-side against this viewer's progress.
      to: (entry.next ? watchPath(entry.next.video) : null) ?? collectionPath(entry.collection),
      title: entry.collection.title,
      subtitle: entry.next?.video.title ?? (entry.collection.year ? String(entry.collection.year) : null),
      imageUrl: `/api/collections/${entry.collection.id}/poster`,
      width: entry.next?.video.width ?? null,
      height: entry.next?.video.height ?? null,
    }
  }

  const video = entry.video as CardVideo
  return {
    to: watchPath(video) ?? '/browse',
    title: video.title,
    subtitle: video.collection?.title ?? null,
    imageUrl: `/api/videos/${video.id}/thumbnail`,
    width: video.width ?? null,
    height: video.height ?? null,
  }
}
</script>

<template>
  <div>
    <!-- Full-bleed, and it runs under the transparent header on purpose. -->
    <section v-if="hero" class="relative h-[58vh] min-h-100 w-full overflow-hidden">
      <img :src="hero.image" alt="" class="size-full object-cover">
      <!-- Two gradients: one to lift the text off the art, one to hand the
           page over to the first shelf without a visible seam. -->
      <div class="absolute inset-0 bg-gradient-to-r from-[#08080a] via-[#08080a]/70 to-transparent" />
      <div class="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-[#08080a] to-transparent" />

      <div class="absolute inset-0 flex items-center">
        <div class="mx-auto w-full max-w-[110rem] px-4 sm:px-8">
          <div class="rise max-w-xl space-y-4">
            <p class="text-xs font-semibold tracking-[0.2em] text-(--ui-primary) uppercase">
              {{ hero.eyebrow }}
            </p>
            <h1 class="text-4xl font-bold tracking-tight text-white sm:text-6xl">{{ hero.title }}</h1>
            <p v-if="hero.meta" class="text-sm text-white/70">{{ hero.meta }}</p>
            <p v-if="hero.description" class="line-clamp-3 text-white/70">{{ hero.description }}</p>

            <div class="flex items-center gap-3 pt-2">
              <UButton :to="hero.to" size="lg" icon="i-lucide-play" class="font-semibold">
                {{ hero.resume ? 'Resume' : 'Play' }}
              </UButton>
              <div v-if="hero.resume" class="h-1 w-40 overflow-hidden rounded-full bg-white/20">
                <div class="h-full bg-(--ui-primary)" :style="{ width: `${hero.resume}%` }" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <div
      class="mx-auto max-w-[110rem] space-y-8 px-4 pb-24 sm:px-8"
      :class="hero ? 'relative z-1 -mt-16' : 'pt-24'"
    >
      <MediaRow
        title="Continue watching"
        :empty="continueWatching.length === 0"
        to="/history"
        class="rise"
      >
        <MediaCard
          v-for="item in continueWatching"
          :key="item.video.id"
          class="w-56 sm:w-64"
          :to="watchPath(item.video) ?? '/browse'"
          :title="item.video.title"
          :subtitle="item.video.collection?.title"
          :image-url="`/api/videos/${item.video.id}/thumbnail`"
          :width="item.video.width"
          :height="item.video.height"
          :progress="progressPercent(item.progress.lastPositionSec, item.video.durationSec)"
        />
      </MediaRow>

      <MediaRow
        title="My list"
        :empty="saved.length === 0"
        to="/my-list"
        class="rise"
        style="animation-delay: 80ms"
      >
        <MediaCard v-for="item in saved" :key="item.id" class="w-56 sm:w-64" v-bind="card(item)" />
      </MediaRow>

      <MediaRow
        v-for="(row, index) in curated"
        :key="row.id"
        :title="row.title"
        :empty="row.items.length === 0"
        class="rise"
        :style="`animation-delay: ${160 + index * 80}ms`"
      >
        <MediaCard v-for="item in row.items" :key="item.id" class="w-56 sm:w-64" v-bind="card(item)" />
      </MediaRow>
    </div>

    <!-- A new library is empty, and that is a state worth designing for. -->
    <div v-if="isEmpty" class="grid min-h-screen place-items-center px-6 text-center">
      <div class="space-y-4">
        <UIcon name="i-lucide-clapperboard" class="size-12 text-white/40" />
        <h1 class="text-2xl font-semibold">Nothing here yet</h1>
        <p class="text-white/65">Once there is something to watch, it will show up here.</p>
        <UButton to="/browse" variant="subtle">Browse the library</UButton>
      </div>
    </div>
  </div>
</template>
