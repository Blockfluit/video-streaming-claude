<script setup lang="ts">
/**
 * A video's own page — what you read before deciding to watch it.
 *
 * This is where a video lives. It used to be reachable only at
 * `/c/<collection>/<season>/<video>`, which assumed one parent — and a video may
 * sit in several collections, or in none at all. A standalone film is not a
 * video missing its collection; it is the ordinary case.
 *
 * It used to open the player straight away, with the synopsis, cast and comments
 * stacked underneath: everything you would read to decide sat below the fold of
 * the thing you had already committed to. Playback is at `/watch/<slug>` now and
 * this page describes.
 *
 * What it belongs to is shown rather than assumed: every collection holding it
 * gets a link, and the "more from" shelf is drawn for the first of them.
 */
interface Membership {
  collectionId: string
  seasonId: string | null
  orderIndex: number | null
  collection: { id: string, slug: string, title: string, state: string }
}

interface VideoDetail {
  id: string
  slug: string
  title: string
  description: string | null
  tags: string[]
  state: string
  durationSec: number | null
  width: number | null
  height: number | null
  bannerKey?: string | null
  trailerYoutubeId?: string | null
  collections: Membership[]
  // Imported, and all optional: a title nobody has matched carries none of it.
  year?: number | null
  tagline?: string | null
  genres?: string[]
  certification?: string | null
  imdbId?: string | null
  tmdbRating?: number | null
}

const route = useRoute()
const slug = computed(() => String(route.params.slug))

const { data: video, error, status } = await useApiData<VideoDetail>(
  () => `video-${slug.value}`,
  () => `/videos/by-slug/${encodeURIComponent(slug.value)}`,
  // `lazy` so clicking a poster opens this page immediately. It is the most
  // travelled link in the app, and it was the one that sat on the previous
  // screen doing nothing.
  { watch: [slug], lazy: true },
)

/*
 * The 404, moved out of setup.
 *
 * `lazy` means the request has not been made when setup runs, so `error` is
 * null here on a client-side navigation and a `throw` would simply never fire —
 * a missing video would render the page's own "not found" fallback instead of
 * Nuxt's error page. A watcher sees the failure whenever it lands.
 *
 * `showError` rather than `throw createError`, because outside setup there is
 * nothing left to throw to. `immediate` covers the server, where the fetch
 * *does* block and the error is already present by the time this runs.
 */
watch(error, (failure) => {
  if (failure) showError({ statusCode: 404, statusMessage: 'No such video', fatal: true })
}, { immediate: true })

/** The collection the "more from" shelf is drawn from, when there is one. */
const primary = computed(() => video.value?.collections?.[0] ?? null)

/**
 * The rest of that collection.
 *
 * Fetched only when the video is in one — a standalone film has no siblings, and
 * asking for them would be a request whose answer is always empty.
 */
const { data: siblings } = await useApiData<{
  items: {
    id: string
    slug: string
    title: string
    durationSec: number | null
    width: number | null
    height: number | null
    state: string
    bannerKey?: string | null
  }[]
}>(
  () => `siblings-${primary.value?.collectionId ?? 'none'}`,
  () => `/videos?collectionId=${primary.value!.collectionId}&limit=100`,
  { watch: [primary], immediate: !!primary.value },
)

const otherVideos = computed(() =>
  (siblings.value?.items ?? []).filter(entry => entry.id !== video.value?.id),
)

/**
 * Where this viewer got to, which decides whether the button says Play or
 * Resume. The player asks for the same thing again and seeks there once metadata
 * arrives; asking here as well is what lets the button name a time before anyone
 * has committed to loading a stream.
 */
const { data: stats } = await useApiData<{
  mine: { lastPositionSec: number } | null
  /**
   * Whether this video is already on the caller's list.
   *
   * A sibling of `mine` rather than part of it: `mine` is null for a video
   * nobody has started, and saving something is independent of watching it.
   * Read here because this is the per-caller request the page already makes —
   * the button had nothing to go on before, so it painted "add to my list" for
   * something already saved, every time.
   */
  inMyList: boolean
}>(
  () => `summary-stats-${video.value?.id ?? 'none'}`,
  () => `/videos/${video.value!.id}/stats`,
  { watch: [() => video.value?.id], immediate: !!video.value },
)

/**
 * The same predicate the player seeks by, so the second named on this button is
 * the second playback actually opens at.
 */
const resumeAt = computed(() =>
  resumePoint(stats.value?.mine?.lastPositionSec, video.value?.durationSec),
)

