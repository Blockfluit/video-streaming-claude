<script setup lang="ts">
/**
 * Playback, and nothing else.
 *
 * A separate route from `/v/:slug` rather than a mode that page switches into,
 * so Back returns to the description and a link that starts playing can be
 * shared as one. Keyed on the slug like every other address in the app.
 *
 * The page carries the player and the comments. Synopsis, cast and the rest of
 * the collection live on `/v/:slug` — the page you go back to.
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
  state: string
  durationSec: number | null
  width: number | null
  height: number | null
  introStartSec: number | null
  introEndSec: number | null
  outroStartSec: number | null
  outroEndSec: number | null
  collections: Membership[]
}

/**
 * What ordering needs, plus what the rail beside the player draws.
 *
 * All of it arrives on the one response already — this only widens the local
 * view of it, so the rail costs no second request. `title` on a season is read
 * for nothing yet; the heading is built from the number, and a season that
 * names itself is a change to `EpisodeRail`, not to what is fetched.
 */
interface CollectionSequence {
  seasons: { id: string, number: number | null }[]
  videos: {
    id: string
    slug: string
    title: string
    seasonId: string | null
    orderIndex: number | null
    durationSec: number | null
    state: string
  }[]
}

const route = useRoute()
const slug = computed(() => String(route.params.slug))

/**
 * Which collection this was reached through, and therefore which running order
 * the stepper walks.
 *
 * It is in the URL because it cannot be worked out here. A video belongs to any
 * number of collections and `seasonId`/`orderIndex` are facts about one
 * membership, so the same episode can be episode 3 of a show and item 1 of a
 * best-of row; picking one on arrival would be a guess that is wrong about half
 * the time. The surface that built the link knew, so it says so.
 *
 * Absent is an ordinary state — a standalone film, or something opened from
 * Continue Watching — and simply means no stepper.
 */
const from = computed(() => {
  const query = route.query.from
  // Repeating a query parameter is legal and gives an array; the first wins.
  const named = Array.isArray(query) ? query[0] : query
  return typeof named === 'string' && named.length > 0 ? named : null
})

const { data: video, error } = await useApiData<VideoDetail>(
  () => `playback-${slug.value}`,
  () => `/videos/by-slug/${encodeURIComponent(slug.value)}`,
  { watch: [slug] },
)

if (error.value) {
  throw createError({ statusCode: 404, statusMessage: 'No such video', fatal: true })
}

/**
 * The collection this was reached through, for what comes before and after.
 *
 * It replaces a read of `GET /videos?collectionId=…`, which cannot answer the
 * question: that endpoint sorts by title, deliberately, because a video belongs
 * to any number of collections and a library-wide listing has no single running
 * order to offer. The old "Next episode" button was therefore the alphabetically
 * next title, capped at a hundred.
 *
 * `lazy`, because this is chrome beside the title and the player is the point of
 * the page. Blocking the render on a second request would hold up the `<source>`
 * the browser starts fetching from the server-rendered HTML, which is to say it
 * would delay playback to draw a button.
 *
 * The key is the watch page's own, deliberately **not** the `detail-<slug>` the
 * collection page uses for this same URL. `useApiData` freezes its key at setup
 * while `watch` keeps refetching under it, so a move between two collections on
 * this route would write one collection's episodes into the other's cache entry
 * — and the collection page would later render the wrong show's list. Sharing
 * bought a warm ref rather than a skipped request in any case.
 */
const { data: collection } = await useApiData<CollectionSequence>(
  () => `watch-sequence-${from.value ?? 'none'}`,
  () => `/collections/${encodeURIComponent(from.value!)}`,
  { watch: [from], immediate: from.value !== null, lazy: true },
)

/** The collection in the order somebody actually watches it. */
const sequence = computed(() =>
  episodeSequence(collection.value?.videos ?? [], collection.value?.seasons ?? []),
)

