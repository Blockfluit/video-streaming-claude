<script setup lang="ts">
/**
 * The player.
 *
 * Watch time is accumulated from `timeupdate` deltas with **jumps over 2s
 * discarded**, so scrubbing through a film does not report the film as
 * watched. Beats go out every 10s while playing, plus on pause, end and tab
 * hide; the last one uses `sendBeacon`, because a normal `fetch` is killed
 * mid-flight while the page tears down.
 */
interface Marker {
  introStartSec: number | null
  introEndSec: number | null
  outroStartSec: number | null
  outroEndSec: number | null
}

interface SubtitleTrack {
  id: string
  language: string
  label: string
  isDefault: boolean
}

const props = defineProps<{
  videoId: string
  title: string
  durationSec: number | null
  markers: Marker
  /** Where to go when the outro's "Next episode" is taken. */
  nextTo?: string | null
}>()

const emit = defineEmits<{ timeupdate: [seconds: number] }>()

const api = useApi()
const video = ref<HTMLVideoElement | null>(null)

/** One per page load. This is what makes a view countable. */
const playSessionId = crypto.randomUUID()

const { data: subtitles } = await useApiData<{ items: SubtitleTrack[] }>(
  `subs-${props.videoId}`,
  `/videos/${props.videoId}/subtitles`,
)

const { data: stats } = await useApiData<{ mine: { lastPositionSec: number } | null }>(
  `stats-${props.videoId}`,
  `/videos/${props.videoId}/stats`,
)

const currentTime = ref(0)

/**
 * How long the offer to start over stands, in **seconds of playback**.
 *
 * Not wall-clock seconds. The player does not autoplay, so a timer running from
 * the moment the offer appears expires over a paused first frame while the
 * viewer is still reading the page — and a control that disappears as you reach
 * for it is worse than one that was never there.
 */
const OFFER_SECONDS = 5

/**
 * Where playback was resumed to, and `null` once the offer to start over is
 * gone. This is the *outcome* of the resume rather than a proposal: by the time
 * it is set the video is already sitting at that second.
 */
const resumedAt = ref<number | null>(null)
const secondsLeft = ref(OFFER_SECONDS)
/** Held open while the pointer or the keyboard focus is on the offer. */
const offerHeld = ref(false)

let pendingDelta = 0
let lastTick = 0
let beatTimer: ReturnType<typeof setInterval> | undefined
let offerTimer: ReturnType<typeof setInterval> | undefined
/** One resume per load, from whichever of the two entry points arrives first. */
let resumeApplied = false

function beat(final = false) {
  const el = video.value
  if (!el) return

  const body = JSON.stringify({
    playSessionId,
    positionSec: el.currentTime,
    deltaSec: pendingDelta,
  })
  pendingDelta = 0

  if (final && typeof navigator !== 'undefined' && navigator.sendBeacon) {
    // A string beacon arrives as `text/plain`; the API parses that on this
    // route precisely so the closing beat is not lost.
    navigator.sendBeacon(`/api/videos/${props.videoId}/heartbeat`, body)
    return
  }

  void api(`/videos/${props.videoId}/heartbeat`, { method: 'POST', body: JSON.parse(body) }).catch(
    () => {
      // A dropped beat is not worth interrupting playback over. The next one
      // carries the position anyway.
    },
  )
}

function onTimeUpdate() {
  const el = video.value
  if (!el) return

  const now = el.currentTime
  const delta = now - lastTick
  // Anything larger is a seek, not watching. Counting it would let a scrub
  // through a two-hour film report two hours watched.
  if (delta > 0 && delta <= 2) pendingDelta += delta
  lastTick = now
  currentTime.value = now
  emit('timeupdate', now)
}

/**
 * Also reports the position after a seek.
 *
 * `timeupdate` only fires while the media is actually advancing, so dragging
 * the scrubber on a paused video leaves every listener holding the position
 * from before the drag — which is how "pin this comment to the current moment"
 * ends up pinning 0:00.
 */
function onSeeked() {
  const el = video.value
  if (!el) return
  lastTick = el.currentTime
  currentTime.value = el.currentTime
  emit('timeupdate', el.currentTime)
}

