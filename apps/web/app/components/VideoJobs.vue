<script setup lang="ts">
import type { Page } from '@video/shared'
import type { Job } from '~/components/JobProgress.vue'

/**
 * This video's jobs, on the video's own page.
 *
 * Starting a conversion used to send you to `/admin/jobs` to find out whether
 * anything was happening — on a screen listing every job in the library, where
 * the one you just started is simply the top row. The same information belongs
 * next to the button that started it.
 *
 * Polls only while something is pending, and only the recent few: a video that
 * has been re-probed twenty times does not need twenty rows here.
 */
const props = defineProps<{ videoId: string }>()

const api = useApi()
const toast = useToast()

const { data, refresh } = await useApiData<Page<Job>>(
  `video-jobs-${props.videoId}`,
  () => `/admin/jobs?videoId=${props.videoId}&limit=5`,
)

const jobs = computed(() => data.value?.items ?? [])
const active = computed(() =>
  jobs.value.some(job => job.status === 'RUNNING' || job.status === 'QUEUED'),
)

let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(() => {
    if (active.value) void refresh()
  }, 2000)
})
onBeforeUnmount(() => clearInterval(timer))

async function act(job: Job, action: 'cancel' | 'retry') {
  try {
    await api(`/admin/jobs/${job.id}/${action}`, { method: 'POST' })
    await refresh()
  }
  catch {
    toast.add({ title: `Could not ${action} that job.`, color: 'error' })
  }
}

/** Exposed so the page can refresh straight after starting something. */
defineExpose({ refresh })
</script>

<template>
  <section class="space-y-3">
    <div class="flex items-center gap-2">
      <h2 class="text-sm font-semibold tracking-wide text-(--ui-text-muted) uppercase">
        Jobs
      </h2>
      <span v-if="active" class="flex items-center gap-1.5 text-xs text-(--ui-text-muted)">
        <span class="size-1.5 animate-pulse rounded-full bg-(--ui-primary)" />
        live
      </span>
      <UButton
        class="ml-auto"
        size="xs"
        color="neutral"
        variant="subtle"
        icon="i-lucide-refresh-cw"
        aria-label="Refresh jobs"
        @click="refresh()"
      />
    </div>

    <div v-if="jobs.length" class="space-y-2">
      <JobProgress v-for="job in jobs" :key="job.id" :job="job" @act="act" />
    </div>
    <p v-else class="text-sm text-(--ui-text-muted)">
      Nothing has run for this video yet.
    </p>
  </section>
</template>
