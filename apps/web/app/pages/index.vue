<script setup lang="ts">
import type { LibraryCard, Page } from '@video/shared'

import type { Rotation } from '~/utils/hero'

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
const [
  { data: rows, error: rowsError, status: rowsStatus },
  { data: newest, error: newestError, status: newestStatus },
] = await Promise.all([
  useApiData<Page<HomeRow>>('home-rows', '/lists?limit=20', { lazy: true }),
  useApiData<Page<LibraryCard>>(
    'home-newest',
    `/library?sort=added&limit=${HERO_LIMIT}`,
    { lazy: true },
  ),
])

const failed = computed(() => rowsError.value ?? newestError.value ?? null)

/**
 * Still waiting on the first answer.
 *
 * Both requests, because the hero is drawn from one and the shelves from the
 * other and a half-built home page is worse than a placeholder for a moment
 * longer. Neither is watched, so this only describes the first load — there is
 * no refetch here whose results this could throw away.
 *
 * `!== 'success'` rather than `=== 'pending'`: under `lazy` the fetch has not
 * started when this component first renders, so the status is still `idle` and
 * a `pending` test would leave the frame blank.
 */
const loading = computed(() => rowsStatus.value !== 'success' || newestStatus.value !== 'success')

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
 * Which one is showing, and how long it has been showing for.
 *
 * Starts at the beginning of the first entry, deterministically. Anything
 * derived from a clock or a random number renders one entry on the server and a
 * different one in the browser, and a hydration mismatch is a warning rather
 * than an error — so it would simply be wrong, quietly, forever. `elapsedMs` is
 * part of that: the pill on the active bullet is drawn from it, so the server
 * renders an empty one and the browser fills it from there.
 *
 * `tickRotation` in `app/utils/hero.ts` owns the arithmetic and is unit-tested;
 * this file is the clock around it.
 */
const rotation = ref<Rotation>({ index: 0, elapsedMs: 0 })

/**
 * Read through the modulo rather than trusting the index.
 *
 * `entries` can shrink under a refetch, which would otherwise leave the index
 * past the end and the hero blank while `v-if` still passed.
 */
const active = computed(() =>
  entries.value.length === 0 ? 0 : rotation.value.index % entries.value.length,
)

const hero = computed(() =>
  entries.value.length === 0 ? null : entries.value[active.value] ?? null,
)

/**
 * Rotation stops for the three things that should stop it.
 *
 * `hovering` covers a pointer resting on the hero and keyboard focus inside it.
 * `paused` is the explicit control — auto-updating content needs a way to stop
 * it, and "wait, what was that" is the commonest reason to want one.
 * `trailerOpen` is the third and is not a preference at all: the hero cannot
 * move on to the next title while somebody is watching this one's trailer in a
 * dialog on top of it.
 *
 * There used to be a fourth, `dismissed`, set by a ✕ on the hero's own trailer
 * controls and permanent for the visit. Those controls are gone — they steered
 * something nobody was watching — and the trailer is now a dialog, which is a
 * thing you close rather than dismiss.
 */
const paused = ref(false)
const hovering = ref(false)
const trailerOpen = ref(false)

const rotating = computed(() =>
  entries.value.length > 1 && !paused.value && !hovering.value && !trailerOpen.value,
)

/**
 * What the pill's *label* keys on — deliberately not `rotating`.
 *
 * `rotating` folds in `hovering`, and a pointer is on the hero whenever anyone
 * is near enough to press the control. Labelling from it is what made the old
 * pause button look inert: it read "Resume the rotation" from the moment you
 * reached for it and could not change while you were there. This says only
 * whether the viewer has stopped it, so pressing it flips the label under their
 * hand.
 *
 * `trailerOpen` is left out for the same reason `hovering` is: it is not the
 * viewer's answer to this control, and the control is behind a modal dialog and
 * unreachable while it is true anyway.
 */
const stopped = computed(() => paused.value)

/**
 * Whether the hero may move on its own at all.
 *
 * Defaults to true so the server renders the common case — an empty pill about
 * to start filling. Under `prefers-reduced-motion` the pill is drawn full
 * instead of empty: a bar that will never fill reads as broken, where a solid
 * one reads as "this is the one you are looking at", which is all it can
 * honestly say when nothing is going to happen next.
 */
const motion = ref(true)

const fill = computed(() =>
  motion.value ? Math.min(rotation.value.elapsedMs / ROTATE_MS, 1) : 1,
)

let frame: number | undefined
let last = 0

/**
 * A frame loop rather than an interval, because the elapsed time is now drawn.
 * An interval that fires every ten seconds says nothing about where the current
 * turn has got to, and a second timer to animate the pill alongside it is two
 * clocks to keep in agreement — they drift apart exactly when the rotation is
 * held and resumed, which is most of the time.
 *
 * It also stops entirely in a background tab, where an interval keeps firing:
 * the hero holds where it was left rather than burning through five entries
 * nobody was there to see.
 */
function step(now: number): void {
  frame = requestAnimationFrame(step)

  const delta = now - last
  // Before the guard, not after: a paused hero still has to keep its clock
  // current, or resuming hands the whole paused span over as one delta.
  last = now

  if (!rotating.value) return

  rotation.value = tickRotation(rotation.value, delta, entries.value.length)
}

/**
 * Started in `onMounted`, so it never runs during SSR: a loop created in
 * `setup` would run in Nitro on every render, never be cancelled, and mutate
 * state between rendering the markup and serialising the payload.
 *
 * Not under `prefers-reduced-motion` either. A hero that begins moving on its
 * own is precisely what that setting is about, and it is the same rule the
 * trailer already follows — the bullets still work.
 */
