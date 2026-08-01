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
const resumeOffer = ref<number | null>(null)
let pendingDelta = 0
let lastTick = 0
let beatTimer: ReturnType<typeof setInterval> | undefined

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

function onLoadedMetadata() {
  const el = video.value
  if (!el) return
  lastTick = el.currentTime

  const resume = stats.value?.mine?.lastPositionSec ?? 0
  const duration = props.durationSec ?? el.duration
  // Offered, never taken automatically: jumping silently into the middle of
  // something is disorienting, and 5s in is not worth resuming at all.
  if (resume > 5 && duration > 0 && resume < duration * 0.95) {
    resumeOffer.value = resume
  }
}

function takeResume() {
  const el = video.value
  if (el && resumeOffer.value !== null) {
    el.currentTime = resumeOffer.value
    lastTick = resumeOffer.value
  }
  resumeOffer.value = null
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
  beatTimer = setInterval(() => {
    if (video.value && !video.value.paused) beat()
  }, 10_000)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', () => beat(true))
})

onBeforeUnmount(() => {
  clearInterval(beatTimer)
  document.removeEventListener('visibilitychange', onVisibility)
  beat(true)
})
</script>

<template>
  <div class="relative w-full overflow-hidden rounded-lg bg-black ring-1 ring-white/10">
    <video
      ref="video"
      class="aspect-video w-full"
      controls
      playsinline
      :poster="`/api/videos/${videoId}/thumbnail`"
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

    <!-- Offered rather than taken: silently jumping into the middle is disorienting. -->
    <Transition
      enter-active-class="transition duration-300"
      enter-from-class="opacity-0 translate-y-2"
      leave-active-class="transition duration-200"
      leave-to-class="opacity-0"
    >
      <div v-if="resumeOffer !== null" class="absolute bottom-20 left-4 flex items-center gap-2">
        <UButton size="lg" icon="i-lucide-rotate-ccw" @click="takeResume">
          Resume from {{ timecode(resumeOffer) }}
        </UButton>
        <UButton
          size="lg"
          color="neutral"
          variant="solid"
          icon="i-lucide-x"
          aria-label="Start from the beginning"
          @click="resumeOffer = null"
        />
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