/**
 * Both ends of the step, from one lookup.
 *
 * A video that is not in the sequence gets nothing either way — which covers a
 * `?from=` naming a collection this video is not in (it arrives through the URL,
 * so anyone can write one), a collection the caller cannot see, and the case
 * where the response was truncated past its embedded-video cap and this episode
 * fell the wrong side of the cut. Offering no stepper beats offering a wrong one.
 */
const steps = computed(() => neighbours(sequence.value, video.value?.id ?? ''))

/**
 * Shown as a pair or not at all, so the row does not gain a control halfway
 * through a show. One video on its own has nothing to step between.
 */
const hasStepper = computed(
  () => sequence.value.length > 1 && sequence.value.some(entry => entry.id === video.value?.id),
)

/**
 * Both links carry the collection on, or taking one step would be the last one
 * available — the stepper would vanish underneath the person using it.
 */
const previousTo = computed(() =>
  steps.value.previous ? playPath(steps.value.previous, from.value) : null,
)

/**
 * Next keeps *playing* rather than bouncing through a description. Someone who
 * has reached the outro of episode three has already decided. This is also what
 * the player's own outro button follows.
 */
const nextTo = computed(() =>
  steps.value.next ? playPath(steps.value.next, from.value) : null,
)

/**
 * The rail lists the same sequence the stepper walks, cut at the seasons.
 *
 * Deliberately the same `sequence` and the same condition as `hasStepper`, so a
 * page never gains one of the two controls and not the other, and the rail can
 * never claim an order the Next button disagrees with.
 */
const groups = computed(() => groupBySeason(sequence.value, collection.value?.seasons ?? []))
const hasRail = computed(() => hasStepper.value)

/**
 * The collection to name above the rail, taken from this video's own
 * memberships rather than from the sequence read.
 *
 * `?from=` is a slug and arrives through the URL, where anybody can write one.
 * Matching it against the memberships is what makes the heading a fact about
 * this video: a slug naming a collection this video is not in finds nothing, and
 * the rail is already withheld in that case by `hasStepper`.
 */
const railCollection = computed(
  () => video.value?.collections.find(entry => entry.collection.slug === from.value)?.collection
    ?? null,
)

/**
 * How far the viewer got through each of them, for the resume bars and the
 * watched ticks — the same endpoint and the same shape the collection page
 * uses, so the two screens cannot draw different bars for one episode.
 *
 * `lazy` for the reason the sequence read is: this is chrome beside the player,
 * and blocking the render on it would delay playback to draw a progress bar.
 * Asked for only when there is a rail to draw it in.
 */
const { data: watched } = await useApiData<{
  items: { videoId: string, lastPositionSec: number, completed: boolean }[]
}>(
  () => `watch-progress-${from.value ?? 'none'}`,
  () => `/collections/${encodeURIComponent(from.value!)}/progress`,
  { watch: [from], immediate: from.value !== null, lazy: true },
)

const progressByVideo = computed(
  () => new Map((watched.value?.items ?? []).map(item => [item.videoId, item])),
)

/** Back to this video's own page, which is where the cast and synopsis are. */
const backTo = computed(() => (video.value ? videoPath(video.value) : '/browse'))

const player = ref<{ seek?: (s: number) => void } | null>(null)
const currentTime = ref(0)

const { isAdmin } = useSession()

useHead(() => ({ title: video.value?.title ?? 'Watch' }))
</script>

