<script setup lang="ts">
/**
 * One episode in a season's list.
 *
 * A wide row rather than a card because an episode is mostly *text* — you pick
 * one by reading what happens in it, which a 14rem tile has no room for. The
 * still is there to be recognised, not read, so it stays small.
 *
 * The whole row is the link and it goes straight to the player.
 *
 * The image is the **banner** — the one place in the app that shows one rather
 * than a poster. Inside a show you are choosing a moment, not a title, and a
 * wide frame of the episode says more about it than a 2:3 poster cut from the
 * same footage would.
 */
const props = defineProps<{
  to: string
  title: string
  imageUrl?: string | null
  /**
   * The row's place in the list being shown, 1-based — deliberately *not*
   * `orderIndex`.
   *
   * `orderIndex` looks like an episode number and is not one: the path parser
   * stores the number it read off the filename (`E01` → 1), while dragging an
   * episode in the admin UI rewrites the whole season 0-based. Rendering it
   * directly is how a first episode ends up labelled "E0", which is what the
   * real library did. A position always agrees with what is on the screen.
   */
  number?: number | null
  durationSec?: number | null
  description?: string | null
  /** 0–100. Renders a resume bar under the still when above zero. */
  progress?: number
  completed?: boolean
  /** The state chip, for an admin looking at a draft. Null when published. */
  badge?: string | null
  current?: boolean
  /**
   * The narrow build, for the rail beside the player rather than a page of its
   * own.
   *
   * A prop rather than a class the caller passes: the widths that have to shrink
   * sit on an *inner* element, which a class on the component root cannot reach.
   * At the full size the still alone is 16rem, which is most of a 22rem rail
   * before the title gets a pixel.
   *
   * The synopsis goes rather than being clamped shorter. Two lines of prose at
   * that width is four or five words a line, which reads as damage; the episode
   * page is where a description has room, and the rail is for finding the row.
   */
  dense?: boolean
}>()

const broken = ref(false)
const showImage = computed(() => Boolean(props.imageUrl) && !broken.value)

const rowClass = computed(() => (props.dense ? 'gap-3 p-2' : 'gap-4 p-3'))

/**
 * The number lifts a tier on the row that is playing.
 *
 * `--ui-text-dimmed` is the floor, and its 4.9:1 is measured against the page.
 * The current row is not on the page — it is on `--ui-bg-accented`, which is
 * lighter — and the same colour measures **4.4:1** there, under AA. Caught by
 * `visible.spec.ts` rather than reasoned about, which is the only way this is
 * ever caught: it is a legible-looking grey either way.
 *
 * Lifted only when current, so the ordinary rows on a collection page keep the
 * weighting they were designed with.
 */
const numberClass = computed(() => [
  props.dense ? 'w-4 pt-3 text-sm' : 'w-6 pt-6 text-lg',
  props.current ? 'text-(--ui-text-muted)' : 'text-(--ui-text-dimmed)',
])
/** Fixed rather than responsive: the rail is one width at every breakpoint. */
const stillClass = computed(() =>
  props.dense ? 'w-28' : 'w-40 sm:w-48 lg:w-64',
)
const titleClass = computed(() => (props.dense ? 'text-sm' : ''))
</script>

<template>
  <NuxtLink
    :to="to"
    class="group flex items-start rounded-lg transition-colors"
    :class="[rowClass, current ? 'bg-(--ui-bg-accented)' : 'hover:bg-(--ui-bg-elevated)']"
    :aria-current="current ? 'true' : undefined"
  >
    <span
      class="shrink-0 text-right font-semibold tabular-nums"
      :class="numberClass"
      aria-hidden="true"
    >{{ number ?? '' }}</span>

    <!--
      Wide enough to read as artwork rather than as a thumbnail. The banner is a
      16:9 frame of the episode and it was drawn at 8rem, which is a size that
      says "icon". The text still sits beside it, so a synopsis keeps its room.

      Hover is the ring, matching the cards. There was a play glyph in the middle
      of this frame, which covered the picture on the row you were pointing at.
    -->
    <div
      class="relative aspect-video shrink-0 overflow-hidden rounded-md bg-(--ui-bg-elevated) ring-1 ring-(--ui-border) transition-shadow group-hover:ring-2 group-hover:ring-(--ui-primary) group-focus-visible:ring-2 group-focus-visible:ring-(--ui-primary)"
      :class="stillClass"
    >
      <img
        v-if="showImage"
        :src="imageUrl!"
        alt=""
        loading="lazy"
        class="size-full object-cover"
        @error="broken = true"
      >
      <div v-else class="grid size-full place-items-center text-(--ui-text-dimmed)">
        <UIcon name="i-lucide-clapperboard" class="size-6" />
      </div>

      <!-- Absent at zero rather than drawn empty, like the cards. -->
      <div v-if="progress" class="absolute inset-x-0 bottom-0 h-[3px] bg-white/25">
        <div class="h-full bg-(--ui-primary)" :style="{ width: `${progress}%` }" />
      </div>
    </div>

    <div class="min-w-0 flex-1 space-y-1 py-0.5">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p class="font-medium text-(--ui-text-highlighted)" :class="titleClass">{{ title }}</p>
        <span
          v-if="runtime(durationSec)"
          class="text-(--ui-text-muted)"
          :class="dense ? 'text-xs' : 'text-sm'"
        >
          {{ runtime(durationSec) }}
        </span>
        <UBadge v-if="badge" color="warning" variant="subtle" size="sm">{{ badge }}</UBadge>
        <UIcon
          v-if="completed"
          name="i-lucide-check"
          class="size-4 text-(--ui-text-dimmed)"
          aria-label="Watched"
        />
      </div>
      <p v-if="description && !dense" class="line-clamp-2 text-sm text-(--ui-text-muted)">
        {{ description }}
      </p>
    </div>
  </NuxtLink>
</template>
