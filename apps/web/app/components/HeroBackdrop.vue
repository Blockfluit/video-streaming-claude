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
   * A YouTube id. The banner shows first and the trailer fades in over it after
   * a moment, the way a title page on a streaming service does.
   */
  trailerId?: string | null
}>()

const broken = ref(false)
const showImage = computed(() => Boolean(props.image) && !broken.value)

/* ---------------------------------------------------------------- trailer -- */

/**
 * The trailer starts itself, but only on terms the browser and the viewer both
 * allow.
 *
 * - **Muted.** Not a preference: a browser refuses to start an unmuted video
 *   nobody asked for, and it fails *silently* — the iframe loads and sits there.
 *   So the sound toggle is ours, and it starts from muted.
 * - **Not under `prefers-reduced-motion`.** A hero that begins moving on its own
 *   is precisely what that setting is about. The trailer stays available behind
 *   its button.
 * - **Nothing is requested from YouTube until it starts**, so a page someone
 *   passes through makes no third-party request at all.
 */
const DELAY_MS = 2000

const playing = ref(false)
const muted = ref(true)
/** Held back so the iframe — and the request it makes — does not exist yet. */
const mounted = ref(false)

const embedUrl = computed(() =>
  props.trailerId && mounted.value
    ? youtubeEmbedUrl(props.trailerId, { muted: muted.value })
    : null,
)

let timer: ReturnType<typeof setTimeout> | undefined

function stopTrailer(): void {
  clearTimeout(timer)
  playing.value = false
  mounted.value = false
  muted.value = true
}

function startTrailer(): void {
  if (!props.trailerId) return
  mounted.value = true
  playing.value = true
}

/**
 * Toggling sound reloads the iframe with a different `mute`, because the player
 * is only reachable through the YouTube JS API otherwise — a whole script to
 * load, for one control. The reload costs a restart of the trailer, which is
 * what someone turning the sound on generally wants anyway.
 */
function toggleSound(): void {
  muted.value = !muted.value
}

function scheduleTrailer(): void {
  clearTimeout(timer)
  stopTrailer()

  if (!props.trailerId) return
  if (import.meta.server) return
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

  timer = setTimeout(startTrailer, DELAY_MS)
}

onMounted(scheduleTrailer)
onBeforeUnmount(() => clearTimeout(timer))
// A client-side navigation swaps the prop on the same component instance.
watch(() => props.trailerId, scheduleTrailer)

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

      `aria-hidden` because it is decoration behind real content. Its controls
      below are the part anyone needs to reach.
    -->
    <div
      v-if="embedUrl"
      class="pointer-events-none absolute inset-0 transition-opacity duration-1000"
      :class="playing ? 'opacity-100' : 'opacity-0'"
      aria-hidden="true"
    >
      <!--
        Scaled past the frame so the 16:9 video covers a hero of any shape. A
        letterboxed trailer with bars down the sides of a full-height hero looks
        like a mistake; cropping is what the banner underneath already does.
      -->
      <iframe
        :src="embedUrl"
        class="absolute top-1/2 left-1/2 h-[56.25vw] min-h-full w-[177.78vh] min-w-full -translate-x-1/2 -translate-y-1/2"
        title=""
        frameborder="0"
        allow="autoplay; encrypted-media"
        referrerpolicy="strict-origin-when-cross-origin"
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
      The trailer's controls, and the only way to start one when
      `prefers-reduced-motion` has stopped it doing so itself. Real buttons with
      real labels, sitting above the scrim rather than over the artwork.

      They align to the page column, not to the window, which is why this is a
      full-width band around a `page-shell` rather than a `right-*` inset. The
      gutter grows from 1rem to 5rem across the breakpoints and then the shell
      starts centring inside `max-width: 110rem` — so a fixed inset matched the
      content on a phone and hung 1.5–5rem outside it on every desktop, drifting
      further the wider the screen got. Reusing the shell also keeps one
      definition of the gutter rather than a second copy to keep in sync.

      The band spans the hero, so it is `pointer-events-none` and each button
      takes pointer events back: an invisible full-width strip lying over the
      hero would otherwise swallow the clicks meant for Play underneath it,
      exactly as the iframe above does.
    -->
    <div v-if="trailerId" class="pointer-events-none absolute inset-x-0 bottom-6 z-1">
      <div class="page-shell flex w-full items-center justify-end gap-2">
        <template v-if="playing">
          <UButton
            size="sm"
            color="neutral"
            variant="subtle"
            class="pointer-events-auto"
            :icon="muted ? 'i-lucide-volume-x' : 'i-lucide-volume-2'"
            :aria-label="muted ? 'Unmute the trailer' : 'Mute the trailer'"
            @click="toggleSound"
          />
          <UButton
            size="sm"
            color="neutral"
            variant="subtle"
            class="pointer-events-auto"
            icon="i-lucide-x"
            aria-label="Stop the trailer"
            @click="stopTrailer"
          />
        </template>
        <UButton
          v-else
          size="sm"
          color="neutral"
          variant="subtle"
          class="pointer-events-auto"
          icon="i-lucide-clapperboard"
          aria-label="Play the trailer"
          @click="startTrailer"
        >
          Trailer
        </UButton>
      </div>
    </div>
  </section>
</template>