onMounted(() => {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    motion.value = false
    return
  }

  last = performance.now()
  frame = requestAnimationFrame(step)
})

onBeforeUnmount(() => {
  if (frame !== undefined) cancelAnimationFrame(frame)
})

/** Picking one by hand is a decision, so it stops the carousel moving under you. */
function show(index: number): void {
  rotation.value = { index, elapsedMs: 0 }
  paused.value = true
}

/**
 * The active bullet is also the stop control.
 *
 * It used to clear a second flag as well — `dismissed`, set by the ✕ on the
 * hero's old trailer controls — because leaving that one alone would have
 * offered "Resume the rotation" on something that then refused to resume. Those
 * controls are gone and `paused` is the only thing this answers to now, which is
 * exactly what a control that says "Pause" should be.
 */
function togglePause(): void {
  paused.value = !paused.value
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
      :paused="trailerOpen"
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
          <!--
            Beside "More info" rather than in a corner of the hero, which is
            where the old play/mute/✕ band lived. A trailer is one of the two
            things you can do with a title you are still deciding about, so it
            belongs next to the other one — and the title pages put it in exactly
            the same place, beside My List.

            Inside the keyed column, so it is rebuilt with the entry it belongs
            to. Safe only because an open dialog stops the rotation: without
            that, the hero could turn over underneath it and take the dialog —
            and `trailerOpen`, stuck true — with it.
          -->
          <TrailerModal
            v-model:open="trailerOpen"
            :trailer-id="hero.trailerId"
            :title="hero.title"
          />
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

        There was a pause/resume button on the left of this row and it is gone,
        replaced by the active bullet itself. It was not merely redundant: its
        icon and label came from `rotating`, which is false while a pointer is
        anywhere on the hero — so by the time anyone had reached for it, it was
        already showing "play" and could not change under their click. A control
        that cannot answer is worse than no control, and the pill says the same
        thing better by showing the turn it is counting down.
      -->
      <div v-if="entries.length > 1" class="mt-6 flex items-center gap-2">
        <!--
          The active bullet stretches into a pill and fills over the entry's
          turn, so the wait is visible rather than a surprise — and it doubles as
          the stop control, because auto-updating content needs one.

          Its label keys on `stopped`, never on `rotating`: hovering freezes the
          fill (which explains itself) but must not rename the button, which is
          the exact fault the old play button had.
        -->
        <button
          v-for="(entry, index) in entries"
          :key="entry.id"
          type="button"
          class="h-2.5 rounded-full transition-[width,background-color]"
          :class="index === active
            ? 'w-10 bg-(--ui-border-accented)'
            : 'w-2.5 bg-(--ui-border-accented) hover:bg-(--ui-text-dimmed)'"
          :aria-label="index === active
            ? (stopped ? 'Resume the rotation' : 'Pause the rotation')
            : `Show ${entry.title}`"
          :aria-current="index === active ? 'true' : undefined"
          @click="index === active ? togglePause() : show(index)"
        >
          <!--
            Decoration: `aria-current` is what announces which entry is showing,
            and a progressbar nested inside a button is an ambiguity nobody
            needs. No transition on the width — it is rewritten every frame, and
            a transition would smear it a third of a second behind the truth.
          -->
          <span
            v-if="index === active"
            aria-hidden="true"
            class="block h-full rounded-full bg-(--ui-primary)"
            :style="{ width: `${fill * 100}%` }"
          />
        </button>
      </div>
    </HeroBackdrop>

    <!--
      The hero's own box, while there is nothing to put in it.

      Same band as `HeroBackdrop`'s `wide` size and the same `page-shell` inside
      it, so the shelves below start at the height they will keep. A hero that
      appears and shoves the page down is the reflow this whole change exists to
      avoid, and it is the most visible one on the site.
    -->
    <section
      v-else-if="loading"
      class="relative flex h-[58vh] min-h-100 w-full items-center overflow-hidden bg-(--ui-bg-muted)"
      role="status"
      aria-label="Loading the library"
    >
      <div class="page-shell w-full">
        <div class="max-w-xl space-y-4">
          <div class="skeleton h-3 w-32" />
          <div class="skeleton h-12 w-4/5 sm:h-16" />
          <div class="skeleton h-4 w-48" />
          <div class="flex items-center gap-3 pt-2">
            <div class="skeleton h-10 w-32 rounded-lg" />
            <div class="skeleton h-10 w-28 rounded-lg" />
          </div>
        </div>
      </div>
    </section>

    <div
      class="page-shell space-y-8 pb-24"
      :class="hero || loading ? 'relative z-1 -mt-16' : 'pt-24'"
    >
      <!--
        Three, which is about a screenful. The real count is unknowable until
        the rows arrive and guessing high would fill the page with placeholders
        for shelves that may not exist.
      -->
      <template v-if="loading">
        <SkeletonRow v-for="index in 3" :key="index" />
      </template>

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

    <!--
      A new library is empty, and that is a state worth designing for.

      `&& !loading` for the same reason `failed` is checked before it: while the
      requests are still out every shelf is empty and every hero entry missing,
      which is indistinguishable from an empty library from here. Without it,
      arriving at the home page announces "Nothing here yet" over a library full
      of things, for as long as the fetch takes.
    -->
    <div v-else-if="isEmpty && !loading" class="grid min-h-screen place-items-center px-6 text-center">
      <div class="space-y-4">
        <UIcon name="i-lucide-clapperboard" class="size-12 text-(--ui-text-dimmed)" />
        <h1 class="text-2xl font-semibold">Nothing here yet</h1>
        <p class="text-(--ui-text-muted)">Once there is something to watch, it will show up here.</p>
        <UButton to="/browse" color="neutral" variant="subtle">Browse the library</UButton>
      </div>
    </div>
  </div>
</template>
