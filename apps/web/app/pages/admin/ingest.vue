<script setup lang="ts">
import type { Page } from '@video/shared'

/**
 * Scan status and whatever the watcher could not make sense of.
 *
 * Issues are upserted on `(kind, path)` and resolved rather than deleted, so
 * this list is what the library is currently unhappy about — not a log.
 */
definePageMeta({ layout: 'admin', middleware: 'admin' })

interface Issue {
  id: string
  kind: string
  path: string
  detail: string | null
  resolvedAt: string | null
  createdAt: string
}

const api = useApi()
const toast = useToast()

const { data: status, refresh: refreshStatus } = await useApiData<{
  running: boolean
  lastRunAt: string | null
  watching: boolean
}>('ingest-status', '/admin/ingest/status')

const { data: issues, refresh: refreshIssues } = await useApiData<Page<Issue>>(
  'ingest-issues',
  '/admin/ingest/issues?limit=100',
)

const scanning = ref(false)

async function scan() {
  scanning.value = true
  try {
    await api('/admin/ingest/scan', { method: 'POST' })
    await Promise.all([refreshStatus(), refreshIssues()])
    toast.add({ title: 'Scan finished', color: 'success' })
  } catch {
    toast.add({ title: 'Scan failed', color: 'error' })
  } finally {
    scanning.value = false
  }
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-end gap-3">
      <div class="grow">
        <h1 class="text-2xl font-bold tracking-tight">Ingest</h1>
        <p class="text-sm text-white/65">
          Watcher {{ status?.watching ? 'running' : 'off' }}
          <template v-if="status?.lastRunAt">
            · last scan {{ new Date(status.lastRunAt).toLocaleString() }}
          </template>
        </p>
      </div>
      <UButton :loading="scanning || status?.running" icon="i-lucide-folder-sync" @click="scan">
        Scan now
      </UButton>
    </div>

    <UAlert
      color="neutral"
      variant="subtle"
      icon="i-lucide-info"
      title="Drop files into the media folder"
      description="Files are picked up automatically. A scan is only needed if the watcher was off."
    />

    <div v-if="issues?.items?.length" class="overflow-hidden rounded-lg border border-white/12">
      <table class="w-full text-sm">
        <thead class="bg-white/5 text-left text-xs text-white/65 uppercase">
          <tr>
            <th class="p-3">Problem</th>
            <th class="p-3">Path</th>
            <th class="p-3">Detail</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-white/10">
          <tr v-for="issue in issues.items" :key="issue.id" :class="issue.resolvedAt ? 'opacity-40' : ''">
            <td class="p-3">
              <UBadge :color="issue.resolvedAt ? 'neutral' : 'warning'" variant="subtle">
                {{ issue.kind }}
              </UBadge>
            </td>
            <td class="p-3 font-mono text-xs break-all">{{ issue.path }}</td>
            <td class="p-3 text-white/70">{{ issue.detail }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <p v-else class="py-20 text-center text-white/70">Nothing to complain about.</p>
  </div>
</template>