/**
 * Resumes, rather than offering to.
 *
 * A surface that says "Resume from 12:34" and then opens at 0:00 has not
 * resumed anything, and asking twice for one thing is the tedious half of being
 * careful. The jump is announced instead — the chip names the second it landed
 * on, and starting over is one press for the next five seconds of playback.
 *
 * Reading `stats` here is safe because it is fetched with `await useApiData` in
 * setup: the component suspends until it resolves, so the `<video>` element
 * this runs against cannot exist before the answer does. That await is why no
 * watcher is needed — one would risk seeking a second time under a viewer who
 * has already started scrubbing, which is also what `resumeApplied` guards
 * against, since `onMounted` calls this as well as the event does.
 */
function onLoadedMetadata() {
  const el = video.value
  if (!el) return
  lastTick = el.currentTime

  // Once, whether it resumed or decided not to. This runs from `onMounted` as
  // well as from the event, and both can happen on the same load.
  if (resumeApplied) return
  resumeApplied = true

  const point = resumePoint(stats.value?.mine?.lastPositionSec, props.durationSec ?? el.duration)
  if (point === null) return

  el.currentTime = point
  // `onTimeUpdate` discards jumps over 2s, but this one happens before any
  // `timeupdate` fires — without it the first beat credits the whole resume
  // offset as time watched.
  lastTick = point
  // The intro and outro overlays read this, and a comment pinned to "now" is
  // pinned to whatever the parent was last told.
  currentTime.value = point
  emit('timeupdate', point)

  resumedAt.value = point
  startOfferCountdown()
}

/**
 * Ticks once a second, but only while the video is actually advancing and the
 * offer is not being pointed at. Paused, buffering or hovered, it holds.
 */
function startOfferCountdown() {
  secondsLeft.value = OFFER_SECONDS
  clearInterval(offerTimer)
  offerTimer = setInterval(() => {
    const el = video.value
    if (!el || el.paused || offerHeld.value) return

    secondsLeft.value -= 1
    if (secondsLeft.value <= 0) dismissOffer()
  }, 1000)
}

function dismissOffer() {
  clearInterval(offerTimer)
  offerTimer = undefined
  resumedAt.value = null
}

/**
 * Back to the top. Stored progress is left alone deliberately: heartbeats
 * rewrite `lastPositionSec` as this plays through, and `maxPositionSec` — which
 * is what "completed" is judged on — is meant to be monotonic. Rewatching
 * something should not un-finish it.
 */
function startOver() {
  const el = video.value
  if (el) {
    el.currentTime = 0
    lastTick = 0
    currentTime.value = 0
    emit('timeupdate', 0)
  }
  dismissOffer()
}

/** Inside the intro range, and only when both ends are known. */
const inIntro = computed(() => {
  const { introStartSec: start, introEndSec: end } = props.markers
  return start !== null && end !== null && currentTime.value >= start && currentTime.value < end
})

const inOutro = computed(() => {
  const { outroStartSec: start, outroEndSec: end } = props.markers
  return start !== null && end !== null && currentTime.value >= start && currentTime.value < end
})

function skipTo(seconds: number | null) {
  const el = video.value
  if (el && seconds !== null) {
    el.currentTime = seconds
    lastTick = seconds
  }
}

/** Exposed so a comment pinned to a moment can seek there. */
function seek(seconds: number) {
  const el = video.value
  if (!el) return
  el.currentTime = seconds
  lastTick = seconds
  void el.play().catch(() => {
    // Autoplay may be refused; the seek still landed, which is the point.
  })
}

defineExpose({ seek })

function onVisibility() {
  if (document.visibilityState === 'hidden') beat()
}

onMounted(() => {
  /*
   * The metadata may already be here.
   *
   * On a hard load the `<video>` and its `<source>` arrive in the
   * server-rendered markup, so the browser starts fetching before Vue hydrates
   * and attaches the listener below — and `loadedmetadata` fires into nothing.
   * No one replays it, so the resume has to ask rather than wait, or a refresh
   * of the watch page silently opens at 0:00 while a click-through resumes
   * correctly. (Found in a browser; every assertion that reached the player by
   * clicking a link walked straight past it.)
   */
  if ((video.value?.readyState ?? 0) >= 1) onLoadedMetadata()

  beatTimer = setInterval(() => {
    if (video.value && !video.value.paused) beat()
  }, 10_000)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', () => beat(true))
})

