<script setup lang="ts">
import type { Page } from '@video/shared'

/**
 * The PIM inbox.
 *
 * Every draft with the checklist the API already computes — `missingFields`
 * comes back on any admin read, so the UI never has to guess what publishing
 * would reject, and never has to submit to find out.
 */
definePageMeta({ layout: 'admin', middleware: 'admin' })

interface DraftVideo {
  id: string
  slug: string
  title: string
  description: string | null
  durationSec: number | null
  width: number | null
  height: number | null
  state: string
  needsConversion: boolean
  probeError: string | null
  missingFields?: string[]
}

const api = useApi()
const toast = useToast()

const { data, refresh, status } = await useApiData<Page<DraftVideo>>(
  'admin-drafts',
  '/videos?state=DRAFT&limit=100',
)

const drafts = computed(() => data.value?.items ?? [])
const ready = computed(() => drafts.value.filter(v => (v.missingFields?.length ?? 0) === 0))
const selected = ref<Set<string>>(new Set())

function toggle(id: string) {
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selected.value = next
}

const busy = ref(false)

async function publish(ids: string[]) {
  if (ids.length === 0) return
  busy.value = true

  // Sequential rather than parallel: the failures are per video and the admin
  // needs to know which one, not that "something" went wrong.
  const failed: string[] = []
  for (const id of ids) {
    try {
      await api(`/videos/${id}/publish`, { method: 'POST' })
    } catch {
      failed.push(id)
    }
  }

  busy.value = false
  selected.value = new Set()
  await refresh()

  toast.add({
    title: failed.length
      ? `Published ${ids.length - failed.length}, ${failed.length} refused`
      : `Published ${ids.length}`,
    color: failed.length ? 'warning' : 'success',
  })
}

const FIELD_LABELS: Record<string, string> = {
  title: 'title',
  description: 'description',
  durationSec: 'not probed',
  bannerKey: 'no poster',
}

useHead({ title: 'Drafts' })
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-end gap-4">
      <div class="grow">
        <h1 class="text-2xl font-bold tracking-tight">Drafts</h1>
        <p class="text-sm text-(--ui-text-muted)">
          {{ data?.total ?? 0 }} waiting · {{ ready.length }} ready to publish
        </p>
      </div>

      <UButton
        v-if="ready.length"
        :loading="busy"
        icon="i-lucide-check-check"
        @click="publish(ready.map(v => v.id))"
      >
        Publish all {{ ready.length }} ready
      </UButton>
      <UButton
        v-if="selected.size"
        :loading="busy"
        color="neutral" variant="subtle"
        @click="publish([...selected])"
      >
        Publish {{ selected.size }} selected
      </UButton>
    </div>

    <div v-if="drafts.length" class="overflow-hidden rounded-lg border border-(--ui-border)">
      <table class="w-full text-sm">
        <thead class="bg-(--ui-bg-elevated) text-left text-xs text-(--ui-text-muted) uppercase">
          <tr>
            <th class="w-10 p-3" />
            <th class="p-3">Video</th>
            <th class="p-3">Still needs</th>
            <th class="w-32 p-3" />
          </tr>
        </thead>
        <tbody class="divide-y divide-(--ui-border)">
          <tr v-for="video in drafts" :key="video.id" class="hover:bg-white/[0.03]">
            <td class="p-3">
              <UCheckbox
                :model-value="selected.has(video.id)"
                :disabled="(video.missingFields?.length ?? 0) > 0"
                @update:model-value="toggle(video.id)"
              />
            </td>

            <td class="p-3">
              <div class="flex items-center gap-3">
                <img
                  :src="`/api/videos/${video.id}/banner`"
                  alt=""
                  loading="lazy"
                  class="aspect-video w-20 shrink-0 rounded bg-(--ui-bg-accented) object-cover"
                >
                <div class="min-w-0">
                  <p class="truncate font-medium">{{ video.title }}</p>
                  <div class="flex items-center gap-2 text-xs text-(--ui-text-muted)">
                    <span>{{ runtime(video.durationSec) ?? 'unprobed' }}</span>
                    <QualityBadge :width="video.width" :height="video.height" />
                    <UBadge v-if="video.needsConversion" color="warning" variant="subtle" size="sm">
                      needs conversion
                    </UBadge>
                  </div>
                </div>
              </div>
            </td>

            <td class="p-3">
              <!-- The checklist the API computed; publishing would reject on exactly these. -->
              <div v-if="video.missingFields?.length" class="flex flex-wrap gap-1">
                <UBadge
                  v-for="field in video.missingFields"
                  :key="field"
                  color="warning"
                  variant="subtle"
                  size="sm"
                >
                  {{ FIELD_LABELS[field] ?? field }}
                </UBadge>
              </div>
              <span v-else class="text-xs text-green-400">ready</span>

              <p v-if="video.probeError" class="mt-1 text-xs text-red-400">
                {{ video.probeError }}
              </p>
            </td>

            <td class="p-3 text-right">
              <UButton :to="`/admin/videos/${video.id}`" size="xs" color="neutral" variant="subtle">Edit</UButton>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <p v-else-if="status !== 'pending'" class="py-20 text-center text-(--ui-text-muted)">
      No drafts. Everything in the library has been dealt with.
    </p>
  </div>
</template>
