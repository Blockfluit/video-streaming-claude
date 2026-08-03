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
}>()

const broken = ref(false)
const showImage = computed(() => Boolean(props.imageUrl) && !broken.value)
</script>

<template>
  <NuxtLink
    :to="to"
    class="group flex items-start gap-4 rounded-lg p-3 transition-colors"
    :class="current ? 'bg-(--ui-bg-accented)' : 'hover:bg-(--ui-bg-elevated)'"
  >
    <span
      class="w-6 shrink-0 pt-6 text-right text-lg font-semibold tabular-nums text-(--ui-text-dimmed)"
      aria-hidden="true"
    >{{ number ?? '' }}</span>

    <!--
      Wide enough to read as artwork rather than as a thumbnail. The banner is a
      16:9 frame of the episode and it was drawn at 8rem, which is a size that
      says "icon". The text still sits beside it, so a synopsis keeps its room.

      Hover is the ring, matching the cards. There was a play glyph in the middle
      of this frame, which covered the picture on the row you were pointing at.
    -->
    <div class="relative aspect-video w-40 shrink-0 overflow-hidden rounded-md bg-(--ui-bg-elevated) ring-1 ring-(--ui-border) transition-shadow group-hover:ring-2 group-hover:ring-(--ui-primary) group-focus-visible:ring-2 group-focus-visible:ring-(--ui-primary) sm:w-48 lg:w-64">
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
        <p class="font-medium text-(--ui-text-highlighted)">{{ title }}</p>
        <span v-if="runtime(durationSec)" class="text-sm text-(--ui-text-muted)">
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
      <p v-if="description" class="line-clamp-2 text-sm text-(--ui-text-muted)">
        {{ description }}
      </p>
    </div>
  </NuxtLink>
</template>
