<script setup lang="ts">
import { trailerYoutubeIdFor, type Page } from '@video/shared'

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
  /** Only the hero reads these; a card renders its thumbnail. */
  thumbnailKey?: string | null
  bannerKey?: string | null
  trailerYoutubeId?: string | null
  collection:
    | {
      id: string
      slug: string
      title: string
      posterKey?: string | null
      bannerKey?: string | null
      trailerYoutubeId?: string | null
    }
    | null
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
  posterKey: string | null
  bannerKey: string | null
  trailerYoutubeId: string | null
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
      // Already started, so this one resumes rather than explaining itself.
      to: playPath(resuming.video) ?? '/browse',
      image: videoHeroImage(resuming.video, resuming.video.collection),
      trailerYoutubeId: trailerYoutubeIdFor(resuming.video, resuming.video.collection),
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
    image: collectionHeroImage(featured),
    trailerYoutubeId: featured.trailerYoutubeId ?? null,
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
      // The collection, not its next episode. The overview carries a Resume
      // button built from the same server-resolved `next`, so getting back in
      // is still one click — via a page that says what you are about to watch.
      to: collectionPath(entry.collection),
      title: entry.collection.title,
      subtitle: entry.next?.video.title ?? (entry.collection.year ? String(entry.collection.year) : null),
      imageUrl: `/api/collections/${entry.collection.id}/poster`,
      width: entry.next?.video.width ?? null,
      height: entry.next?.video.height ?? null,
    }
  }

  const video = entry.video as CardVideo
  return {
    to: overviewPath(video) ?? '/browse',
    title: video.title,
    subtitle: video.collection?.title ?? null,
    imageUrl: `/api/videos/${video.id}/thumbnail`,
    width: video.width ?? null,
    height: video.height ?? null,
  }
}

useHead({ title: 'Home' })
</script>

<template>
  <div>
    <TrailerHero
      v-if="hero"
      :title="hero.title"
      :eyebrow="hero.eyebrow"
      :meta="hero.meta"
      :description="hero.description"
      :image-url="hero.image"
      :trailer-youtube-id="hero.trailerYoutubeId"
    >
      <UButton :to="hero.to" size="lg" icon="i-lucide-play" class="font-semibold">
        {{ hero.resume ? 'Resume' : 'Play' }}
      </UButton>
      <div v-if="hero.resume" class="h-1 w-40 overflow-hidden rounded-full bg-white/20">
        <div class="h-full bg-(--ui-primary)" :style="{ width: `${hero.resume}%` }" />
      </div>
    </TrailerHero>

    <div
      class="page-shell space-y-8 pb-24"
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
          :to="playPath(item.video) ?? '/browse'"
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
        <UIcon name="i-lucide-clapperboard" class="size-12 text-(--ui-text-dimmed)" />
        <h1 class="text-2xl font-semibold">Nothing here yet</h1>
        <p class="text-(--ui-text-muted)">Once there is something to watch, it will show up here.</p>
        <UButton to="/browse" color="neutral" variant="subtle">Browse the library</UButton>
      </div>
    </div>
  </div>
</template>