onBeforeUnmount(() => {
  clearInterval(beatTimer)
  clearInterval(offerTimer)
  document.removeEventListener('visibilitychange', onVisibility)
  beat(true)
})
</script>

<template>
  <div class="relative w-full overflow-hidden rounded-lg bg-black ring-1 ring-(--ui-border)">
    <video
      ref="video"
      class="aspect-video w-full"
      controls
      playsinline
      :poster="`/api/videos/${videoId}/banner`"
      @timeupdate="onTimeUpdate"
      @seeked="onSeeked"
      @loadedmetadata="onLoadedMetadata"
      @pause="beat()"
      @ended="beat()"
    >
      <source :src="`/api/videos/${videoId}/stream`">
      <track
        v-for="track in subtitles?.items ?? []"
        :key="track.id"
        kind="subtitles"
        :src="`/api/videos/${videoId}/subtitles/${track.id}.vtt`"
        :srclang="track.language"
        :label="track.label"
        :default="track.isDefault"
      >
    </video>

    <!--
      Taken rather than offered — and then said out loud, because jumping
      silently into the middle of something is disorienting. The chip names the
      second it landed on; the button is the way back out of it.
    -->
    <Transition
      enter-active-class="transition duration-300"
      enter-from-class="opacity-0 translate-y-2"
      leave-active-class="transition duration-200"
      leave-to-class="opacity-0"
    >
      <div
        v-if="resumedAt !== null"
        class="absolute bottom-20 left-4 flex flex-col items-start gap-2"
        @mouseenter="offerHeld = true"
        @mouseleave="offerHeld = false"
        @focusin="offerHeld = true"
        @focusout="offerHeld = false"
      >
        <p
          class="rounded-full bg-(--ui-bg-elevated) px-3 py-1 text-sm text-(--ui-text-muted) ring-1 ring-(--ui-border)"
        >
          Resumed at {{ timecode(resumedAt) }}
        </p>
        <div class="flex items-center gap-2">
          <!--
            Neutral, not accent: playing is the default now, so there is no call
            to action on this screen for accent colour to mark.

            The explicit `aria-label` shadows the visible text, which is usually
            the bug worth catching. Here it is the point — it keeps the
            accessible name still while the digit beside it changes every
            second, and it stays a prefix of what is on screen.
          -->
          <UButton
            size="lg"
            color="neutral"
            variant="solid"
            icon="i-lucide-rotate-ccw"
            aria-label="Start from the beginning"
            @click="startOver"
          >
            Start from the beginning
            <!--
              No colour of its own. The five text tiers are measured against the
              page, and this sits on a light neutral button — `--ui-text-muted`
              there is a mid grey on near-white, well under AA. Inheriting is
              the only value guaranteed to suit whatever surface the button
              renders as; `tabular-nums` is what stops the label shifting as the
              digit changes.
            -->
            <span aria-hidden="true" class="tabular-nums font-normal">{{ secondsLeft }}</span>
          </UButton>
          <UButton
            size="lg"
            color="neutral"
            variant="solid"
            icon="i-lucide-x"
            aria-label="Dismiss"
            @click="dismissOffer"
          />
        </div>
      </div>
    </Transition>

    <Transition
      enter-active-class="transition duration-200"
      enter-from-class="opacity-0 translate-y-2"
      leave-active-class="transition duration-150"
      leave-to-class="opacity-0"
    >
      <div v-if="inIntro" class="absolute right-4 bottom-20">
        <UButton size="lg" color="neutral" variant="solid" @click="skipTo(markers.introEndSec)">
          Skip intro
        </UButton>
      </div>
    </Transition>

    <Transition
      enter-active-class="transition duration-200"
      enter-from-class="opacity-0 translate-y-2"
      leave-active-class="transition duration-150"
      leave-to-class="opacity-0"
    >
      <div v-if="inOutro" class="absolute right-4 bottom-20">
        <UButton v-if="nextTo" :to="nextTo" size="lg" trailing-icon="i-lucide-skip-forward">
          Next episode
        </UButton>
        <UButton v-else size="lg" color="neutral" variant="solid" @click="skipTo(markers.outroEndSec)">
          Skip outro
        </UButton>
      </div>
    </Transition>
  </div>
</template>
