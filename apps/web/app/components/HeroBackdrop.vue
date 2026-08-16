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

/**
 * The moment the trailer becomes visible — not when it was asked for.
 *
 * The home hero rotates on a fixed interval, and a YouTube embed measured here
 * takes **five to nine seconds** just to fire `load`; the turn is ten. So the
 * entry was changing at about the moment its trailer became watchable, and the
 * page looked exactly as if no trailer ever played. The rotation starts an
 * entry's turn from this instead, so a slow embed costs a longer turn rather
 * than the whole feature.
 */
const emit = defineEmits<{ revealed: [] }>()

const broken = ref(false)
const showImage = computed(() => Boolean(props.image) && !broken.value)

/* ---------------------------------------------------------------- trailer -- */

/**
 * The trailer starts itself, plays muted behind the page's text, and gives way
 * to the banner only when it cannot play.
 *
 * **It is not gated on permission to start, and that is the whole rule.** A
 * previous version held the iframe hidden until the player confirmed over
 * `postMessage` that it was playing, and unmounted it if no confirmation came
 * within four seconds. None ever came — the embed does not reliably answer — so
 * every viewer saw the banner and nothing else, on every title. The stub in the
 * browser suite answered dutifully, so it passed. Silence must therefore mean
 * "carry on"; only an error means stop.
 *
 * So: mount, and reveal shortly after the iframe loads. If the player *does*
 * speak up to say it is playing, reveal at that moment instead, which is
 * crisper. If it says it has failed, retreat to the banner.
 *
 * The three standing rules are unchanged and none of them is a preference:
 *
 * - **Muted.** A browser refuses to start an unmuted video nobody asked for, and
 *   it fails *silently* — the iframe loads and sits there. Sound belongs to the
 *   modal, which a person opened on purpose.
 * - **Not under `prefers-reduced-motion`.** A hero that begins moving on its own
 *   is precisely what that setting is about. The trailer stays available behind
 *   the modal's button, which is a deliberate act rather than an ambush.
 * - **No controls.** There is no play, mute or ✕ over the artwork; anyone who
 *   wants the trailer wants the dialog, and that button is in the page's own row.
 */

/**
 * The grace between the iframe loading and the crossfade.
 *
 * Not zero: at `load` the embed's document exists but has painted nothing, so
 * revealing straight away fades the banner into a black rectangle. Measured from
 * `load` rather than from mount, so a slow embed gets its own time instead of
 * spending a fixed budget on the network.
 */
const REVEAL_MS = 900

/** Whether the iframe exists at all, so nothing is requested before it does. */
const mounted = ref(false)
/** Whether it has anything worth showing yet. */
const revealed = ref(false)
const frame = ref<HTMLIFrameElement | null>(null)

const embedUrl = computed(() =>
  props.trailerId && mounted.value
    // `mounted` is only ever set on the client, so `location` is safe to read.
    ? youtubeEmbedUrl(props.trailerId, { origin: window.location.origin })
    : null,
)

let curtain: ReturnType<typeof setTimeout> | undefined
let unsubscribe: (() => void) | undefined

function stopTrailer(): void {
  clearTimeout(curtain)
  unsubscribe?.()
  unsubscribe = undefined
  revealed.value = false
  mounted.value = false
}

function reveal(): void {
  clearTimeout(curtain)
  if (revealed.value) return

  revealed.value = true
  emit('revealed')
}

/**
 * Bound to the iframe's `load`, because the embed is only reachable once its
 * document exists — and asked repeatedly from there, because at `load` the
 * player's own listener is not attached yet. See `subscribeToPlayer`.
 *
 * The reveal is armed here rather than at mount so that a trailer still stuck on
 * the network is not counted as showing.
 */
function onFrameLoad(): void {
  unsubscribe?.()
  unsubscribe = frame.value ? subscribeToPlayer(frame.value) : undefined

  clearTimeout(curtain)
  curtain = setTimeout(reveal, REVEAL_MS)
}

function onMessage(event: MessageEvent): void {
  if (!mounted.value) return

  const signal = readPlayerSignal(event.origin, event.data)

  // Better than the timer when it arrives, and nothing depends on it arriving.
  if (signal === 'playing') reveal()
  // The one thing that sends us back to the banner. It is also the answer to
  // "what if the video is gone" — YouTube's grey card is what would otherwise
  // be sitting there.
  else if (signal === 'failed') stopTrailer()
}

function startTrailer(): void {
  stopTrailer()

  if (!props.trailerId) return
  if (props.paused) return
  if (import.meta.server) return
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

  // And then nothing else happens until the iframe loads. An embed that never
  // loads never reveals, so a blocked host or a dead network leaves the banner
  // exactly where it is — the fallback falls out of the design rather than
  // needing a timer of its own to enforce it.
  mounted.value = true
}

onMounted(() => {
  window.addEventListener('message', onMessage)
  startTrailer()
})

onBeforeUnmount(() => {
  clearTimeout(curtain)
  unsubscribe?.()
  window.removeEventListener('message', onMessage)
})

// A client-side navigation swaps the prop on the same component instance, and
// `paused` goes up and down as the modal opens and closes.
watch(() => [props.trailerId, props.paused], startTrailer)

/**
 * `svh` rather than `vh`, everywhere it is a proportion of the screen: `vh` is
 * the *large* viewport height, which ignores a mobile browser's collapsing
 * address bar, so the hero is taller than the screen on first paint and the
 * page starts out scrolled by the height of the toolbar. `full` said this all
 * along and `wide` was simply missed — 58% of the large height on a 430×932
 * phone is 540px that the toolbar then covers and uncovers as you scroll.
 *
 * The proportions themselves step down on a phone. 58% of a tall, narrow
 * screen is a deep crop of a 16:9 backdrop — it reads worse *and* pushes the
 * first shelf off the bottom — and `min-h-100` (400px) would override the
 * percentage entirely at 375×812 anyway. `pt-28` is 112px of clearance for a
 * 64px header, which is 17% of a short screen spent on nothing; 80px clears it
 * with room to spare and gives the difference back to the picture.
 */
const band = computed(() => ({
  wide: 'h-[46svh] min-h-72 sm:h-[58svh] sm:min-h-100',
  tall: 'min-h-100 pt-20 pb-10 sm:min-h-140 sm:pt-28',
  full: 'min-h-[88svh] pt-20 pb-10 sm:pt-28',
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
      read as a deliberate flourish; by the time this runs the trailer has
      already loaded, and the same second reads as the page being slow.

      `opacity-0` is a hidden trailer that is *still loading or playing*, never a
      rejected one — a trailer that will not play is unmounted outright, so this
      layer never sits invisible holding a connection open.
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
        @load="onFrameLoad"
      />
    </div>

    <!--
      Two scrims. The bottom one is half the hero rather than a fixed height:
      on a short viewport a fixed value leaves the seam above the fold, which
      is exactly where it is most obvious.

      The first turns with the text — bottom-up on a phone, where the column
      spans the full width, and left-to-right above `sm`. See `.hero-side-scrim`
      in `main.css`; it is a class rather than an inline style because a media
      query cannot live in a `style` attribute.
    -->
    <div class="hero-side-scrim absolute inset-0" />
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
