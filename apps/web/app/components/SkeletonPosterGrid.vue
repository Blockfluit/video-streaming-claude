<script setup lang="ts">
/**
 * The poster wall, waiting.
 *
 * Reuses `.poster-grid` rather than restating the columns, so it stays the same
 * wall as the one it stands in for — the whole reason that class was pulled out
 * of the three screens that had copied it.
 *
 * Twelve fills a laptop without covering a 4K screen in placeholders. The count
 * is a guess at how much is coming and is allowed to be wrong: too few and the
 * page grows as the real cards land, which is the ordinary behaviour of a list.
 */
withDefaults(defineProps<{ count?: number }>(), { count: 12 })
</script>

<template>
  <div class="poster-grid">
    <SkeletonCard v-for="index in count" :key="index" class="w-full" />
  </div>
</template>
