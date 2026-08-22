<script setup lang="ts">
import { useDroppable } from '@dnd-kit/vue'

/**
 * A season's body, as somewhere an episode can be dropped.
 *
 * The rows are sortables and can be dropped onto each other, but **an empty
 * season has no rows**, and pulling an episode back out of a season is the
 * whole reason the "Not in a season" group is always rendered. Without a
 * droppable of its own, an empty group is a box you cannot drop into.
 *
 * Its id is the group's stable key, so the page can look the season up again
 * from the drop without threading anything else through.
 */
const props = defineProps<{ id: string }>()

const element = ref<HTMLElement | null>(null)

const { isDropTarget } = useDroppable({
  id: () => props.id,
  element,
  type: 'season',
  accept: ['episode'],
})
</script>

<template>
  <div ref="element">
    <slot :is-drop-target="isDropTarget" />
  </div>
</template>
