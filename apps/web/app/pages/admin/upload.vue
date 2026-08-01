<script setup lang="ts">
import type { Page } from '@video/shared'

/**
 * Uploading straight into a collection.
 *
 * `XMLHttpRequest` rather than `fetch` — `fetch` still gives no upload progress
 * events, and a 2 GB file with no progress bar looks like a hang.
 */
definePageMeta({ layout: 'admin', middleware: 'admin' })

const { data: collections } = await useApiData<Page<{ id: string, title: string }>>(
  'upload-collections',
  '/collections?limit=100',
)

const collectionId = ref('')
const file = ref<File | null>(null)
const progress = ref(0)
const uploading = ref(false)

/**
 * The outcome, kept on the page rather than in a toast.
 *
 * An upload takes minutes; whoever started it has looked away. A notification
 * that fades after five seconds is exactly the wrong shape for the one message
 * that matters — and when it was a refusal, the file simply seemed to vanish.
 */
const result = ref<{ ok: boolean, message: string, videoId?: string } | null>(null)

/** The API's own message, which says what to do about it. */
function reasonFrom(responseText: string, status: number): string {
  try {
    const body = JSON.parse(responseText)
    const message = Array.isArray(body.message) ? body.message[0] : body.message
    if (message) return message
  } catch {
    // Not JSON — a proxy error page, or the request never reached the API.
  }
  return status === 0
    ? 'The connection dropped before the upload finished.'
    : `The server refused it (HTTP ${status}).`
}

const options = computed(() =>
  (collections.value?.items ?? []).map(c => ({ label: c.title, value: c.id })),
)

function pick(event: Event) {
  file.value = (event.target as HTMLInputElement).files?.[0] ?? null
}

function upload() {
  if (!file.value || !collectionId.value) return

  const body = new FormData()
  body.append('file', file.value)
  body.append('collectionId', collectionId.value)

  uploading.value = true
  progress.value = 0
  result.value = null

  const request = new XMLHttpRequest()
  request.open('POST', '/api/videos/upload')
  request.upload.addEventListener('progress', (event) => {
    if (event.lengthComputable) progress.value = (event.loaded / event.total) * 100
  })
  request.addEventListener('load', () => {
    uploading.value = false
    progress.value = 0

    if (request.status >= 200 && request.status < 300) {
      let videoId: string | undefined
      try {
        videoId = JSON.parse(request.responseText).id
      } catch {
        // A 2xx with an unreadable body still means it landed.
      }
      result.value = { ok: true, message: `${file.value?.name ?? 'The file'} is in the library.`, videoId }
      file.value = null
      return
    }

    result.value = { ok: false, message: reasonFrom(request.responseText, request.status) }
  })
  request.addEventListener('error', () => {
    uploading.value = false
    progress.value = 0
    result.value = { ok: false, message: reasonFrom('', 0) }
  })
  request.send(body)
}

useHead({ title: 'Upload' })
</script>

<template>
  <div class="max-w-2xl space-y-6">
    <div>
      <h1 class="text-2xl font-bold tracking-tight">Upload</h1>
      <p class="text-sm text-(--ui-text-muted)">
        Lands in the media folder as a draft, exactly as if you had copied it there.
      </p>
    </div>

    <UCard>
      <div class="space-y-4">
        <UFormField label="Collection" required>
          <USelect v-model="collectionId" :items="options" placeholder="Choose one" class="w-full" />
        </UFormField>

        <UFormField label="File">
          <label
            class="flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed border-(--ui-border) p-8 text-center transition-colors hover:border-(--ui-border-accented)"
          >
            <input type="file" accept="video/*,.mkv,.mp4,.avi,.mov" class="hidden" @change="pick">
            <UIcon name="i-lucide-upload-cloud" class="size-8 text-(--ui-text-dimmed)" />
            <span class="text-sm">
              {{ file ? file.name : 'Choose a video file' }}
            </span>
            <span v-if="file" class="text-xs text-(--ui-text-muted)">
              {{ (file.size / 1024 ** 3).toFixed(2) }} GB
            </span>
          </label>
        </UFormField>

        <div v-if="uploading" class="space-y-1">
          <div class="h-2 overflow-hidden rounded-full bg-white/10">
            <div class="h-full bg-(--ui-primary) transition-[width]" :style="{ width: `${progress}%` }" />
          </div>
          <p class="text-xs text-(--ui-text-muted)">{{ Math.round(progress) }}%</p>
        </div>

        <UButton
          block
          size="lg"
          :loading="uploading"
          :disabled="!file || !collectionId"
          @click="upload"
        >
          Upload
        </UButton>

        <!-- Stays until the next upload. Whoever started this walked away. -->
        <UAlert
          v-if="result"
          :color="result.ok ? 'success' : 'error'"
          variant="subtle"
          :icon="result.ok ? 'i-lucide-check' : 'i-lucide-triangle-alert'"
          :title="result.ok ? 'Uploaded' : 'Not uploaded'"
          :description="result.message"
        >
          <template v-if="result.ok" #actions>
            <UButton
              v-if="result.videoId"
              size="xs"
              :to="`/admin/videos/${result.videoId}`"
            >
              Open it
            </UButton>
            <UButton size="xs" color="neutral" variant="subtle" to="/admin/drafts">All drafts</UButton>
          </template>
        </UAlert>
      </div>
    </UCard>
  </div>
</template>
