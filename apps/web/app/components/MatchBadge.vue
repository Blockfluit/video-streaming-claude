<script setup lang="ts">
/**
 * The "% Match" badge, fed by the per-caller `matchScore` a video's or
 * collection's own stats/progress read already carries. Renders **nothing**
 * when the score is absent — a viewer who hasn't watched enough yet sees no
 * badge at all, never a number computed from too little.
 */
const props = defineProps<{
  score?: number | null
}>()
</script>

<template>
  <!--
    `primary`, not `neutral` like QualityBadge: this is a claim about
    relevance to the viewer, not a technical fact about the file.
  -->
  <UBadge v-if="props.score != null" color="primary" variant="subtle" size="sm">
    {{ props.score }}% Match
  </UBadge>
</template>
