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
  /** `poster` is 2:3 for collections; the default 16:9 suits a video still. */
  shape?: 'still' | 'poster'
  /**
   * What the card does when clicked, which is not the same everywhere: a
   * Continue Watching tile resumes playback, while a browse or My List tile
   * opens a page describing the thing. Promising a play glyph and delivering a
   * page of text is a small lie that makes the app feel slow.
   */
  action?: 'play' | 'open'
}>()

const broken = ref(false)
const showImage = computed(() => Boolean(props.imageUrl) && !broken.value)
</script>

<template>
  <NuxtLink :to="to" class="group block shrink-0">
    <div
      class="card-lift relative overflow-hidden rounded-md bg-(--ui-bg-elevated) ring-1 ring-(--ui-border)"
      :class="shape === 'poster' ? 'aspect-2/3' : 'aspect-video'"
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

      <!-- Appears on hover; the whole card is the link, so this is decoration. -->
      <div
        class="absolute inset-0 grid place-items-center opacity-0 transition-opacity duration-200 group-hover:opacity-100"
      >
        <span class="grid size-11 place-items-center rounded-full bg-white/95 shadow-lg">
          <UIcon
            v-if="action === 'play'"
            name="i-lucide-play"
            class="size-5 text-black translate-x-px"
          />
          <UIcon v-else name="i-lucide-info" class="size-5 text-black" />
        </span>
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
