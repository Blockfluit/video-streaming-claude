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
  /** Null means there is none, so the card does not ask for it. */
  thumbnailKey?: string | null
}

interface HistoryItem {
  video: CardVideo
  progress: { lastPositionSec: number }
}

interface SavedItem {
  id: string
  video: CardVideo | null
  collection: { id: string, slug: string, title: string, year: number | null, posterKey?: string | null } | null
  next: { id: string, video: CardVideo } | null
}

interface CuratedRow {
  id: string
  slug: string
  title: string
  items: {
    id: string
    video: CardVideo | null
    collection: { id: string, slug: string, title: string, year: number | null, posterKey?: string | null } | null
  }[]
}

interface FeaturedCollection {
  id: string
  slug: string
  title: string
  description: string | null
  year: number | null
  posterKey: string | null
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
      // Straight into playback. Someone resuming has already decided what they
      // want; a title page in the way is a page they have read.
      to: playPath(resuming.video),
      image: videoThumbnail(resuming.video),
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
    image: collectionPoster(featured),
    resume: 0,
  }
})

const isEmpty = computed(
  () => continueWatching.value.length === 0
    && saved.value.length === 0
    && curated.value.length === 0
    && hero.value === null,
)

/**
 * A saved or curated entry is one of two things, and every card asks the same
 * questions.
 *
 * These open a title page rather than playing. Nobody chose the *moment* here —
 * a saved show is something you meant to get to, not something you were in the
 * middle of — so the page that says what it is comes first. The server-resolved
 * next episode still names itself in the subtitle, and the title page's own
 * hero offers to resume it.
 */
function card(entry: { video: CardVideo | null, collection: SavedItem['collection'], next?: SavedItem['next'] }) {
  if (entry.collection) {
    return {
      to: collectionPath(entry.collection),
      title: entry.collection.title,
      subtitle: entry.next?.video.title ?? (entry.collection.year ? String(entry.collection.year) : null),
      imageUrl: collectionPoster(entry.collection),
      width: entry.next?.video.width ?? null,
      height: entry.next?.video.height ?? null,
    }
  }

  const video = entry.video as CardVideo
  return {
    to: watchPath(video) ?? '/browse',
    title: video.title,
    subtitle: video.collection?.title ?? null,
    imageUrl: videoThumbnail(video),
    width: video.width ?? null,
    height: video.height ?? null,
  }
}

useHead({ title: 'Home' })
</script>

<template>
  <div>
    <HeroBackdrop v-if="hero" :image="hero.image">
      <div class="rise max-w-xl space-y-4">
        <!--
          The eyebrow is set in muted text with a red rule beside it rather
          than in red type. Red on near-black passes WCAG and still reads
          poorly at 12px, which is the whole reason this pass exists.
        -->
        <p class="flex items-center gap-2 text-xs font-semibold tracking-[0.2em] text-(--ui-text-muted) uppercase">
          <span aria-hidden="true" class="h-3 w-0.5 rounded-full bg-(--ui-primary)" />
          {{ hero.eyebrow }}
        </p>
        <h1 class="text-4xl font-bold tracking-tight text-white sm:text-6xl">{{ hero.title }}</h1>
        <p v-if="hero.meta" class="text-sm text-(--ui-text-muted)">{{ hero.meta }}</p>
        <p v-if="hero.description" class="line-clamp-3 text-(--ui-text-muted)">{{ hero.description }}</p>

        <div class="flex items-center gap-3 pt-2">
          <UButton :to="hero.to" size="lg" icon="i-lucide-play" class="font-semibold">
            {{ hero.resume ? 'Resume' : 'Play' }}
          </UButton>
          <div v-if="hero.resume" class="h-1 w-40 overflow-hidden rounded-full bg-white/20">
            <div class="h-full bg-(--ui-primary)" :style="{ width: `${hero.resume}%` }" />
          </div>
        </div>
      </div>
    </HeroBackdrop>

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
          :to="playPath(item.video)"
          action="play"
          :title="item.video.title"
          :subtitle="item.video.collection?.title"
          :image-url="videoThumbnail(item.video)"
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
