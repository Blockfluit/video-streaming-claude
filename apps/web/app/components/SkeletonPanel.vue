<script setup lang="ts">
/**
 * A bordered card standing in for one entry in a list of them — a request on
 * `/requests`, and anything else built from that same
 * `rounded-lg border bg-(--ui-bg-elevated) p-4` article.
 *
 * The border and surface are drawn for real rather than pulsed. They are the
 * part of the card that is already known: the shape of the list does not depend
 * on the answer, only its contents do, so only the contents are placeholders.
 * It also keeps the pulse off the one element with a border, which is what the
 * contrast audit measures.
 */
withDefaults(defineProps<{ count?: number }>(), { count: 3 })
</script>

<template>
  <div class="space-y-2">
    <div
      v-for="index in count"
      :key="index"
      class="rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-4"
    >
      <!-- The title line, with a shorter chip beside it where the status badge sits. -->
      <div class="flex flex-wrap items-center gap-2">
        <div class="skeleton h-5 w-48" />
        <div class="skeleton h-5 w-16 rounded-full" />
      </div>
      <div class="skeleton mt-2 h-4 w-32" />
      <div class="skeleton mt-3 h-4 w-3/5" />
    </div>
  </div>
</template>
