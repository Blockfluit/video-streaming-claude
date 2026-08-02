<script setup lang="ts">
/**
 * A horizontal shelf.
 *
 * Scrolls rather than wraps, so a row of forty does not push everything below
 * it off the page. The arrows appear on hover and only on the side there is
 * something to scroll to — an arrow that does nothing is worse than no arrow.
 */
defineProps<{
  title: string
  /** Hidden entirely when there is nothing in it; an empty shelf is noise. */
  empty?: boolean
  to?: string
}>()

const track = ref<HTMLElement | null>(null)
const atStart = ref(true)
const atEnd = ref(false)

function measure() {
  const el = track.value
  if (!el) return
  atStart.value = el.scrollLeft <= 2
  atEnd.value = el.scrollLeft + el.clientWidth >= el.scrollWidth - 2
}

function nudge(direction: -1 | 1) {
  const el = track.value
  if (!el) return
  // Not a fixed pixel count: a viewport-sized jump keeps the same rhythm on a
  // laptop and an ultrawide.
  el.scrollBy({ left: direction * el.clientWidth * 0.85, behavior: 'smooth' })
}

onMounted(() => {
  measure()
  window.addEventListener('resize', measure)
})
onBeforeUnmount(() => window.removeEventListener('resize', measure))
</script>

<template>
  <section v-if="!empty" class="group/row space-y-2">
    <div class="flex items-baseline gap-3 px-1">
      <h2 class="text-lg font-semibold tracking-tight text-(--ui-text-highlighted)">{{ title }}</h2>
      <ULink
        v-if="to"
        :to="to"
        class="text-xs text-(--ui-text-muted) transition-colors hover:text-white"
      >
        See all →
      </ULink>
    </div>

    <div class="relative">
      <div
        ref="track"
        class="no-scrollbar flex gap-3 overflow-x-auto scroll-smooth px-1 py-3"
        @scroll.passive="measure"
      >
        <slot />
      </div>

      <!--
        Both chevrons are `aria-hidden` and out of the tab order, deliberately.
        They duplicate scrolling the track already does by trackpad, wheel and
        arrow key, and they fade in on hover — so leaving them focusable made
        them **invisible tab stops**: a keyboard user landed on a control with
        `opacity: 0` and nothing to see. Decoration for the mouse, and nothing
        is lost by hiding them from anyone not using one.

        This is also what makes them exempt from the legibility audit's
        invisible-control rule, which exists to catch a `group-hover` with no
        `group` ancestor. A control reachable by neither keyboard nor screen
        reader is decoration; one that is reachable must be visible.
      -->
      <button
        v-show="!atStart"
        type="button"
        aria-hidden="true"
        tabindex="-1"
        class="absolute inset-y-3 left-0 z-2 grid w-10 place-items-center bg-gradient-to-r from-black/85 to-transparent opacity-0 transition-opacity group-hover/row:opacity-100"
        @click="nudge(-1)"
      >
        <UIcon name="i-lucide-chevron-left" class="size-6" />
      </button>
      <button
        v-show="!atEnd"
        type="button"
        aria-hidden="true"
        tabindex="-1"
        class="absolute inset-y-3 right-0 z-2 grid w-10 place-items-center bg-gradient-to-l from-black/85 to-transparent opacity-0 transition-opacity group-hover/row:opacity-100"
        @click="nudge(1)"
      >
        <UIcon name="i-lucide-chevron-right" class="size-6" />
      </button>
    </div>
  </section>
</template>
