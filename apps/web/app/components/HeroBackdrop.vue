<script setup lang="ts">
import { youtubeEmbedUrl } from '@video/shared'

/**
 * Artwork across the top of a page, with the content laid over it.
 *
 * Extracted from the home page once the title pages needed the same thing.
 * Three screens drawing their own scrims is how one of them ends up fading to
 * the wrong colour — which already happened here: the first version hardcoded
 * `#08080a`, and when the page background moved to `#0a0a0c` the artwork ended
 * on a visible horizontal seam.
 *
 * So the gradients are written as real `linear-gradient`s interpolating to
 * `var(--ui-bg)` itself rather than as utilities, and they live in one file.
 */
const props = defineProps<{
  /** Absent is normal — nothing probed yet, or no poster chosen. */
  image?: string | null
  /**
   * `wide` is the home hero. `tall` gives a collection page room for its
   * metadata while leaving its episode list near the fold — a list nobody can
   * see without scrolling is the thing that page is for, hidden.
   *
   * `full` is for a video's page, which has no such list: a standalone film has
   * no cast, no tags and no siblings, so a `tall` hero left its text stranded
   * mid-screen above a few hundred pixels of empty background. Filling the
   * viewport makes that a composition rather than a gap.
   */
  size?: 'wide' | 'tall' | 'full'
  /**
   * A YouTube id. Decoration: it starts itself, silently, and the page's own
   * `TrailerModal` is where anybody actually watches the thing.
   */
  trailerId?: string | null
  /**
   * Raised while the page is showing the trailer somewhere else — the modal.
   * Two copies of the same video playing at once is the obvious problem; the
   * quieter one is that the ambient copy keeps running behind a dialog nobody
   * can see it through, for as long as the dialog is open.
   */
  paused?: boolean
}>()

const broken = ref(false)
const showImage = computed(() => Boolean(props.image) && !broken.value)

/* ---------------------------------------------------------------- trailer -- */

/**
 * The trailer starts at once, and only reveals itself once it is actually
 * playing.
 *
 * It used to wait two seconds and then fade in regardless, which is wrong in the
 * one case that matters. When the video will not play — autoplay refused,
 * embedding disabled by its owner, the video pulled — YouTube paints its own
 * grey "Video unavailable" card, and *that* is what got faded across the
 * artwork. The banner underneath was always the intended fallback; nothing was
 * checking whether it was needed.
 *
 * So the iframe is mounted immediately but held at `opacity-0`, and the banner
 * stays up until the player says it is playing. If it never says so, the iframe
 * is taken away again and nobody sees anything but the banner. See
 * `utils/youtube-embed.ts` for how that conversation works.
 *
 * The other two rules are unchanged and still not preferences:
 *
 * - **Muted.** A browser refuses to start an unmuted video nobody asked for, and
 *   it fails *silently* — the iframe loads and sits there. Sound belongs to the
 *   modal, which a person opened on purpose.
 * - **Not under `prefers-reduced-motion`.** A hero that begins moving on its own
 *   is precisely what that setting is about. The trailer stays available behind
 *   the modal's button, which is a deliberate act rather than an ambush.
 */

/**
 * How long the player gets to confirm before the banner wins.
 *
 * Generous on purpose: it covers loading the embed over a slow connection as
 * well as the failures, and the cost of being wrong in that direction is only
 * that a working trailer is dropped a moment before it would have started.
 */
const CONFIRM_MS = 4000

/** Whether the iframe exists at all, so nothing is requested before it does. */
const mounted = ref(false)
/** Whether it has earned the right to be seen. */
const revealed = ref(false)
const frame = ref<HTMLIFrameElement | null>(null)

const embedUrl = computed(() =>
  props.trailerId && mounted.value
    // `mounted` is only ever set on the client, so `location` is safe to read.
    ? youtubeEmbedUrl(props.trailerId, { origin: window.location.origin })
    : null,
)

let deadline: ReturnType<typeof setTimeout> | undefined

function stopTrailer(): void {
  clearTimeout(deadline)
  revealed.value = false
  mounted.value = false
}

/**
 * The embed posts nothing until it is subscribed to, and it is only reachable
 * once its document exists — so this is bound to the iframe's `load` rather than
 * fired alongside the mount.
 */
function subscribe(): void {
  frame.value?.contentWindow?.postMessage(LISTENING, EMBED_ORIGIN)
}

function onMessage(event: MessageEvent): void {
  if (!mounted.value) return

  const signal = readPlayerSignal(event.origin, event.data)
  if (signal === 'playing') {
    clearTimeout(deadline)
    revealed.value = true
  }
  // Told rather than timed out: an error arrives immediately, and waiting the
  // full deadline to act on it would leave the grey card fading in behind a
  // reveal that is about to be cancelled anyway.
  else if (signal === 'failed') stopTrailer()
}

