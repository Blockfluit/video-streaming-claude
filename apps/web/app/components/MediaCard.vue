<script setup lang="ts">
/**
 * One tile on a shelf — a video or a collection.
 *
 * Artwork comes from the API's image routes, which revalidate rather than
 * caching for a fixed time, so replacing a poster shows up immediately. A
 * missing image is normal (nothing probed yet, or no poster chosen), so the
 * fallback is part of the design rather than an error path.
 */
const props = defineProps<{
  to: string
  title: string
  imageUrl?: string | null
  subtitle?: string | null
  /** 0–100; renders a resume bar along the bottom when above zero. */
  progress?: number
  width?: number | null
  height?: number | null
  badge?: string | null
  /**
   * `poster` is the 2:3 artwork every card shows. `still` is 16:9, for the few
   * places a wide frame is the point.
   *
   * This prop existed for a long time and **no caller ever passed it**, so every
   * card in the app rendered 16:9 and the 2:3 half of the design was dead code.
   * Posters are the default now, which is what makes a shelf read as a shelf.
   */
  shape?: 'still' | 'poster'
}>()

const broken = ref(false)
const showImage = computed(() => Boolean(props.imageUrl) && !broken.value)
</script>

<template>
  <NuxtLink :to="to" class="group block shrink-0">
    <!--
      Hover is a border, not something laid over the picture.

      There used to be a circular glyph in the middle of the tile — a play or an
      info icon — which covered the one thing a card exists to show, on the card
      you were looking hardest at. An accent ring says the same thing from the
      edge. `focus-visible` matches it so a keyboard lands somewhere obvious.
    -->
    <div
      class="card-lift relative overflow-hidden rounded-md bg-(--ui-bg-elevated) ring-1 ring-(--ui-border) transition-shadow group-hover:ring-2 group-hover:ring-(--ui-primary) group-focus-visible:ring-2 group-focus-visible:ring-(--ui-primary)"
      :class="shape === 'still' ? 'aspect-video' : 'aspect-2/3'"
    >
      <img
        v-if="showImage"
        :src="imageUrl!"
        :alt="title"
        loading="lazy"
        class="size-full object-cover"
        @error="broken = true"
      >
      <div v-else class="size-full grid place-items-center text-(--ui-text-dimmed)">
        <UIcon name="i-lucide-clapperboard" class="size-10" />
      </div>

      <!-- Keeps the title legible over a bright frame without dimming the art. -->
      <div class="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/80 to-transparent" />

      <div class="absolute top-2 right-2 flex gap-1">
        <!--
          `text-white` is load-bearing. `variant="solid"` supplies a light
          background *and the dark text to sit on it*, and overriding only the
          background with `bg-black/70` left that dark text on a near-black
          chip — 1.14:1, which is not a legible badge, it is a smudge.
        -->
        <UBadge v-if="badge" color="neutral" variant="solid" size="sm" class="bg-black/70 text-white">
          {{ badge }}
        </UBadge>
        <QualityBadge :width="width" :height="height" />
      </div>

      <!-- The resume bar. Absent at zero rather than drawn empty. -->
      <div v-if="progress" class="absolute inset-x-0 bottom-0 h-[3px] bg-white/25">
        <div class="h-full bg-(--ui-primary)" :style="{ width: `${progress}%` }" />
      </div>
    </div>

    <p class="mt-2 truncate text-sm font-medium text-(--ui-text-highlighted) group-hover:text-white">
      {{ title }}
    </p>
    <p v-if="subtitle" class="truncate text-xs text-(--ui-text-muted)">{{ subtitle }}</p>
  </NuxtLink>
</template>
