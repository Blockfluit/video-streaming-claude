<script setup lang="ts">
/**
 * A tile standing in for a `MediaCard` that has not arrived.
 *
 * It mirrors that component's box exactly — the same aspect ratio, the same
 * `rounded-md` and `ring-1`, and two bars where the title and subtitle go — so
 * the real cards drop into the space the placeholders were already holding
 * rather than shoving the page around as they land. A skeleton of the wrong
 * height is worse than none: it promises a layout and then breaks it.
 *
 * `shape` matches `MediaCard`'s, and defaults the same way: 2:3 is what a shelf
 * is made of, and `still` is for the few places a wide frame is the point.
 *
 * Width is not set here, also like `MediaCard` — it comes from the parent, which
 * is `w-56 sm:w-64` on a shelf and `w-full` in a grid.
 */
defineProps<{ shape?: 'still' | 'poster' }>()
</script>

<template>
  <div class="shrink-0">
    <div
      class="skeleton ring-1 ring-(--ui-border)"
      :class="shape === 'still' ? 'aspect-video' : 'aspect-2/3'"
    />
    <!-- The title line, and the shorter subtitle line under it. -->
    <div class="skeleton mt-2 h-4 w-3/4" />
    <div class="skeleton mt-1.5 h-3 w-2/5" />
  </div>
</template>
