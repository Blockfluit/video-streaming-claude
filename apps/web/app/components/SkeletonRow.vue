<script setup lang="ts">
/**
 * A shelf standing in for a `MediaRow`.
 *
 * Same `space-y-2` section, same heading line, same `flex gap-3 … px-1 py-3`
 * track, so the shelves do not jump when the real ones replace them.
 *
 * `overflow-hidden` rather than `overflow-x-auto`: there is nothing here to
 * scroll to, and a scrollable region holding placeholders is a keyboard trap
 * offering nothing. Six cards is enough to run off the side of a wide screen,
 * which is the point — a shelf that ends halfway across reads as a short shelf
 * rather than as a loading one.
 */
withDefaults(defineProps<{ count?: number }>(), { count: 6 })
</script>

<template>
  <section class="space-y-2">
    <!-- Where the row's title goes. -->
    <div class="px-1">
      <div class="skeleton h-6 w-40" />
    </div>

    <div class="flex gap-3 overflow-hidden px-1 py-3">
      <SkeletonCard v-for="index in count" :key="index" class="w-56 sm:w-64" />
    </div>
  </section>
</template>
