<script setup lang="ts">
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

interface Job {
  id: string
  type: string
  status: string
  progress: number | null
  error: string | null
  createdAt: string
  video: { id: string, title: string } | null
}

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

const TONE: Record<string, string> = {
  QUEUED: 'neutral',
  RUNNING: 'primary',
  SUCCEEDED: 'success',
  FAILED: 'error',
  CANCELLED: 'neutral',
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-end gap-3">
      <div class="grow">
        <h1 class="text-2xl font-bold tracking-tight">Jobs</h1>
        <p class="text-sm text-white/50">
          {{ active ? 'Live — refreshing every 2s' : 'Nothing running' }}
        </p>
      </div>
      <UButton variant="subtle" icon="i-lucide-refresh-cw" @click="refresh()">Refresh</UButton>
    </div>

    <div v-if="jobs.length" class="space-y-2">
      <div
        v-for="job in jobs"
        :key="job.id"
        class="rounded-lg border border-white/5 bg-(--ui-bg-elevated) p-4"
      >
        <div class="flex flex-wrap items-center gap-3">
          <UBadge :color="(TONE[job.status] as any) ?? 'neutral'" variant="subtle">
            {{ job.status }}
          </UBadge>
          <span class="text-sm font-medium">{{ job.type }}</span>
          <NuxtLink
            v-if="job.video"
            :to="`/admin/videos/${job.video.id}`"
            class="truncate text-sm text-white/60 hover:text-white"
          >
            {{ job.video.title }}
          </NuxtLink>

          <div class="ml-auto flex gap-2">
            <UButton
              v-if="job.status === 'RUNNING' || job.status === 'QUEUED'"
              size="xs"
              color="error"
              variant="subtle"
              @click="act(job, 'cancel')"
            >
              Cancel
            </UButton>
            <UButton
              v-if="job.status === 'FAILED' || job.status === 'CANCELLED'"
              size="xs"
              variant="subtle"
              @click="act(job, 'retry')"
            >
              Retry
            </UButton>
          </div>
        </div>

        <div v-if="job.status === 'RUNNING'" class="mt-3">
          <div class="h-1.5 overflow-hidden rounded-full bg-white/10">
            <div
              class="h-full bg-(--ui-primary) transition-[width] duration-500"
              :style="{ width: `${job.progress ?? 0}%` }"
            />
          </div>
          <p class="mt-1 text-xs text-white/40">
            {{ Math.round(job.progress ?? 0) }}%
            <span v-if="(job.progress ?? 0) >= 100"> — finalising the file</span>
          </p>
        </div>

        <p v-if="job.error" class="mt-2 font-mono text-xs text-red-400">{{ job.error }}</p>
      </div>
    </div>

    <p v-else class="py-20 text-center text-white/40">No jobs yet.</p>
  </div>
</template>
