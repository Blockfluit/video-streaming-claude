<script setup lang="ts">
/**
 * A collection's title page.
 *
 * The old version was a poster, a paragraph and one flat grid of every video in
 * the show — seasons were fetched and never drawn, so five seasons of a series
 * arrived as an undifferentiated wall of stills with nothing offering to resume
 * it. This is the same data laid out the way people actually pick something:
 * artwork and a Play button first, then episodes as rows you can read.
 *
 * Every row **plays**. Opening a show and picking an episode from it is the
 * decision; putting a page describing that episode in between asks someone to
 * choose twice. The page that describes a video is still there at `/v/:slug`,
 * and it is where browse and My List send you — the surfaces where the question
 * is genuinely still what to watch.
 *
 * Where a video sits — its season and its running order — is a fact about *this*
 * collection and arrives on the membership; the video itself is addressed by
 * nothing but its slug.
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
  /** Null means there is none; absent means this payload does not say. */
  bannerKey?: string | null
}

interface SummarySeason {
  id: string
  slug: string
  number: number | null
  title?: string | null
}

const props = defineProps<{
  collection: {
    id: string
    slug: string
    title: string
    description: string | null
    year?: number | null
    posterKey?: string | null
    trailerYoutubeId?: string | null
    // Imported, and all optional: a collection nobody has matched carries none.
    tagline?: string | null
    genres?: string[]
    certification?: string | null
    imdbId?: string | null
    tmdbRating?: number | null
    seriesStatus?: string | null
    seasonCount?: number | null
  }
  seasons: SummarySeason[]
  /** Every video in the collection, already ordered. */
  videos: SummaryVideo[]
  /** Set when the page is a season rather than the whole collection. */
  season?: SummarySeason | null
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
  /**
   * Whether this collection is already on the caller's list — read from the
   * request this component already makes, for the same reason a video's page
   * reads it off its stats. Without it the button said "add" for a collection
   * that was already saved.
   */
  inMyList: boolean
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

const playTarget = computed(() => (next.value ? playPath({ slug: next.value.slug }) : null))

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
 * The artwork: a 2:3 poster over a 16:9 backdrop.
 *
 * Both are asked of the **collection**, which is a change. This used to reach
 * for the first video's still and fall back to stretching the 2:3 poster across
 * the hero, because a collection only had a poster and nothing generated one.
 * A collection now resolves both shapes server-side — its own if an admin set
 * one, otherwise its first video's — so the client no longer has to guess, and
 * the answer is the same one every other surface gets.
 */
const posterUrl = computed(() => collectionPoster(props.collection))
const backdrop = computed(() => collectionBanner(props.collection))

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

/**
 * Whether the library is missing seasons the show actually has.
 *
 * Only when the two genuinely disagree — "2 of 2 seasons here" is noise, and a
 * count TMDB does not know is not a gap.
 */
const missingSeasons = computed(() => {
  const total = props.collection.seasonCount
  return typeof total === 'number' && total > props.seasons.length && props.seasons.length > 0
})

/** Reset on navigation, or one missing poster hides every later one. */
const posterBroken = ref(false)
watch(() => props.collection.id, () => { posterBroken.value = false })

const { isAdmin } = useSession()

const heading = computed(() => {
  if (!props.season) return props.collection.title
  return props.season.title || (props.season.number === null ? props.season.slug : `Season ${props.season.number}`)
})
</script>

<template>
  <div>
    <HeroBackdrop :image="backdrop" size="tall" :trailer-id="collection.trailerYoutubeId">
      <div class="rise flex flex-col gap-6 sm:flex-row sm:items-end">
        <!--
          Always drawn now, because there is always something to draw.

          This was conditional, and rightly so while a collection's poster was
          upload-only: nothing generated one, so Chernobyl and Avatar both got a
          large empty grey rectangle as the first element of their title page,
          and nothing was better than a box saying nothing. A collection inherits
          its first episode's poster now, and an empty one gets the stock image —
          both of which are pictures, so the space earns itself.

          The `@error` fallback stays for a picture that fails to *load*, which
          the route no longer causes but a network still can.
        -->
        <div
          v-if="posterUrl"
          class="aspect-2/3 w-32 shrink-0 overflow-hidden rounded-lg bg-(--ui-bg-elevated) shadow-2xl ring-1 ring-(--ui-border) sm:w-44"
        >
          <img
            v-if="!posterBroken"
            :src="posterUrl"
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

          <div class="flex items-center gap-3">
            <h1 class="text-4xl font-bold tracking-tight text-white sm:text-5xl">{{ heading }}</h1>
            <ImdbLink :imdb-id="collection.imdbId" :label="collection.title" />
          </div>

          <p v-if="collection.tagline" class="text-balance italic text-(--ui-text-muted)">
            {{ collection.tagline }}
          </p>

          <div class="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-(--ui-text-muted)">
            <span v-if="meta">{{ meta }}</span>
            <UBadge v-if="collection.certification" color="neutral" variant="outline">
              {{ collection.certification }}
            </UBadge>
            <span v-if="collection.tmdbRating" class="inline-flex items-center gap-1">
              <UIcon name="i-lucide-star" class="size-3.5" />
              {{ collection.tmdbRating.toFixed(1) }}
            </span>
            <!--
              What a private library actually wants to know: whether it holds the
              whole show. Shown only when the two disagree, because "2 of 2
              seasons" is noise on a complete one.
            -->
            <span v-if="missingSeasons">
              {{ seasons.length }} of {{ collection.seasonCount }} seasons here
            </span>
            <span v-if="collection.seriesStatus">{{ collection.seriesStatus }}</span>
          </div>

          <p v-if="collection.description" class="line-clamp-3 text-(--ui-text-toned)">
            {{ collection.description }}
          </p>

          <div v-if="collection.genres?.length" class="flex flex-wrap gap-2">
            <UBadge
              v-for="genre in collection.genres"
              :key="genre"
              color="neutral"
              variant="outline"
              :to="`/browse?q=${encodeURIComponent(genre)}`"
            >
              {{ genre }}
            </UBadge>
          </div>

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
              <AddToListButton
                :collection-id="collection.id"
                :saved="progress?.inMyList"
                label
              />
              <!--
                The same shortcut a video's page has. Without it, fixing a
                collection's artwork means walking back through the admin library
                to find the row you are already looking at.
              -->
              <UButton
                v-if="isAdmin"
                :to="`/admin/collections/${collection.slug}`"
                color="neutral"
                variant="subtle"
                icon="i-lucide-pencil"
              >
                Edit
              </UButton>
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

        <!--
          A show: rows you can read, and the one place that shows **banners**
          rather than posters. An episode is a moment from the thing you are
          already watching, so a wide frame of it is more use than a 2:3 poster —
          which is the shape for choosing *between* titles, not within one.
        -->
        <ul v-if="asEpisodes" class="divide-y divide-(--ui-border)">
          <li v-for="(entry, index) in listed" :key="entry.id">
            <EpisodeRow
              :to="playPath(entry)"
              :title="entry.title"
              :number="index + 1"
              :image-url="videoBanner(entry)"
              :duration-sec="entry.durationSec"
              :description="entry.description"
              :progress="progressPercent(progressByVideo.get(entry.id)?.lastPositionSec ?? null, entry.durationSec)"
              :completed="progressByVideo.get(entry.id)?.completed"
              :badge="entry.state === 'PUBLISHED' ? null : entry.state"
            />
          </li>
        </ul>

        <!--
          A shelf of films, so posters — literally the same grid browse draws,
          which is why it is one class in `main.css` rather than three copies of
          an arbitrary value. Narrower columns than the 16:9 grid this replaced,
          because a 2:3 tile is taller and four across is a wall of them
          otherwise.

          The page around it keeps the ordinary shell: this one has a synopsis
          and a credits panel on it, and prose does not want a 4K measure.
        -->
        <div v-else class="poster-grid">
          <MediaCard
            v-for="entry in listed"
            :key="entry.id"
            class="w-full"
            :to="playPath(entry)"
            :title="entry.title"
            :subtitle="runtime(entry.durationSec)"
            :image-url="videoPoster(entry)"
            :width="entry.width"
            :height="entry.height"
            :progress="progressPercent(progressByVideo.get(entry.id)?.lastPositionSec ?? null, entry.durationSec)"
            :badge="entry.state === 'PUBLISHED' ? null : entry.state"
          />
        </div>
      </template>

      <!--
        A season with nothing in it is a different statement from a collection
        with nothing in it, and the collection is demonstrably not empty if you
        are reading this on one of its season pages. It happens for real: every
        episode can sit directly in the collection while the season folders
        still exist, and then the season filter correctly finds none.
      -->
      <p v-if="listed.length === 0" class="py-20 text-center text-(--ui-text-muted)">
        <template v-if="season">
          Nothing in this season.
          <NuxtLink :to="`/c/${collection.slug}`" class="text-(--ui-text) underline underline-offset-4">
            See everything in {{ collection.title }}
          </NuxtLink>.
        </template>
        <template v-else>Nothing in this collection yet.</template>
      </p>
    </div>
  </div>
</template>
