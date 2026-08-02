<script setup lang="ts">
/**
 * A collection's title page.
 *
 * The old version was a poster, a paragraph and one flat grid of every video in
 * the show — seasons were fetched and never drawn, so five seasons of a series
 * arrived as an undifferentiated wall of stills with nothing offering to resume
 * it. This is the same data laid out the way people actually pick something:
 * artwork and a Play button first, then episodes as rows you can read.
 */
interface SummaryVideo {
  id: string
  slug: string
  title: string
  description: string | null
  state: string
  durationSec: number | null
  width: number | null
  height: number | null
  orderIndex: number | null
  seasonId: string | null
}

interface SummarySeason {
  id: string
  slug: string
  number: number | null
  title?: string | null
}

const props = defineProps<{
  collection: { id: string, slug: string, title: string, description: string | null, year?: number | null }
  seasons: SummarySeason[]
  /** Every video in the collection, already ordered. */
  videos: SummaryVideo[]
  /** Set when the page is a season rather than the whole collection. */
  season?: SummarySeason | null
  linkTo: (entry: { slug: string, seasonId?: string | null }) => string
}>()

/**
 * This viewer's way through the show: which episode to offer, and how far they
 * got in each. One request rather than two, so the hero's button cannot name
 * one episode while the rows below it disagree about which are watched.
 */
const { data: progress } = await useApiData<{
  next: {
    videoId: string
    slug: string
    title: string
    seasonSlug: string | null
    seasonNumber: number | null
    orderIndex: number | null
    lastPositionSec: number
  } | null
  items: {
    videoId: string
    lastPositionSec: number
    maxPositionSec: number
    completed: boolean
  }[]
}>(
  () => `collection-progress-${props.collection.slug}`,
  () => `/collections/${props.collection.slug}/progress`,
  { watch: [() => props.collection.slug] },
)

const progressByVideo = computed(
  () => new Map((progress.value?.items ?? []).map(item => [item.videoId, item])),
)

/**
 * The hero's button.
 *
 * `next` is the server's answer over the whole collection even on a season
 * page: someone landing on season 3 with season 2 half-finished is still
 * offered season 2, which is what "resume this show" means.
 */
const next = computed(() => progress.value?.next ?? null)

const playTarget = computed(() => (next.value ? playPath({ id: next.value.videoId }) : null))

/**
 * The button says what it does; the line under it says what will play.
 *
 * It deliberately does not read "Play S1 E3". `orderIndex` is not an episode
 * number — the parser puts the number it read off the filename in it, and a
 * drag-reorder rewrites the season 0-based — so that label rendered the first
 * episode of a real show as "E0". Naming the episode is both honest and more
 * use: the title is what someone recognises.
 */
const playLabel = computed(() =>
  next.value && next.value.lastPositionSec > 5 ? 'Resume' : 'Play',
)

const playSubtitle = computed(() => {
  const entry = next.value
  if (!entry) return null
  const season = entry.seasonNumber === null ? null : `Season ${entry.seasonNumber}`
  const at = entry.lastPositionSec > 5 ? `from ${timecode(entry.lastPositionSec)}` : null
  return [season, entry.title, at].filter(Boolean).join(' · ')
})

/**
 * The backdrop.
 *
 * A collection has only a 2:3 poster, and stretching one across a wide hero
 * crops it to nothing. The episode about to be played is a 16:9 still, which is
 * the right shape for the space — the poster then sits over it at its own
 * aspect, the way a title page reads. Falls back to the stretched poster for a
 * collection with nothing in it yet.
 */
const backdrop = computed(() => {
  const first = next.value?.videoId ?? props.videos[0]?.id
  return first ? `/api/videos/${first}/thumbnail` : `/api/collections/${props.collection.id}/poster`
})

/**
 * Which season the list is showing. The URL is the source of truth — the page
 * for a season resolves to that season — so choosing one navigates rather than
 * flipping local state, and the choice survives a reload and a shared link.
 */
const SENTINEL = 'all'
const selectedSeason = computed(() => props.season?.id ?? SENTINEL)

/**
 * `''` is never a value here. Reka UI reserves the empty string for "cleared"
 * and throws during render, which takes down the whole page rather than the
 * select.
 */
const seasonOptions = computed(() => [
  { label: props.seasons.length ? 'All seasons' : 'Everything', value: SENTINEL },
  ...props.seasons.map(entry => ({
    label: entry.title || (entry.number === null ? entry.slug : `Season ${entry.number}`),
    value: entry.id,
  })),
])

function chooseSeason(value: string): void {
  navigateTo(
    value === SENTINEL
      ? `/c/${props.collection.slug}`
      : `/c/${props.collection.slug}/${props.seasons.find(s => s.id === value)?.slug ?? ''}`,
  )
}

const listed = computed(() =>
  props.season ? props.videos.filter(video => video.seasonId === props.season!.id) : props.videos,
)

/**
 * Seasons decide the layout, not a count. A show gets rows you can read; a
 * shelf of films gets the poster grid it always had, because a film's own
 * description belongs on its title page rather than in a list.
 */
const asEpisodes = computed(() => props.seasons.length > 0)

/** A collection holding one film is just that film: the hero is the whole page. */
const showsList = computed(() => listed.value.length > 1 || asEpisodes.value)

