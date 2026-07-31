<script setup lang="ts">
import { qualityLabel } from '@video/shared'

/**
 * The resolution badge, fed by the shared helper so the rule lives in one
 * place. Renders **nothing** below 1080p rather than an empty chip or an "SD"
 * — a badge on every card draws attention to nothing.
 */
const props = defineProps<{
  width?: number | null
  height?: number | null
}>()

const label = computed(() => qualityLabel(props.width ?? null, props.height ?? null))
</script>

<template>
  <UBadge v-if="label" color="neutral" variant="solid" size="sm">{{ label }}</UBadge>
</template>
