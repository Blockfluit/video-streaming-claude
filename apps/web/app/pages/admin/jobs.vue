<script setup lang="ts">
import type { Job } from '~/components/JobProgress.vue'
import type { Page } from '@video/shared'

/**
 * The conversion queue.
 *
 * Polls while anything is running and stops when nothing is — an idle admin tab
 * should not hold a request open all afternoon. Progress sits at 100% for a
 * moment before finishing: `-movflags +faststart` makes ffmpeg rewrite the file
 * after it reaches the end. That is expected, not a hang.
 */
definePageMeta({ layout: 'admin', middleware: 'admin' })

const api = useApi()
const toast = useToast()

const { data, refresh } = await useApiData<Page<Job>>('admin-jobs', '/admin/jobs?limit=100')
const jobs = computed(() => data.value?.items ?? [])
const active = computed(() => jobs.value.some(j => j.status === 'RUNNING' || j.status === 'QUEUED'))

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
  } catch {
    toast.add({ title: `Could not ${action} that job.`, color: 'error' })
  }
}

useHead({ title: 'Jobs' })
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-end gap-3">
      <div class="grow">
        <h1 class="text-2xl font-bold tracking-tight">Jobs</h1>
        <p class="text-sm text-(--ui-text-muted)">
          {{ active ? 'Live — refreshing every 2s' : 'Nothing running' }}
        </p>
      </div>
      <UButton color="neutral" variant="subtle" icon="i-lucide-refresh-cw" @click="refresh()">Refresh</UButton>
    </div>

    <div v-if="jobs.length" class="space-y-2">
      <JobProgress
        v-for="job in jobs"
        :key="job.id"
        :job="job"
        show-video
        @act="act"
      />
    </div>

    <p v-else class="py-20 text-center text-(--ui-text-muted)">No jobs yet.</p>
  </div>
</template>