<template>
  <div v-if="video" class="page-shell pt-24 pb-24">
    <!--
      One grid for the whole page, and the breadcrumb inside the player's own
      column.

      It used to sit out here as a child of `.page-shell` while everything below
      it was wrapped in `mx-auto max-w-6xl`, so past about 1250px the trail
      started several hundred pixels left of the picture it named. Sharing a
      column makes the two edges the same edge, rather than two numbers that
      happen to agree until one of them is changed.

      Rows and columns are placed explicitly so the rail can stand beside both
      the player and the comments while the DOM order — player, episodes,
      comments — is what a phone gets stacked. Left as source order, a rail
      would land under a thread of comments, which is where nobody looks for it.
    -->
    <div
      class="grid gap-x-8 gap-y-6 lg:items-start"
      :class="hasRail
        ? 'lg:grid-cols-[minmax(0,1fr)_22rem]'
        : 'mx-auto w-full max-w-[min(100%,calc((100dvh-13rem)*16/9))]'"
    >
      <div class="min-w-0 space-y-6">
        <nav class="flex flex-wrap items-center gap-2 text-sm text-(--ui-text-muted)">
          <template v-for="membership in video.collections" :key="membership.collectionId">
            <NuxtLink
              :to="collectionPath(membership.collection)"
              class="transition-colors hover:text-(--ui-text)"
            >
              {{ membership.collection.title }}
            </NuxtLink>
            <span aria-hidden="true">/</span>
          </template>
          <NuxtLink :to="backTo" class="text-(--ui-text) transition-colors hover:text-white">
            {{ video.title }}
          </NuxtLink>
        </nav>

        <VideoPlayer
          ref="player"
          :video-id="video.id"
          :title="video.title"
          :duration-sec="video.durationSec"
          :markers="video"
          :next-to="nextTo"
          @timeupdate="seconds => (currentTime = seconds)"
        />

        <div class="flex flex-wrap items-center gap-3">
          <h1 class="text-xl font-semibold tracking-tight">{{ video.title }}</h1>
          <QualityBadge :width="video.width" :height="video.height" />
          <UBadge v-if="video.state !== 'PUBLISHED'" color="warning" variant="subtle">
            {{ video.state }}
          </UBadge>
          <!--
            The controls are kept together in one `ml-auto` group rather than
            pushed apart: with the margin on the first button, a second one lands
            beside the title and the row reads as two unrelated halves.
          -->
          <div class="ml-auto flex items-center gap-2">
            <!--
              Stepping through the collection this was reached through.

              Rendered as a pair and kept in place at the ends rather than
              disappearing: a control that vanishes at the last episode moves
              everything beside it, and the row you were aiming at shifts under
              the pointer. Disabled says "this is the end of the show", which is
              worth knowing; absent says nothing at all.

              No `to` when there is nowhere to go, so this is a real disabled
              `<button>` rather than a link that still navigates.
            -->
            <template v-if="hasStepper">
              <UButton
                :to="previousTo ?? undefined"
                :disabled="!previousTo"
                color="neutral"
                variant="subtle"
                icon="i-lucide-chevron-left"
                aria-label="Previous episode"
              >
                Previous
              </UButton>
              <UButton
                :to="nextTo ?? undefined"
                :disabled="!nextTo"
                color="neutral"
                variant="subtle"
                trailing-icon="i-lucide-chevron-right"
                aria-label="Next episode"
              >
                Next
              </UButton>
            </template>

            <!-- Everything worth reading about this video is one click away. -->
            <UButton :to="backTo" color="neutral" variant="subtle" icon="i-lucide-info">
              Details
            </UButton>
            <!--
              A wrong title or a misplaced marker is noticed here, with the video
              playing — not on the page you came from. Admins only: the API
              refuses either way, but offering a button that 403s is not an
              interface.
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
      </div>

      <!--
        The rest of the show, beside the picture rather than a page back. It
        spans both rows so it stands the full height of the column on a wide
        screen, and comes second in the source so a stacked phone gets it
        between the player and the comments.
      -->
      <EpisodeRail
        v-if="hasRail && railCollection && from"
        class="lg:col-start-2 lg:row-span-2 lg:row-start-1"
        :groups="groups"
        :collection="railCollection"
        :current-video-id="video.id"
        :from="from"
        :progress="progressByVideo"
      />

      <div class="min-w-0 space-y-6 lg:col-start-1 lg:row-start-2">
        <USeparator />

        <!--
          Comments stay with the player: one pinned to a moment seeks the video
          that is on screen, which it cannot do from a page with no player on it.
        -->
        <CommentThread
          :video-id="video.id"
          :current-time="currentTime"
          @seek="seconds => player?.seek?.(seconds)"
        />
      </div>
    </div>
  </div>
</template>
