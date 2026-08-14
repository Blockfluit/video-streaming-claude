<script setup lang="ts">
import type { LibraryCard, Page } from '@video/shared'

/**
 * The home page: a hero, then whatever rows an admin has configured, in order.
 *
 * Continue Watching and My List used to be hardcoded above the curated rows,
 * which meant the two shelves every viewer sees first were the two an admin
 * could not move, rename or hide. They are rows now like everything else — the
 * API resolves each one from its source and this page renders what comes back,
 * so there is one shelf-shaped thing here rather than three.
 *
 * The hero leads with what was **recently added** and rotates through the
 * newest few, playing each one's trailer. It used to lead with whatever the
 * viewer had last been watching, which made the largest thing on the page
 * always something they had already seen — a new arrival was a card in a shelf
 * below the fold. `app/utils/hero.ts` decides *what* it shows; this file is the
 * rotation around it.
 */
interface CardVideo {
  id: string
  slug: string
  title: string
  durationSec: number | null
  width?: number | null
  height?: number | null
  /** Every collection this video is in; empty for a standalone one. */
  collections: { collection: { slug: string, title: string } }[]
  /** Null means there is none, so the card does not ask for it. */
  bannerKey?: string | null
  /** The hero plays it. Null is the ordinary state of most of a library. */
  trailerYoutubeId?: string | null
}

interface CardCollection {
  id: string
  slug: string
  title: string
  year: number | null
  posterKey?: string | null
  /** What it holds, which is what its chip says. Never TMDB's `seasonCount`. */
  seasonsHere?: number | null
  videosHere?: number | null
  trailerYoutubeId?: string | null
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

/**
 * Both errors are kept.
 *
 * Every shelf here hides itself when it resolves to nothing, so a failed fetch
 * and an empty library render identically — right down to "Nothing here yet",
 * which tells a viewer the library is empty when in fact the server is down.
 * One is a state worth designing for; the other is worth reporting.
 *
 * The second request is the hero's fallback, and it replaced a
 * `/collections?limit=1` "Featured" one — so the page still makes two. Its key
 * is named for the URL it now asks for: `useApiData` resolves a key once at
 * setup and never derives it from the path, so a key left saying "featured"
 * over a `/library` request is a payload key that lies for good.
 */
const [{ data: rows, error: rowsError }, { data: newest, error: newestError }]
  = await Promise.all([
    useApiData<Page<HomeRow>>('home-rows', '/lists?limit=20'),
    useApiData<Page<LibraryCard>>('home-newest', `/library?sort=added&limit=${HERO_LIMIT}`),
  ])

const failed = computed(() => rowsError.value ?? newestError.value ?? null)

/**
 * A row that resolves to nothing is not rendered.
 *
 * This matters more than it did: a computed row over an empty library, and a
 * personal row for someone who has watched nothing, are both ordinary states on
 * a new account. An empty shelf under a heading is worse than no shelf.
 */
const shelves = computed(() => (rows.value?.items ?? []).filter(row => row.items.length > 0))

/**
 * What the hero can feature, newest first.
 *
 * `shelves` rather than the raw rows on purpose — a `RECENTLY_ADDED` row that
 * resolved to nothing must not shadow the library fallback, or a brand-new row
 * over an empty filter renders an empty hero on a library full of things.
 *
 * `?limit=20` on the rows request bounds this: a `RECENTLY_ADDED` row sitting
 * at position 21 is not in the payload, and the hero takes the fallback. That
 * has always been true of Continue Watching and is not worth a second request.
 */
const entries = computed(() => heroEntries(shelves.value, newest.value?.items ?? []))

/**
 * Which one is showing.
 *
 * Starts at 0 deterministically. Anything derived from a clock or a random
 * number renders one entry on the server and a different one in the browser,
 * and a hydration mismatch is a warning rather than an error — so it would
 * simply be wrong, quietly, forever.
 */
const active = ref(0)

/**
 * Read through the modulo rather than trusting the index.
 *
 * `entries` can shrink under a refetch, which would otherwise leave `active`
 * past the end and the hero blank while `v-if` still passed.
 */
const hero = computed(() =>
  entries.value.length === 0 ? null : entries.value[active.value % entries.value.length] ?? null,
)

/**
 * How long each entry holds the hero.
 *
 * `HeroBackdrop` waits two seconds before its trailer fades in, so this is
 * roughly two seconds of banner and eight of trailer. Much shorter and the
 * entry changes before its trailer has said anything, while opening a YouTube
 * iframe every few seconds. Advancing when a trailer actually *ends* would need
 * the YouTube JS API — `enablejsapi` is set and nothing listens — so a fixed
 * interval is the honest version of "then play the next in line".
 */
const ROTATE_MS = 10_000

/**
 * Rotation stops for the three things that should stop it.
 *
 * `paused` covers a pointer resting on the hero, keyboard focus inside it, and
 * the explicit control — auto-updating content needs a way to stop it, and
 * "wait, what was that" is the commonest reason to want one. `dismissed` is
 * separate and permanent for the visit: somebody who closed the trailer is not
 * asking to be shown the next one ten seconds later.
 */
const paused = ref(false)
const hovering = ref(false)
const dismissed = ref(false)

const rotating = computed(() =>
  entries.value.length > 1 && !paused.value && !hovering.value && !dismissed.value,
)

let timer: ReturnType<typeof setInterval> | undefined

function advance(): void {
  if (!rotating.value) return
  active.value = (active.value + 1) % entries.value.length
}

/**
 * Started in `onMounted`, so it never runs during SSR: an interval created in
 * `setup` runs in Nitro on every render, is never cleared, and mutates state
 * between rendering the markup and serialising the payload.
 *
 * Not under `prefers-reduced-motion` either. A hero that begins moving on its
 * own is precisely what that setting is about, and it is the same rule the
 * trailer already follows — the dots still work, and so does the pause button.
 */
onMounted(() => {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  timer = setInterval(advance, ROTATE_MS)
})

onBeforeUnmount(() => clearInterval(timer))

/** Picking one by hand is a decision, so it stops the carousel moving under you. */
function show(index: number): void {
  active.value = index
  paused.value = true
}

const isEmpty = computed(() => shelves.value.length === 0 && entries.value.length === 0)

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
      // A shelf you open, not a video you play. Films pass nothing.
      kind: collectionChip(entry.collection),
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
    kind: null,
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
    <!--
      Rotation pauses while a pointer rests on the hero or focus is inside it.
      Reading the thing it is describing is the commonest reason to want it to
      hold still, and `focus-within` is the same courtesy for a keyboard.
    -->
    <HeroBackdrop
      v-if="hero"
      :image="hero.image"
      :trailer-id="hero.trailerId"
      @dismiss="dismissed = true"
      @pointerenter="hovering = true"
      @pointerleave="hovering = false"
      @focusin="hovering = true"
      @focusout="hovering = false"
    >
      <!--
        Keyed on the entry, so the text animates in on each turn rather than
        mutating in place. The backdrop itself is deliberately *not* keyed: it
        crossfades its own artwork, and remounting it would restart the trailer
        and flash the banner.
      -->
      <div :key="hero.id" class="rise max-w-xl space-y-4">
        <!--
          The eyebrow is set in muted text with a red rule beside it rather than
          in red type. Red on near-black passes WCAG and still reads poorly at
          12px, which is the whole reason this pass exists.
        -->
        <p class="flex items-center gap-2 text-xs font-semibold tracking-[0.2em] text-(--ui-text-muted) uppercase">
          <span aria-hidden="true" class="h-3 w-0.5 rounded-full bg-(--ui-primary)" />
          Recently added
        </p>
        <h1 class="text-4xl font-bold tracking-tight text-white sm:text-6xl">{{ hero.title }}</h1>
        <p v-if="hero.meta" class="text-sm text-(--ui-text-muted)">{{ hero.meta }}</p>

