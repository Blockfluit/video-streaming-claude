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

const toast = useToast()
const collectionId = ref('')
const file = ref<File | null>(null)
const progress = ref(0)
const uploading = ref(false)

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

  const request = new XMLHttpRequest()
  request.open('POST', '/api/videos/upload')
  request.upload.addEventListener('progress', (event) => {
    if (event.lengthComputable) progress.value = (event.loaded / event.total) * 100
  })
  request.addEventListener('load', () => {
    uploading.value = false
    if (request.status >= 200 && request.status < 300) {
      file.value = null
      progress.value = 0
      toast.add({ title: 'Uploaded. It will appear as a draft.', color: 'success' })
    } else {
      toast.add({ title: 'Upload refused', description: request.responseText.slice(0, 200), color: 'error' })
    }
  })
  request.addEventListener('error', () => {
    uploading.value = false
    toast.add({ title: 'Upload failed', color: 'error' })
  })
  request.send(body)
}
</script>

<template>
  <div class="max-w-2xl space-y-6">
    <div>
      <h1 class="text-2xl font-bold tracking-tight">Upload</h1>
      <p class="text-sm text-white/50">
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
            class="flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed border-white/15 p-8 text-center transition-colors hover:border-white/30"
          >
            <input type="file" accept="video/*,.mkv,.mp4,.avi,.mov" class="hidden" @change="pick">
            <UIcon name="i-lucide-upload-cloud" class="size-8 text-white/30" />
            <span class="text-sm">
              {{ file ? file.name : 'Choose a video file' }}
            </span>
            <span v-if="file" class="text-xs text-white/40">
              {{ (file.size / 1024 ** 3).toFixed(2) }} GB
            </span>
          </label>
        </UFormField>

        <div v-if="uploading" class="space-y-1">
          <div class="h-2 overflow-hidden rounded-full bg-white/10">
            <div class="h-full bg-(--ui-primary) transition-[width]" :style="{ width: `${progress}%` }" />
          </div>
          <p class="text-xs text-white/50">{{ Math.round(progress) }}%</p>
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
      </div>
    </UCard>
  </div>
</template>
