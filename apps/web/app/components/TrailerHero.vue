<script setup lang="ts">
/**
 * The full-bleed hero: artwork, and a trailer that fades in over it.
 *
 * Everything YouTube-shaped in this app lives here. The pages decide *which*
 * trailer and *which* picture — those are library questions, answered by
 * `app/utils/hero.ts` and `trailerYoutubeIdFor` — and this owns the rest: the
 * scrims, the delay, the iframe, and taking it all down again.
 *
 * The trailer is deliberately not part of the server-rendered page. Whether it
 * should exist at all depends on `matchMedia` and `navigator.connection`,
 * neither of which exists in Nitro, so it is created on mount or never.
 */
import { YOUTUBE_EMBED_ORIGIN, youtubeEmbedUrl } from '@video/shared'

const props = withDefaults(
  defineProps<{
    title: string
    eyebrow?: string | null
    meta?: string | null
    description?: string | null
    /** Already resolved by the caller; null means there is no artwork at all. */
    imageUrl?: string | null
    /** Already resolved through the inheritance rule. */
    trailerYoutubeId?: string | null
    /** Long enough to read the title before anything moves. */
    delayMs?: number
  }>(),
  { eyebrow: null, meta: null, description: null, imageUrl: null, trailerYoutubeId: null, delayMs: 2000 },
)

const showTrailer = ref(false)
const muted = ref(true)
const iframe = ref<HTMLIFrameElement | null>(null)
let timer: ReturnType<typeof setTimeout> | undefined

const embedSrc = computed(() =>
  props.trailerYoutubeId
    ? youtubeEmbedUrl(props.trailerYoutubeId, {
      autoplay: true,
      mute: muted.value,
      loop: true,
      controls: false,
      jsApi: true,
      // Only readable in a browser, which is the other reason this is client-only.
      origin: window.location.origin,
    })
    : null,
)

onMounted(() => {
  if (!props.trailerYoutubeId) return
  if (!shouldAutoplayTrailer(readMotionEnvironment())) return

  timer = setTimeout(() => {
    showTrailer.value = true
  }, props.delayMs)
})

// Navigating away inside the delay would otherwise mount an iframe onto a
// component that no longer exists.
onBeforeUnmount(() => clearTimeout(timer))

/**
 * Unmutes in place rather than reloading with `mute=0`.
 *
 * Re-rendering the iframe restarts the trailer from the beginning, which reads
 * as a bug — you asked for sound and lost your place. `enablejsapi=1` and an
 * `origin` are in the embed URL exactly so this message can be sent.
 */
function toggleSound(): void {
  const player = iframe.value?.contentWindow
  if (!player) return

  const command = muted.value ? 'unMute' : 'mute'
  player.postMessage(JSON.stringify({ event: 'command', func: command, args: [] }), YOUTUBE_EMBED_ORIGIN)
  muted.value = !muted.value
}

/** Unmounts rather than pauses: that stops the audio *and* the network. */
function stop(): void {
  clearTimeout(timer)
  showTrailer.value = false
  muted.value = true
}
</script>

<template>
  <!-- Full-bleed, and it runs under the transparent header on purpose. -->
  <section class="relative h-[58vh] min-h-100 w-full overflow-hidden">
    <img v-if="imageUrl" :src="imageUrl" alt="" class="size-full object-cover">
    <div v-else class="size-full bg-(--ui-bg-elevated)" />

    <!--
      The trailer sits over the artwork rather than replacing it, so the fade
      has something to fade from and a slow embed never leaves a black hole.

      `pointer-events-none` is load-bearing: an iframe stretched across the
      hero swallows every click meant for the Play button underneath, and
      `tabindex="-1"` keeps it out of the tab order for the same reason.
    -->
    <ClientOnly>
      <div
        v-if="showTrailer && embedSrc"
        class="pointer-events-none absolute inset-0 transition-opacity duration-700"
      >
        <iframe
          ref="iframe"
          :src="embedSrc"
          :title="`Trailer for ${title}`"
          tabindex="-1"
          allow="autoplay; encrypted-media"
          referrerpolicy="strict-origin-when-cross-origin"
          class="pointer-events-none absolute top-1/2 left-1/2 aspect-video w-[178vh] min-w-full -translate-x-1/2 -translate-y-1/2 border-0"
        />
      </div>
    </ClientOnly>

    <!--
      Three scrims, written as real gradients rather than utilities so they
      interpolate to `--ui-bg` itself. The first pass hardcoded #08080a, so
      when the page background moved the fade stopped landing on it and the
      artwork ended on a visible horizontal seam.
    -->
    <div
      class="pointer-events-none absolute inset-0"
      style="background: linear-gradient(to right, var(--ui-bg) 0%, color-mix(in srgb, var(--ui-bg) 78%, transparent) 42%, transparent 72%)"
    />
    <div
      class="pointer-events-none absolute inset-x-0 bottom-0 h-1/2"
      style="background: linear-gradient(to top, var(--ui-bg) 0%, color-mix(in srgb, var(--ui-bg) 55%, transparent) 55%, transparent 100%)"
    />

    <div class="absolute inset-0 flex items-center">
      <div class="page-shell w-full">
        <div class="rise max-w-xl space-y-4">
          <!--
            The eyebrow is set in muted text with a red rule beside it rather
            than in red type. Red on near-black passes WCAG and still reads
            poorly at 12px, which is the whole reason that pass exists.
          -->
          <p
            v-if="eyebrow"
            class="flex items-center gap-2 text-xs font-semibold tracking-[0.2em] text-(--ui-text-muted) uppercase"
          >
            <span aria-hidden="true" class="h-3 w-0.5 rounded-full bg-(--ui-primary)" />
            {{ eyebrow }}
          </p>

          <h1 class="text-4xl font-bold tracking-tight text-white sm:text-6xl">{{ title }}</h1>

          <p v-if="meta" class="text-sm text-(--ui-text-muted)">{{ meta }}</p>
          <p v-if="description" class="line-clamp-3 text-(--ui-text-muted)">{{ description }}</p>

          <div class="flex flex-wrap items-center gap-3 pt-2">
            <slot />
          </div>
        </div>
      </div>
    </div>

    <!--
      Mounted with `v-if` rather than revealed on hover. A control at
      `opacity: 0` is clickable by a test and invisible to a person, which is
      the exact bug `visible.spec.ts` exists to catch.
    -->
    <div v-if="showTrailer" class="absolute right-4 bottom-4 flex items-center gap-2 sm:right-8">
      <UButton
        color="neutral"
        variant="solid"
        size="sm"
        :icon="muted ? 'i-lucide-volume-x' : 'i-lucide-volume-2'"
        :aria-label="muted ? 'Unmute the trailer' : 'Mute the trailer'"
        @click="toggleSound"
      />
      <UButton
        color="neutral"
        variant="solid"
        size="sm"
        icon="i-lucide-x"
        aria-label="Stop the trailer"
        @click="stop"
      />
    </div>
  </section>
</template>
