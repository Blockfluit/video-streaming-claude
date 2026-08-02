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
  /** Every collection this video is in; empty for a standalone one. */
  collections: { collection: { slug: string, title: string } }[]
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
      meta: collectionTitle(resuming.video),
      description: resuming.video.description ?? null,
      to: watchPath(resuming.video),
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
      to: entry.next ? watchPath(entry.next.video) : collectionPath(entry.collection),
      title: entry.collection.title,
      subtitle: entry.next?.video.title ?? (entry.collection.year ? String(entry.collection.year) : null),
      imageUrl: `/api/collections/${entry.collection.id}/poster`,
      width: entry.next?.video.width ?? null,
      height: entry.next?.video.height ?? null,
    }
  }

  const video = entry.video as CardVideo
  return {
    to: watchPath(video),
    title: video.title,
    subtitle: collectionTitle(video),
    imageUrl: `/api/videos/${video.id}/thumbnail`,
    width: video.width ?? null,
    height: video.height ?? null,
  }
}

useHead({ title: 'Home' })
</script>

<template>
  <div>
    <!-- Full-bleed, and it runs under the transparent header on purpose. -->
    <section v-if="hero" class="relative h-[58vh] min-h-100 w-full overflow-hidden">
      <img :src="hero.image" alt="" class="size-full object-cover">
      <!--
        Three scrims, written as real gradients rather than utilities so they
        interpolate to `--ui-bg` itself. The first pass hardcoded #08080a, so
        when the page background moved the fade stopped landing on it and the
        artwork ended on a visible horizontal seam.

        Bottom fade is half the hero rather than a fixed 10rem: on a short
        viewport a fixed height leaves the seam above the fold, which is
        exactly where it is most obvious.
      -->
      <div
        class="absolute inset-0"
        style="background: linear-gradient(to right, var(--ui-bg) 0%, color-mix(in srgb, var(--ui-bg) 78%, transparent) 42%, transparent 72%)"
      />
      <div
        class="absolute inset-x-0 bottom-0 h-1/2"
        style="background: linear-gradient(to top, var(--ui-bg) 0%, color-mix(in srgb, var(--ui-bg) 55%, transparent) 55%, transparent 100%)"
      />

      <div class="absolute inset-0 flex items-center">
        <div class="page-shell">
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
        </div>
      </div>
    </section>

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
          :to="watchPath(item.video)"
          :title="item.video.title"
          :subtitle="collectionTitle(item.video)"
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