const meta = computed(() => {
  const parts: string[] = []
  if (props.collection.year) parts.push(String(props.collection.year))
  if (props.seasons.length) {
    parts.push(props.seasons.length === 1 ? '1 season' : `${props.seasons.length} seasons`)
  }
  else if (props.videos.length) {
    parts.push(props.videos.length === 1 ? '1 video' : `${props.videos.length} videos`)
  }
  return parts.join(' · ')
})

/** Reset on navigation, or one missing poster hides every later one. */
const posterBroken = ref(false)
watch(() => props.collection.id, () => { posterBroken.value = false })

const heading = computed(() => {
  if (!props.season) return props.collection.title
  return props.season.title || (props.season.number === null ? props.season.slug : `Season ${props.season.number}`)
})
</script>

<template>
  <div>
    <HeroBackdrop :image="backdrop" size="tall">
      <div class="rise flex flex-col gap-6 sm:flex-row sm:items-end">
        <!--
          A collection with no poster yet is normal, and the endpoint 404s for
          one. Without the fallback the browser draws its own broken-image
          glyph, which is the most conspicuous thing on the page.
        -->
        <div class="aspect-2/3 w-32 shrink-0 overflow-hidden rounded-lg bg-(--ui-bg-elevated) shadow-2xl ring-1 ring-(--ui-border) sm:w-44">
          <img
            v-if="!posterBroken"
            :src="`/api/collections/${collection.id}/poster`"
            alt=""
            class="size-full object-cover"
            @error="posterBroken = true"
          >
          <div v-else class="grid size-full place-items-center text-(--ui-text-dimmed)">
            <UIcon name="i-lucide-clapperboard" class="size-8" />
          </div>
        </div>

        <div class="max-w-2xl space-y-4">
          <NuxtLink
            v-if="season"
            :to="`/c/${collection.slug}`"
            class="flex w-fit items-center gap-2 text-xs font-semibold tracking-[0.2em] text-(--ui-text-muted) uppercase transition-colors hover:text-(--ui-text)"
          >
            <span aria-hidden="true" class="h-3 w-0.5 rounded-full bg-(--ui-primary)" />
            {{ collection.title }}
          </NuxtLink>

          <h1 class="text-4xl font-bold tracking-tight text-white sm:text-5xl">{{ heading }}</h1>

          <p v-if="meta" class="text-sm text-(--ui-text-muted)">{{ meta }}</p>

          <p v-if="collection.description" class="line-clamp-3 text-(--ui-text-toned)">
            {{ collection.description }}
          </p>

          <div class="space-y-2 pt-2">
            <div class="flex flex-wrap items-center gap-3">
              <UButton
                v-if="playTarget"
                :to="playTarget"
                size="lg"
                icon="i-lucide-play"
                class="font-semibold"
              >
                {{ playLabel }}
              </UButton>
              <AddToListButton :collection-id="collection.id" label />
            </div>
            <p v-if="playTarget && playSubtitle" class="text-sm text-(--ui-text-muted)">
              {{ playSubtitle }}
            </p>
          </div>
        </div>
      </div>
    </HeroBackdrop>

    <div class="page-shell relative z-1 -mt-4 pb-24">
      <template v-if="showsList">
        <div class="mb-4 flex flex-wrap items-center justify-between gap-4">
          <h2 class="text-lg font-semibold tracking-tight text-(--ui-text-highlighted)">
            {{ asEpisodes ? 'Episodes' : 'In this collection' }}
          </h2>
          <USelect
            v-if="seasons.length"
            :model-value="selectedSeason"
            :items="seasonOptions"
            value-key="value"
            color="neutral"
            variant="subtle"
            class="w-48"
            aria-label="Choose a season"
            @update:model-value="chooseSeason"
          />
        </div>

        <!-- A show: rows you can read. -->
        <ul v-if="asEpisodes" class="divide-y divide-(--ui-border)">
          <li v-for="(entry, index) in listed" :key="entry.id">
            <EpisodeRow
              :to="linkTo(entry)"
              :title="entry.title"
              :number="index + 1"
              :image-url="`/api/videos/${entry.id}/thumbnail`"
              :duration-sec="entry.durationSec"
              :description="entry.description"
              :progress="progressPercent(progressByVideo.get(entry.id)?.lastPositionSec ?? null, entry.durationSec)"
              :completed="progressByVideo.get(entry.id)?.completed"
              :badge="entry.state === 'PUBLISHED' ? null : entry.state"
            />
          </li>
        </ul>

        <!-- A shelf of films: the grid it always had. -->
        <div v-else class="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-4">
          <MediaCard
            v-for="entry in listed"
            :key="entry.id"
            class="w-full"
            :to="linkTo(entry)"
            :title="entry.title"
            :subtitle="runtime(entry.durationSec)"
            :image-url="`/api/videos/${entry.id}/thumbnail`"
            :width="entry.width"
            :height="entry.height"
            :progress="progressPercent(progressByVideo.get(entry.id)?.lastPositionSec ?? null, entry.durationSec)"
            :badge="entry.state === 'PUBLISHED' ? null : entry.state"
          />
        </div>
      </template>

      <p v-if="listed.length === 0" class="py-20 text-center text-(--ui-text-muted)">
        Nothing in this collection yet.
      </p>
    </div>
  </div>
</template>
