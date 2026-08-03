<script setup lang="ts">
/**
 * One episode in a season's list.
 *
 * A wide row rather than a card because an episode is mostly *text* — you pick
 * one by reading what happens in it, which a 14rem tile has no room for. The
 * still is there to be recognised, not read, so it stays small.
 *
 * The whole row is the link and it goes straight to the player, so the play
 * glyph over the still is an honest promise rather than decoration — which is
 * what it was while the row opened a page of text instead.
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

    <div class="relative aspect-video w-32 shrink-0 overflow-hidden rounded-md bg-(--ui-bg-elevated) ring-1 ring-(--ui-border) sm:w-40">
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

      <div class="absolute inset-0 grid place-items-center opacity-0 transition-opacity duration-200 group-hover:opacity-100">
        <span class="grid size-9 place-items-center rounded-full bg-white/95 shadow-lg">
          <UIcon name="i-lucide-play" class="size-4 translate-x-px text-black" />
        </span>
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
