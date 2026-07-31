<script setup lang="ts">
/**
 * A horizontal shelf. Scrolls rather than wrapping, so a row with forty entries
 * does not push everything below it off the page.
 */
defineProps<{
  title: string
  /** Hidden entirely when there is nothing in it — an empty shelf is noise. */
  empty?: boolean
  to?: string
}>()
</script>

<template>
  <section v-if="!empty" class="space-y-3">
    <div class="flex items-baseline gap-3">
      <h2 class="text-lg font-semibold">{{ title }}</h2>
      <ULink v-if="to" :to="to" class="text-sm text-(--ui-text-muted)">See all</ULink>
    </div>

    <div class="flex gap-4 overflow-x-auto pb-2 -mx-1 px-1">
      <slot />
    </div>
  </section>
</template>
