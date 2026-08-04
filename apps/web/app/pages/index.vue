<script setup lang="ts">
import type { Page } from '@video/shared'

/**
 * The home page: a hero, then whatever rows an admin has configured, in order.
 *
 * Continue Watching and My List used to be hardcoded above the curated rows,
 * which meant the two shelves every viewer sees first were the two an admin
 * could not move, rename or hide. They are rows now like everything else — the
 * API resolves each one from its source and this page renders what comes back,
 * so there is one shelf-shaped thing here rather than three.
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
  /** Null means there is none, so the card does not ask for it. */
  bannerKey?: string | null
}

interface CardCollection {
  id: string
  slug: string
  title: string
  year: number | null
  posterKey?: string | null
}

/**
 * One entry on a shelf. `progress` and `next` arrive only from the rows that
 * have them — Continue Watching and My List — and every other row simply leaves
 * them out, which is what lets one card renderer serve all of them.
 */
interface RowItem {
  id: string
  video: CardVideo | null
  collection: CardCollection | null
  next?: { id: string, video: CardVideo } | null
  progress?: { lastPositionSec: number } | null
}

interface HomeRow {
  id: string
  slug: string
  title: string
  source: string
  items: RowItem[]
}

interface FeaturedCollection extends CardCollection {
  description: string | null
}

const [{ data: rows }, { data: collections }] = await Promise.all([
  useApiData<Page<HomeRow>>('home-rows', '/lists?limit=20'),
  useApiData<Page<FeaturedCollection>>('home-featured', '/collections?limit=1'),
])

/**
 * A row that resolves to nothing is not rendered.
 *
 * This matters more than it did: a computed row over an empty library, and a
 * personal row for someone who has watched nothing, are both ordinary states on
 * a new account. An empty shelf under a heading is worse than no shelf.
 */
const shelves = computed(() => (rows.value?.items ?? []).filter(row => row.items.length > 0))

/**
 * The hero prefers something already started — the most likely thing you came
 * back for — and falls back to the first collection in the library.
 *
 * It reads the Continue Watching row rather than fetching history again, so
 * hiding that row also stops the hero leading with a resume. That is the
 * coherent reading of hiding it, not a side effect.
 */
const hero = computed(() => {
  const resuming = shelves.value.find(row => row.source === 'CONTINUE_WATCHING')?.items[0]
  if (resuming?.video) {
    return {
      eyebrow: 'Continue watching',
      title: resuming.video.title,
      meta: collectionTitle(resuming.video),
      description: resuming.video.description ?? null,
      // Straight into playback. Someone resuming has already decided what
      // they want; a page describing it is a page they have read.
      to: playPath(resuming.video),
      image: videoBanner(resuming.video),
      resume: progressPercent(resuming.progress?.lastPositionSec ?? 0, resuming.video.durationSec),
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
    image: collectionBanner(featured),
    resume: 0,
  }
})

const isEmpty = computed(() => shelves.value.length === 0 && hero.value === null)

/** Where a shelf's "see all" arrow goes, for the two rows that have a page of their own. */
const rowLink = (source: string): string | undefined =>
  source === 'CONTINUE_WATCHING' ? '/history' : source === 'MY_LIST' ? '/my-list' : undefined

/** An entry is a collection or a video, and every card asks the same questions. */
function card(entry: RowItem) {
  if (entry.collection) {
    return {
      to: collectionPath(entry.collection),
      title: entry.collection.title,
      // A saved show names the episode it would play next, resolved
      // server-side against this viewer's progress.
      subtitle: entry.next?.video.title ?? (entry.collection.year ? String(entry.collection.year) : null),
      imageUrl: collectionPoster(entry.collection),
      width: entry.next?.video.width ?? null,
      height: entry.next?.video.height ?? null,
      progress: 0,
    }
  }

  const video = entry.video as CardVideo
  return {
    // Something already started goes straight back into playback; anything
    // else lands on the page that describes it first.
    to: entry.progress ? playPath(video) : videoPath(video),
    title: video.title,
    subtitle: collectionTitle(video),
    imageUrl: videoPoster(video),
    width: video.width ?? null,
    height: video.height ?? null,
    progress: progressPercent(entry.progress?.lastPositionSec ?? 0, video.durationSec),
  }
}

useHead({ title: 'Home' })
</script>

<template>
  <div>
    <!--
      The same backdrop the video and collection pages use. It was extracted so
      the three cannot drift apart on the scrim: the gradients interpolate to
      `--ui-bg` itself rather than a hex, and the last time this was copied the
      page background moved out from under it and the artwork ended on a visible
      horizontal seam.
    -->
    <HeroBackdrop v-if="hero" :image="hero.image">
      <div class="rise max-w-xl space-y-4">
        <!--
          The eyebrow is set in muted text with a red rule beside it rather than
          in red type. Red on near-black passes WCAG and still reads poorly at
          12px, which is the whole reason this pass exists.
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
        v-for="(row, index) in shelves"
        :key="row.id"
        :title="row.title"
        :empty="row.items.length === 0"
        :to="rowLink(row.source)"
        class="rise"
        :style="`animation-delay: ${index * 80}ms`"
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