        <div class="flex items-center gap-3 pt-2">
          <!--
            It describes rather than plays. Something newly arrived is something
            the viewer is still deciding about — the same rule browse, My List
            and the curated rows follow — and a collection has nothing single to
            play in any case.
          -->
          <UButton :to="hero.to" size="lg" icon="i-lucide-info" class="font-semibold">
            More info
          </UButton>
        </div>
      </div>

      <!--
        The rotation's controls, in the hero's own column rather than on the
        floor of it.

        They sat bottom-left to begin with and collided with the first shelf:
        the page below is pulled up over the hero by `-mt-16` so the artwork
        runs behind the cards, which puts the bottom 4rem of the hero underneath
        a row heading — "Recently added" landed exactly on top of the pause
        button. Anything the hero owns has to live above that band, and the text
        column is the one place guaranteed to be clear of it at every width.

        Not keyed on `hero.id` like the text above: re-running the fade on every
        turn would blink the control you just pressed.

        Real buttons with real labels — `visible.spec.ts` fails a control that is
        focusable and invisible, and a bare row of divs would be neither
        reachable nor announced. An inactive dot is dimmed with a *colour*, never
        with `opacity`: the audit reports an interactive element under 0.35
        effective opacity, and opacity multiplies down the whole ancestor chain.
      -->
      <div v-if="entries.length > 1" class="mt-6 flex items-center gap-3">
        <UButton
          size="sm"
          color="neutral"
          variant="subtle"
          :icon="rotating ? 'i-lucide-pause' : 'i-lucide-play'"
          :aria-label="rotating ? 'Pause the rotation' : 'Resume the rotation'"
          @click="paused = !paused"
        />
        <div class="flex items-center gap-2">
          <button
            v-for="(entry, index) in entries"
            :key="entry.id"
            type="button"
            class="size-2.5 rounded-full transition-colors"
            :class="index === active % entries.length
              ? 'bg-(--ui-primary)'
              : 'bg-(--ui-border-accented) hover:bg-(--ui-text-dimmed)'"
            :aria-label="`Show ${entry.title}`"
            :aria-current="index === active % entries.length ? 'true' : undefined"
            @click="show(index)"
          />
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

    <!--
      Checked before the empty state, which would otherwise announce an empty
      library on behalf of a server that never answered.
    -->
    <div v-if="failed" class="grid min-h-screen place-items-center px-6 text-center">
      <div class="space-y-4">
        <UIcon name="i-lucide-unplug" class="size-12 text-(--ui-text-dimmed)" />
        <h1 class="text-2xl font-semibold">The library could not be reached</h1>
        <p class="text-(--ui-text-muted)">{{ apiMessage(failed, 'Something went wrong loading this page.') }}</p>
        <UButton color="neutral" variant="subtle" @click="reloadNuxtApp()">Try again</UButton>
      </div>
    </div>

    <!-- A new library is empty, and that is a state worth designing for. -->
    <div v-else-if="isEmpty" class="grid min-h-screen place-items-center px-6 text-center">
      <div class="space-y-4">
        <UIcon name="i-lucide-clapperboard" class="size-12 text-(--ui-text-dimmed)" />
        <h1 class="text-2xl font-semibold">Nothing here yet</h1>
        <p class="text-(--ui-text-muted)">Once there is something to watch, it will show up here.</p>
        <UButton to="/browse" color="neutral" variant="subtle">Browse the library</UButton>
      </div>
    </div>
  </div>
</template>
