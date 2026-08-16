<script setup lang="ts">
/**
 * The history list, waiting.
 *
 * Mirrors that page's row: a growing title/subtitle block, the fixed `w-40`
 * progress cell and the fixed `w-24` timecode, separated by the same
 * `divide-y`. The two fixed columns are what make the placeholder recognisable
 * — a stack of full-width bars could be any list in the app.
 *
 * A `<ul>` of `<li>`s rather than plain divs, because that is what it stands in
 * for and a screen reader that reaches it mid-swap should find the same
 * structure it is about to get.
 */
withDefaults(defineProps<{ count?: number }>(), { count: 8 })
</script>

<template>
  <ul class="divide-y divide-(--ui-border)">
    <!--
      Laid out exactly like the history row it stands in for, phone rules
      included. A placeholder that reflows differently from its content is a
      layout shift on every load, which is the one thing a skeleton exists to
      prevent.
    -->
    <li v-for="index in count" :key="index" class="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <div class="min-w-0 grow">
        <div class="skeleton h-5 w-2/5" />
        <div class="skeleton mt-1.5 h-4 w-1/4" />
      </div>

      <div class="order-last w-full sm:order-none sm:w-40 sm:shrink-0">
        <div class="skeleton h-1.5 rounded-full" />
      </div>

      <div class="w-16 shrink-0 sm:w-24">
        <div class="skeleton ml-auto h-4 w-14" />
      </div>
    </li>
  </ul>
</template>