function startTrailer(): void {
  stopTrailer()

  if (!props.trailerId) return
  if (props.paused) return
  if (import.meta.server) return
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

  mounted.value = true
  deadline = setTimeout(() => {
    // Still nothing. Whatever the reason, the banner is the answer — and the
    // iframe goes rather than sitting there invisible, holding a connection to
    // a third party for a video this page has given up on.
    if (!revealed.value) stopTrailer()
  }, CONFIRM_MS)
}

onMounted(() => {
  window.addEventListener('message', onMessage)
  startTrailer()
})

onBeforeUnmount(() => {
  clearTimeout(deadline)
  window.removeEventListener('message', onMessage)
})

// A client-side navigation swaps the prop on the same component instance, and
// `paused` goes up and down as the modal opens and closes.
watch(() => [props.trailerId, props.paused], startTrailer)

/**
 * `svh` rather than `vh` for the full-height hero: `vh` ignores a mobile
 * browser's collapsing address bar, so the hero is taller than the screen on
 * first paint and the page starts out scrolled by the height of the toolbar.
 */
const band = computed(() => ({
  wide: 'h-[58vh] min-h-100',
  tall: 'min-h-125 pt-28 pb-10 sm:min-h-140',
  full: 'min-h-[88svh] pt-28 pb-10',
}[props.size ?? 'wide']))

/** Home centres its hero; a title page sits its text on the floor of the frame. */
const anchor = computed(() => (props.size === 'wide' || !props.size ? 'items-center' : 'items-end'))

watch(
  () => props.image,
  () => {
    // A client-side navigation swaps the src on the same element. Without this
    // reset, one broken poster hides every subsequent one.
    broken.value = false
  },
)
</script>

<template>
  <!-- Full-bleed, and it runs under the transparent header on purpose. -->
  <!--
    `flex flex-col` so the content wrapper below can actually grow. A percentage
    height inside a section sized by `min-height` has no definite parent to
    resolve against, so `h-full` collapses to the content and `items-end` does
    nothing — which left a title page's hero text stranded at the top of a tall
    band of artwork.
  -->
  <section class="relative flex w-full flex-col overflow-hidden" :class="band">
    <img
      v-if="showImage"
      :src="image!"
      alt=""
      class="absolute inset-0 size-full object-cover"
      @error="broken = true"
    >

    <!--
      The trailer, over the banner rather than instead of it.

      `pointer-events-none` is load-bearing: an iframe swallows every click that
      lands on it, so without this the Play button underneath stops responding
      the moment the trailer fades in — and the page looks fine while doing it.

      `aria-hidden` because it is decoration behind real content. The Trailer
      button in the page's own button row is the part anyone needs to reach.

      The crossfade is short. A full second was the tail of a two-second wait and
      read as a deliberate flourish; now that the trailer is already playing when
      this runs, the same second reads as the page being slow.
    -->
    <div
      v-if="embedUrl"
      class="pointer-events-none absolute inset-0 transition-opacity duration-300"
      :class="revealed ? 'opacity-100' : 'opacity-0'"
      aria-hidden="true"
    >
      <!--
        Scaled past the frame so the 16:9 video covers a hero of any shape. A
        letterboxed trailer with bars down the sides of a full-height hero looks
        like a mistake; cropping is what the banner underneath already does.
      -->
      <iframe
        ref="frame"
        :src="embedUrl"
        class="absolute top-1/2 left-1/2 h-[56.25vw] min-h-full w-[177.78vh] min-w-full -translate-x-1/2 -translate-y-1/2"
        title=""
        frameborder="0"
        allow="autoplay; encrypted-media"
        referrerpolicy="strict-origin-when-cross-origin"
        @load="subscribe"
      />
    </div>

    <!--
      Two scrims. The bottom one is half the hero rather than a fixed height:
      on a short viewport a fixed value leaves the seam above the fold, which
      is exactly where it is most obvious.
    -->
    <div
      class="absolute inset-0"
      style="background: linear-gradient(to right, var(--ui-bg) 0%, color-mix(in srgb, var(--ui-bg) 78%, transparent) 42%, transparent 72%)"
    />
    <div
      class="absolute inset-x-0 bottom-0 h-1/2"
      style="background: linear-gradient(to top, var(--ui-bg) 0%, color-mix(in srgb, var(--ui-bg) 55%, transparent) 55%, transparent 100%)"
    />

    <div class="relative flex flex-1" :class="anchor">
      <div class="page-shell w-full">
        <slot />
      </div>
    </div>

    <!--
      There were trailer controls here — a play button, a mute toggle and a ✕ —
      in a band along the floor of the hero. They are gone, and the reason is
      worth keeping: they were controls for something nobody was watching. The
      ambient trailer is scrimmed, cropped and sitting under a page's worth of
      text, so a sound toggle on it offered audio for a video you cannot see.
      Anyone who wants the trailer wants the trailer, and that is the button in
      the page's own row, next to My List.
    -->
  </section>
</template>
