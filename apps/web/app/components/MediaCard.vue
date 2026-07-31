<script setup lang="ts">
/**
 * One tile on a shelf — a video or a collection.
 *
 * Artwork comes from the API's image routes, which revalidate rather than
 * caching for a fixed time, so replacing a poster shows up immediately. A
 * missing image is normal (nothing has been probed yet, or an admin has not
 * chosen one), so the fallback is part of the design rather than an error path.
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
}>()

const broken = ref(false)
const showImage = computed(() => Boolean(props.imageUrl) && !broken.value)
</script>

<template>
  <NuxtLink :to="to" class="group block w-44 shrink-0">
    <div
      class="relative aspect-video rounded-lg overflow-hidden bg-(--ui-bg-elevated) ring-1 ring-(--ui-border) group-hover:ring-(--ui-border-accented) transition"
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
        <UIcon name="i-lucide-film" class="size-8" />
      </div>

      <div class="absolute top-1.5 right-1.5 flex gap-1">
        <UBadge v-if="badge" color="neutral" variant="solid" size="sm">{{ badge }}</UBadge>
        <QualityBadge :width="width" :height="height" />
      </div>

      <!-- The resume bar. Absent at zero rather than drawn empty. -->
      <div v-if="progress" class="absolute inset-x-0 bottom-0 h-1 bg-black/40">
        <div class="h-full bg-(--ui-primary)" :style="{ width: `${progress}%` }" />
      </div>
    </div>

    <p class="mt-2 text-sm font-medium truncate group-hover:text-(--ui-primary)">{{ title }}</p>
    <p v-if="subtitle" class="text-xs text-(--ui-text-muted) truncate">{{ subtitle }}</p>
  </NuxtLink>
</template>