/**
 * `S1 E3`, from where this video sits in the collection being shown.
 *
 * The number is its **position among that collection's videos**, not its
 * `orderIndex`: the parser stores the number it read off a filename, and a
 * drag-reorder rewrites a season 0-based, so rendering `orderIndex` directly
 * labelled the first episode of a real show "E0".
 */
const episodeLabel = computed(() => {
  const membership = primary.value
  if (!membership?.seasonId) return null

  const inSeason = (siblings.value?.items ?? [])
  const position = inSeason.findIndex(entry => entry.id === video.value?.id)
  return position < 0 ? null : `Episode ${position + 1}`
})

/**
 * The textual half of the meta line, joined with `·`.
 *
 * Rendered as one string rather than as gapped `<span>`s: separators make it
 * read as a single line of facts, where equal gaps read as three fragments that
 * happen to be adjacent. The badges stay as chips after it — they are marks, not
 * prose, and running a `·` between a word and a chip looks like a mistake.
 */
const metaLine = computed(() =>
  [episodeLabel.value, runtime(video.value?.durationSec)].filter(Boolean).join(' · '),
)

const { isAdmin } = useSession()

/**
 * Shared between the button that opens the trailer and the hero behind it: the
 * hero is playing the same video, silently, and leaving it running under an open
 * dialog is two copies of one trailer for as long as the dialog is up.
 */
const trailerOpen = ref(false)

useHead(() => ({ title: video.value?.title ?? 'Library' }))
</script>

