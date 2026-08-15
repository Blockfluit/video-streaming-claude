<script setup lang="ts">
/**
 * The rest of the collection, beside the player.
 *
 * A show is watched in order and the next thing is the most likely next click,
 * so it belongs on the screen the video is on rather than a page back. The
 * stepper's Previous and Next answer "what is adjacent"; this answers "what is
 * there", which is the question somebody has when they want the one they
 * skipped or the one they half-remember from three weeks ago.
 *
 * It is fed the already-ordered sequence rather than a raw payload. The running
 * order is decided once, in `episodeSequence`, and shared with the stepper — two
 * controls on one page disagreeing about what follows episode three is a bug
 * that renders perfectly.
 *
 * Every link carries the collection on (`playPath(entry, from)`). Without it the
 * first click out of the rail is the last one: the rail and the stepper both
 * vanish from the page they land on, which reads as the app breaking rather
 * than as a missing query parameter.
 */
import type { SeasonGroup, SequenceVideo } from '~/utils/episode-sequence'

/** What the rail draws, on top of what ordering needed. */
interface RailVideo extends SequenceVideo {
  slug: string
  durationSec: number | null
  state: string
}

const props = defineProps<{
  groups: SeasonGroup<RailVideo>[]
  collection: { slug: string, title: string }
  currentVideoId: string
  /** The slug that travels on every link, so one click does not end the rail. */
  from: string
  /** Keyed by video id, from `GET /collections/:slug/progress`. */
  progress?: Map<string, { lastPositionSec: number, completed: boolean }>
}>()

/**
 * A season's heading.
 *
 * `title` first because a show that names its seasons ("Book One") has said
 * something the number cannot. A season whose number did not parse falls back to
 * the slug rather than to "Season null", and a group with no season at all gets
 * nothing — it is the loose remainder, and "Season none" is worse than silence.
 */
function label(season: SeasonGroup<RailVideo>['season']): string | null {
  if (!season) return null
  return season.number === null ? 'Other episodes' : `Season ${season.number}`
}

/**
 * The number beside a row is its **position in the whole sequence**, 1-based,
 * not `orderIndex`.
 *
 * `orderIndex` looks like an episode number and is not one: the path parser
 * stores what it read off the filename while an admin drag rewrites the season
 * 0-based, which is how a first episode comes to be labelled "E0". Counting
 * across the flattened sequence rather than within each group also means the
 * rail agrees with the stepper about which episode is which.
 */
const positions = computed(() => {
  const byId = new Map<string, number>()
  let position = 0

  for (const group of props.groups) {
    for (const video of group.videos) byId.set(video.id, ++position)
  }

  return byId
})

const total = computed(() => positions.value.size)

/**
 * Scroll the episode being watched into view, once, on the client.
 *
 * A rail that opens at season one while somebody is on S3E5 has shown them the
 * least useful part of the list, and the row telling them where they are is the
 * one off screen. `nearest` rather than `center`, so a rail already showing the
 * row does not jerk under a reader who has just scrolled it there themselves.
 *
 * Not a `watch`: on a step to the next episode the browser keeps the rail's
 * scroll position, the highlight moves one row, and yanking the list would undo
 * a deliberate scroll for a move of a single row.
 */
/*
 * A function ref rather than a named one. A `ref="current"` inside a `v-for`
 * collects into an array whatever the name, so the single element that matters
 * would arrive wrapped — and a conditional name is worse still, since Vue keeps
 * registering the ref for rows that no longer match.
 */
const current = ref<HTMLElement | null>(null)

onMounted(() => {
  current.value?.scrollIntoView({ block: 'nearest' })
})
</script>

<template>
  <aside
    class="min-w-0"
    :aria-label="`More from ${collection.title}`"
  >
    <div class="mb-3 flex items-baseline justify-between gap-3">
      <!--
        The heading is the way out to the collection's own page, which is where
        the synopsis and the season picker are. Its text names the show rather
        than saying "Episodes", so the link says where it goes.
      -->
      <NuxtLink
        :to="collectionPath(collection)"
        class="truncate text-sm font-semibold tracking-wide text-(--ui-text) uppercase transition-colors hover:text-white"
      >
        {{ collection.title }}
      </NuxtLink>
      <span class="shrink-0 text-xs text-(--ui-text-muted) tabular-nums">
        {{ total }}
      </span>
    </div>

    <!--
      The list scrolls inside itself rather than growing the page. A ten-season
      show is several thousand pixels of rail, and a page that long puts the
      comments below the fold of a list nobody asked to read all of.

      The height is capped against the viewport so the rail ends where the
      window does, whatever the screen. Below `lg` it is stacked rather than
      beside the player and takes a plain, shorter cap — a rail as tall as the
      phone would push the comments off the bottom of a scroll people do reach.
    -->
    <div class="max-h-[28rem] overflow-y-auto rounded-lg lg:max-h-[calc(100dvh-16rem)]">
      <div v-for="(group, index) in groups" :key="group.season?.id ?? `loose-${index}`">
        <!--
          Sticky, because the heading answering "which season am I looking at"
          is the one that scrolls away first in a long list.
        -->
        <h3
          v-if="label(group.season)"
          class="sticky top-0 z-10 bg-(--ui-bg) px-2 py-2 text-xs font-semibold tracking-wide text-(--ui-text-muted) uppercase"
        >
          {{ label(group.season) }}
        </h3>

        <ul>
          <li
            v-for="entry in group.videos"
            :key="entry.id"
            :ref="el => { if (entry.id === currentVideoId) current = el as HTMLElement | null }"
          >
            <EpisodeRow
              dense
              :to="playPath(entry, from)"
              :title="entry.title"
              :number="positions.get(entry.id)"
              :image-url="videoBanner(entry)"
              :duration-sec="entry.durationSec"
              :progress="progressPercent(progress?.get(entry.id)?.lastPositionSec ?? null, entry.durationSec)"
              :completed="progress?.get(entry.id)?.completed"
              :badge="entry.state === 'PUBLISHED' ? null : entry.state"
              :current="entry.id === currentVideoId"
            />
          </li>
        </ul>
      </div>
    </div>
  </aside>
</template>
