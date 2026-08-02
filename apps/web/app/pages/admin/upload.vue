<script setup lang="ts">
/**
 * Uploading onto a disk.
 *
 * An upload used to name a collection, which made it a second way of deciding
 * what something is. It is not: the files land on the drive in the shape the
 * folder convention expects, and the scan makes of them exactly what it would
 * make of the same folders copied there by hand — one file a standalone video,
 * a folder of two a collection, a folder of seasons a series.
 *
 * So the only thing to choose is **which disk**. Where it ends up in the
 * library is edited afterwards, like anything else.
 *
 * `XMLHttpRequest` rather than `fetch` — `fetch` still gives no upload progress
 * events, and a 2 GB file with no progress bar looks like a hang.
 */
definePageMeta({ layout: 'admin', middleware: 'admin' })

const { data: drives } = await useApiData<{ items: { name: string }[] }>(
  'upload-drives',
  '/videos/upload/drives',
)

const drive = ref('')
const files = ref<File[]>([])
const progress = ref(0)
const uploading = ref(false)

/**
 * The outcome, kept on the page rather than in a toast.
 *
 * An upload takes minutes; whoever started it has looked away. A notification
 * that fades after five seconds is exactly the wrong shape for the one message
 * that matters — and when it was a refusal, the file simply seemed to vanish.
 */
const result = ref<{ ok: boolean, message: string, placed: string[] } | null>(null)

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

const driveOptions = computed(() =>
  (drives.value?.items ?? []).map(entry => ({ label: entry.name, value: entry.name })),
)

const totalBytes = computed(() => files.value.reduce((sum, file) => sum + file.size, 0))

function pick(event: Event) {
  files.value = [...((event.target as HTMLInputElement).files ?? [])]
}

function upload() {
  if (files.value.length === 0 || !drive.value) return

  const body = new FormData()
  body.append('drive', drive.value)
  for (const file of files.value) {
    body.append('file', file)
    /**
     * The folder shape travels beside the file, in the same order.
     *
     * multer strips both slash and backslash from a filename, so a directory
     * upload's `webkitRelativePath` cannot survive inside it. One `paths` field
     * per file, appended in step with them, is what keeps a season folder a
     * season folder.
     */
    body.append('paths', file.webkitRelativePath || file.name)
  }

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
      let placed: string[] = []
      try {
        placed = (JSON.parse(request.responseText).placed ?? []).map(
          (entry: { storageKey: string }) => entry.storageKey,
        )
      } catch {
        // A 2xx with an unreadable body still means it landed.
      }
      result.value = {
        ok: true,
        message: `${placed.length || files.value.length} file(s) placed on ${drive.value}. The scan has taken them from here.`,
        placed,
      }
      files.value = []
      return
    }

    result.value = { ok: false, message: reasonFrom(request.responseText, request.status), placed: [] }
  })
  request.addEventListener('error', () => {
    uploading.value = false
    progress.value = 0
    result.value = { ok: false, message: reasonFrom('', 0), placed: [] }
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
        Lands on the disk you choose, exactly as if you had copied it there — and becomes
        whatever the folder says it is.
      </p>
    </div>

    <UCard>
      <div class="space-y-4">
        <UFormField label="Disk" required>
          <USelect
            v-model="drive"
            :items="driveOptions"
            placeholder="Choose a disk"
            aria-label="Choose which disk to upload to"
            class="w-full"
          />
        </UFormField>

        <UFormField label="Files">
          <div class="grid gap-3 sm:grid-cols-2">
            <label
              class="flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed border-(--ui-border) p-6 text-center transition-colors hover:border-(--ui-border-accented)"
            >
              <input
                type="file"
                multiple
                accept="video/*,.mkv,.mp4,.avi,.mov"
                class="hidden"
                @change="pick"
              >
              <UIcon name="i-lucide-file-video" class="size-7 text-(--ui-text-dimmed)" />
              <span class="text-sm">Choose files</span>
              <span class="text-xs text-(--ui-text-muted)">
                Each gets a folder of its own
              </span>
            </label>

            <!--
              A whole folder, which is how a season or a set of films arrives.
              `webkitdirectory` is the only way a browser will hand one over,
              and it is why the relative paths have to be sent alongside.
            -->
            <label
              class="flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed border-(--ui-border) p-6 text-center transition-colors hover:border-(--ui-border-accented)"
            >
              <input type="file" webkitdirectory multiple class="hidden" @change="pick">
              <UIcon name="i-lucide-folder-up" class="size-7 text-(--ui-text-dimmed)" />
              <span class="text-sm">Choose a folder</span>
              <span class="text-xs text-(--ui-text-muted)">
                Placed as it is, seasons and all
              </span>
            </label>
          </div>
        </UFormField>

        <div v-if="files.length" class="rounded-md bg-(--ui-bg-elevated) p-3 text-sm">
          <p class="font-medium">{{ files.length }} file(s) — {{ (totalBytes / 1024 ** 3).toFixed(2) }} GB</p>
          <ul class="mt-1 max-h-40 space-y-0.5 overflow-y-auto text-xs text-(--ui-text-muted)">
            <li v-for="file in files.slice(0, 30)" :key="file.name">
              {{ file.webkitRelativePath || file.name }}
            </li>
            <li v-if="files.length > 30">…and {{ files.length - 30 }} more</li>
          </ul>
        </div>

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
          :disabled="files.length === 0 || !drive"
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
            <UButton size="xs" to="/admin/drafts">All drafts</UButton>
            <UButton size="xs" color="neutral" variant="subtle" to="/admin/media">
              Browse the disks
            </UButton>
          </template>
        </UAlert>
      </div>
    </UCard>
  </div>
</template>