<template>
  <div v-if="video">
    <!--
      `full` rather than `tall`: a standalone film has no cast, no tags and no
      siblings, so everything below the hero is empty and a shorter band left the
      title floating mid-screen with nothing under it. Where there *is* something
      below, it scrolls up from the bottom edge the ordinary way.
    -->
    <HeroBackdrop
      :image="videoBanner(video)"
      size="full"
      :trailer-id="video.trailerYoutubeId"
      :paused="trailerOpen"
    >
      <div class="rise max-w-2xl space-y-4">
        <!--
          Every collection holding this video, not a guessed single parent. In
          muted text with a red rule rather than in red type: red on near-black
          passes WCAG and still reads poorly at 12px.
        -->
        <p
          v-if="video.collections.length"
          class="flex flex-wrap items-center gap-2 text-xs font-semibold tracking-[0.2em] text-(--ui-text-muted) uppercase"
        >
          <span aria-hidden="true" class="h-3 w-0.5 rounded-full bg-(--ui-primary)" />
          <template v-for="(membership, index) in video.collections" :key="membership.collectionId">
            <span v-if="index > 0" aria-hidden="true">·</span>
            <NuxtLink
              :to="collectionPath(membership.collection)"
              class="transition-colors hover:text-(--ui-text)"
            >
              {{ membership.collection.title }}
            </NuxtLink>
          </template>
        </p>

        <div class="flex items-center gap-3">
          <h1 class="text-4xl font-bold tracking-tight text-white sm:text-5xl">{{ video.title }}</h1>
          <ImdbLink :imdb-id="video.imdbId" :label="video.title" />
        </div>

        <!-- One line, and only when there is one. Never a blank gap under the title. -->
        <p v-if="video.tagline" class="max-w-xl text-balance italic text-(--ui-text-muted)">
          {{ video.tagline }}
        </p>

        <div class="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-(--ui-text-muted)">
          <span v-if="video.year">{{ video.year }}</span>
          <span v-if="metaLine">{{ metaLine }}</span>
          <QualityBadge :width="video.width" :height="video.height" />
          <!--
            An age rating reads as a rating, so it is bordered rather than filled:
            a solid badge here competes with the quality badge beside it, and the
            two say very different kinds of thing.
          -->
          <UBadge v-if="video.certification" color="neutral" variant="outline">
            {{ video.certification }}
          </UBadge>
          <span v-if="video.tmdbRating" class="inline-flex items-center gap-1">
            <UIcon name="i-lucide-star" class="size-3.5" />
            {{ video.tmdbRating.toFixed(1) }}
          </span>
          <UBadge v-if="video.state !== 'PUBLISHED'" color="warning" variant="subtle">
            {{ video.state }}
          </UBadge>
        </div>

        <!--
          Narrower than the block around it and clamped. A synopsis set to the
          full width of a wide screen is a line too long to track back from, and
          an overlong one would otherwise push the buttons off the hero.
        -->
        <p v-if="video.description" class="line-clamp-3 max-w-xl text-(--ui-text-toned)">
          {{ video.description }}
        </p>

        <div class="flex flex-wrap items-center gap-3 pt-2">
          <!--
            The one real call to action on the screen, so it is the solid one.

            It names the collection this page is already showing — the same one
            the "more from" shelf below is drawn from — so playing from here
            steps through the show rather than landing in it alone. A standalone
            film has none, which is what the optional argument is for.
          -->
          <UButton
            :to="playPath(video, primary?.collection.slug)"
            size="lg"
            icon="i-lucide-play"
            class="font-semibold"
          >
            {{ resumeAt === null ? 'Play' : `Resume from ${timecode(resumeAt)}` }}
          </UButton>
          <AddToListButton :video-id="video.id" :saved="stats?.inMyList" label />
          <!--
            Renders nothing when there is no trailer, so the row closes up rather
            than offering a button that opens an empty dialog.
          -->
          <TrailerModal
            v-model:open="trailerOpen"
            :trailer-id="video.trailerYoutubeId"
            :title="video.title"
          />
          <!--
            Straight to this video's editor, so fixing a title or a marker does
            not mean walking back through the admin library to find the row you
            were just looking at.
          -->
          <UButton
            v-if="isAdmin"
            :to="`/admin/videos/${video.id}`"
            color="neutral"
            variant="subtle"
            icon="i-lucide-pencil"
          >
            Edit
          </UButton>
        </div>
      </div>
    </HeroBackdrop>

    <div class="page-shell relative z-1 -mt-4 space-y-8 pb-24">
      <!--
        Genres are imported and tags are curated, which is why they are separate
        columns and separate rows. A genre links to a browse filter the same way
        a tag does, so the distinction costs a reader nothing.
      -->
      <div v-if="video.genres?.length" class="flex flex-wrap gap-2">
        <UBadge
          v-for="genre in video.genres"
          :key="genre"
          color="neutral"
          variant="outline"
          :to="`/browse?q=${encodeURIComponent(genre)}`"
        >
          {{ genre }}
        </UBadge>
      </div>

      <div v-if="video.tags?.length" class="flex flex-wrap gap-2">
        <UBadge
          v-for="tag in video.tags"
          :key="tag"
          color="neutral"
          variant="subtle"
          :to="`/browse?tag=${encodeURIComponent(tag)}`"
        >
          {{ tag }}
        </UBadge>
      </div>

      <CreditsPanel :video-id="video.id" />

      <MediaRow
        v-if="primary && otherVideos.length"
        :title="`More from ${primary.collection.title}`"
        :empty="false"
        :to="collectionPath(primary.collection)"
      >
        <!--
          These play. The shelf only exists when this video is in a collection,
          so picking from it is the same act as picking an episode on the
          collection's own page — and that plays.

          The collection goes with the link: it is the one this shelf is drawn
          from, so it is also the running order the player should step through.
        -->
        <MediaCard
          v-for="entry in otherVideos"
          :key="entry.id"
          class="w-56 sm:w-64"
          :to="playPath(entry, primary.collection.slug)"
          :title="entry.title"
          :subtitle="runtime(entry.durationSec)"
          :image-url="videoPoster(entry)"
          :width="entry.width"
          :height="entry.height"
          :badge="entry.state === 'PUBLISHED' ? null : entry.state"
        />
      </MediaRow>
    </div>
  </div>

  <!--
    The title band, waiting.

    Mirrors the `full` hero above it — same `min-h-[88svh]`, same padding, text
    on the floor of the frame — so the real page does not jump up the screen
    when it arrives. A 404 is handled by the watcher in the script and replaces
    this whole page with Nuxt's error page, so this only ever stands in for a
    request that is still in flight.
  -->
  <section
    v-else-if="status !== 'success'"
    class="relative flex min-h-[88svh] w-full items-end overflow-hidden bg-(--ui-bg-muted) pt-28 pb-10"
    role="status"
    aria-label="Loading this title"
  >
    <div class="page-shell w-full">
      <div class="max-w-2xl space-y-4">
        <div class="skeleton h-3 w-40" />
        <div class="skeleton h-12 w-3/4 sm:h-16" />
        <div class="skeleton h-4 w-56" />
        <div class="skeleton h-4 w-full max-w-xl" />
        <div class="flex items-center gap-3 pt-2">
          <div class="skeleton h-10 w-32 rounded-lg" />
          <div class="skeleton h-10 w-28 rounded-lg" />
        </div>
      </div>
    </div>
  </section>
</template>
