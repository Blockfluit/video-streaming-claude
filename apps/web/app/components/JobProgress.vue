<script setup lang="ts">
/**
 * One job's state, used by the jobs page and by a video's editor.
 *
 * Shared rather than written twice because the first version was written twice
 * and got the units wrong: `progress` is a **fraction 0..1** from ffmpeg, and
 * the jobs page rendered it straight into `width: ${progress}%`. A job at 14%
 * therefore drew a 0.14%-wide bar and printed `Math.round(0.14)` = 0% — so the
 * bar read 0 for the first half of an encode, flipped to 1 once the fraction
 * passed 0.5, and never showed anything in between.
 */
export interface Job {
  id: string
  type: string
  status: string
  progress: number | null
  etaSeconds: number | null
  error: string | null
  logTail: string | null
  createdAt: string
  finishedAt: string | null
  video?: { id: string, title: string } | null
}

const props = defineProps<{ job: Job, showVideo?: boolean }>()
const emit = defineEmits<{ act: [job: Job, action: 'cancel' | 'retry'] }>()

const TONE: Record<string, string> = {
  QUEUED: 'neutral',
  RUNNING: 'primary',
  SUCCEEDED: 'success',
  FAILED: 'error',
  CANCELLED: 'warning',
}

const running = computed(() => props.job.status === 'RUNNING')
const pending = computed(() => running.value || props.job.status === 'QUEUED')

/** The fraction, as a percentage. This is the conversion that was missing. */
const percent = computed(() => Math.min(100, Math.max(0, (props.job.progress ?? 0) * 100)))

const eta = computed(() => {
  const seconds = props.job.etaSeconds
  if (seconds === null || seconds <= 0) return null
  if (seconds < 60) return `${seconds}s left`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s left`
})
</script>

<template>
  <div class="rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-4">
    <div class="flex flex-wrap items-center gap-3">
      <UBadge :color="(TONE[job.status] as any) ?? 'neutral'" variant="subtle">
        {{ job.status }}
      </UBadge>
      <span class="text-sm font-medium">{{ job.type }}</span>
      <NuxtLink
        v-if="showVideo && job.video"
        :to="`/admin/videos/${job.video.id}`"
        class="truncate text-sm text-(--ui-text-muted) hover:text-(--ui-text-highlighted)"
      >
        {{ job.video.title }}
      </NuxtLink>

      <div class="ml-auto flex gap-2">
        <UButton
          v-if="pending"
          size="xs"
          color="error"
          variant="subtle"
          @click="emit('act', job, 'cancel')"
        >
          Cancel
        </UButton>
        <UButton
          v-if="job.status === 'FAILED' || job.status === 'CANCELLED'"
          size="xs"
          color="neutral"
          variant="subtle"
          @click="emit('act', job, 'retry')"
        >
          Retry
        </UButton>
      </div>
    </div>

    <div v-if="running" class="mt-3">
      <div class="h-1.5 overflow-hidden rounded-full bg-(--ui-bg-accented)">
        <div
          class="h-full bg-(--ui-primary) transition-[width] duration-500"
          :style="{ width: `${percent}%` }"
        />
      </div>
      <p class="mt-1 flex flex-wrap gap-x-2 text-xs text-(--ui-text-muted)">
        <span class="tabular-nums">{{ percent.toFixed(1) }}%</span>
        <span v-if="eta">· {{ eta }}</span>
        <!--
          `-movflags +faststart` makes ffmpeg rewrite the file after reaching
          100%, so the bar sits there for a moment. Saying so stops it reading
          as a hang.
        -->
        <span v-if="percent >= 99.5">· finalising the file</span>
      </p>
    </div>

    <p v-if="job.error" class="mt-2 font-mono text-xs break-all text-red-400">{{ job.error }}</p>

    <!--
      ffmpeg's own stderr, collapsed. It is the thing you actually want when a
      conversion looks stuck, and the bar cannot tell you a source has a broken
      timestamp or that it fell back to a different decoder.
    -->
    <details v-if="job.logTail" class="mt-3 group">
      <summary
        class="cursor-pointer list-none text-xs text-(--ui-text-muted) select-none hover:text-(--ui-text-highlighted)"
      >
        <UIcon
          name="i-lucide-chevron-right"
          class="mr-1 inline size-3 transition-transform group-open:rotate-90"
        />
        ffmpeg output
      </summary>
      <pre
        class="mt-2 max-h-64 overflow-auto rounded-md bg-(--ui-bg) p-3 font-mono text-xs whitespace-pre-wrap text-(--ui-text-muted)"
      >{{ job.logTail }}</pre>
    </details>
  </div>
</template>
