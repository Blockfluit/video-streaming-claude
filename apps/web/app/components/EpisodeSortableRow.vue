<script setup lang="ts">
import { useSortable } from '@dnd-kit/vue/sortable'

/**
 * One episode in the collection editor's season list, draggable by any pointer.
 *
 * This exists as a component because `useSortable` is a composable and the
 * rows are a `v-for` — a composable cannot be called in a loop, so each row
 * has to be its own instance. The markup is the row that used to live inline
 * in `admin/collections/[slug].vue`.
 *
 * The old implementation was HTML5 `draggable` plus `dragstart`/`dragover`/
 * `drop`, which fires **nothing at all** from a finger: reordering episodes
 * and moving them between seasons — the thing that page is for — simply did
 * not exist on a phone, with nothing on screen saying so. dnd-kit drives its
 * `PointerSensor` from Pointer Events, which cover mouse, touch and pen with
 * one code path, so the gesture a test drives with a mouse is the gesture a
 * thumb performs.
 *
 * Its `KeyboardSensor` is in the default set too, which is how a keyboard
 * moves a row *between* seasons. The chevrons below are the simpler path for
 * the common case — one place, one step — and they work by tap as well.
 */
interface SortableVideo {
  id: string
  title: string
  state: string
  width: number | null
  height: number | null
}

const props = defineProps<{
  video: SortableVideo
  /** Position within its season, which is what dnd-kit sorts on. */
  index: number
  /** The season's stable key. Sharing one lets a row cross between them. */
  group: string
  /** So the chevrons can stop at the ends rather than doing nothing. */
  count: number
}>()

const emit = defineEmits<{ move: [direction: -1 | 1] }>()

const element = ref<HTMLElement | null>(null)

const { isDragging } = useSortable({
  id: () => props.video.id,
  index: () => props.index,
  group: () => props.group,
  element,
  type: 'episode',
  // Only other episodes, so a row cannot be dropped onto some unrelated
  // sortable that happens to be on the page later.
  accept: ['episode'],
})
</script>

<template>
  <!--
    Wrapping, because the row does not fit a phone and never did: a grip, an
    index, a 64px still, a title, two badges and the controls come to well over
    the 343px a 375px screen leaves, and nothing here shrank — the row simply
    ran off the side of the screen, taking the controls with it. Below `sm` the
    identifying half keeps the first line and everything you can press moves to
    a second.
  -->
  <li
    ref="element"
    class="flex touch-none flex-wrap items-center gap-x-3 gap-y-2 rounded-md p-2 transition-opacity"
    :class="isDragging ? 'opacity-40' : 'cursor-grab hover:bg-(--ui-bg-elevated) active:cursor-grabbing'"
  >
    <!-- The handle is decorative: the whole row is draggable, and a grip you
         must hit exactly is worse than one you cannot miss. -->
    <UIcon
      name="i-lucide-grip-vertical"
      aria-hidden="true"
      class="size-4 shrink-0 text-(--ui-text-dimmed)"
    />
    <span class="w-6 shrink-0 text-right text-xs tabular-nums text-(--ui-text-dimmed)">
      {{ index + 1 }}
    </span>
    <img
      :src="`/api/videos/${video.id}/banner`"
      alt=""
      loading="lazy"
      draggable="false"
      class="aspect-video w-16 shrink-0 rounded bg-(--ui-bg-accented) object-cover"
    >
    <span class="min-w-0 grow truncate text-sm">{{ video.title }}</span>

    <!--
      One group, so the badges and the controls wrap together rather than
      breaking up across two lines in whatever order they happen to fit.
    -->
    <div class="ml-auto flex items-center gap-2">
      <UBadge
        :color="video.state === 'PUBLISHED' ? 'success' : 'neutral'"
        variant="subtle"
        size="sm"
      >
        {{ video.state }}
      </UBadge>
      <QualityBadge :width="video.width" :height="video.height" />

      <!--
        The way to reorder without dragging anything.

        Dragging is a fine gesture with a pointer and a poor one on a phone,
        where the thing you are dragging is under your thumb and the list scrolls
        under it. These do the same move in one tap, go through the same request,
        and are the reason this list is reachable from a keyboard at all in the
        common case.
      -->
      <UButton
        size="xs"
        color="neutral"
        variant="subtle"
        icon="i-lucide-chevron-up"
        class="tap justify-center"
        :disabled="index === 0"
        :aria-label="`Move ${video.title} up`"
        @click="emit('move', -1)"
      />
      <UButton
        size="xs"
        color="neutral"
        variant="subtle"
        icon="i-lucide-chevron-down"
        class="tap justify-center"
        :disabled="index === count - 1"
        :aria-label="`Move ${video.title} down`"
        @click="emit('move', 1)"
      />

      <UButton
        :to="`/admin/videos/${video.id}`"
        size="xs"
        color="neutral"
        variant="subtle"
      >
        Edit
      </UButton>
    </div>
  </li>
</template>
