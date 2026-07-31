<script setup lang="ts">
/**
 * Enriching one video: metadata, skip markers, poster, subtitles, conversion.
 *
 * The marker editor saves **one marker per click**, which is why the API merges
 * a patch onto the stored values before validating — setting only an end has to
 * be checked against a start it cannot see in the request.
 */
definePageMeta({ layout: 'admin', middleware: 'admin' })

interface VideoDetail {
  id: string
  slug: string
  title: string
  description: string | null
  tags: string[]
  state: string
  durationSec: number | null
  width: number | null
  height: number | null
  sizeBytes: string
  videoCodec: string | null
  audioCodec: string | null
  audioTracks: number | null
  needsConversion: boolean
  probeError: string | null
  thumbnailSource: string
  playbackKey: string | null
  storageKey: string
  introStartSec: number | null
  introEndSec: number | null
  outroStartSec: number | null
  outroEndSec: number | null
  missingFields?: string[]
}

interface SubtitleTrack {
  id: string
  language: string
  label: string
  isDefault: boolean
  origin: string
}

const route = useRoute()
const api = useApi()
const toast = useToast()
const id = String(route.params.id)

const { data: video, refresh } = await useApiData<VideoDetail>(`adm-video-${id}`, `/videos/${id}`)
const { data: subtitles, refresh: refreshSubs } = await useApiData<{ items: SubtitleTrack[] }>(
  `adm-subs-${id}`,
  `/videos/${id}/subtitles`,
)

const form = reactive({ title: '', description: '', tags: '' })
watchEffect(() => {
  if (!video.value) return
  form.title = video.value.title
  form.description = video.value.description ?? ''
  form.tags = video.value.tags.join(', ')
})

const saving = ref(false)

async function save() {
  saving.value = true
  try {
    await api(`/videos/${id}`, {
      method: 'PATCH',
      body: {
        title: form.title,
        description: form.description,
        tags: form.tags.split(',').map(t => t.trim()).filter(Boolean),
      },
    })
    await refresh()
    toast.add({ title: 'Saved', color: 'success' })
  } catch (error) {
    toast.add({ title: message(error, 'Could not save'), color: 'error' })
  } finally {
    saving.value = false
  }
}

/** The preview the marker buttons read their position from. */
const preview = ref<HTMLVideoElement | null>(null)
const previewTime = ref(0)

async function setMarker(field: string) {
  try {
    await api(`/videos/${id}/markers`, {
      method: 'PATCH',
      body: { [field]: Math.round(previewTime.value * 10) / 10 },
    })
    await refresh()
  } catch (error) {
    // The API validates the merged pair, so this is where "end before start"
    // arrives — with the field it belongs to.
    toast.add({ title: message(error, 'That marker was refused'), color: 'error' })
  }
}

async function clearMarker(field: string) {
  await api(`/videos/${id}/markers`, { method: 'PATCH', body: { [field]: null } })
  await refresh()
}

async function act(path: string, method: 'POST' | 'DELETE' = 'POST', label = 'Done') {
  try {
    await api(`/videos/${id}${path}`, { method })
    await refresh()
    toast.add({ title: label, color: 'success' })
  } catch (error) {
    toast.add({ title: message(error, 'That did not work'), color: 'error' })
  }
}

async function captureThumbnail() {
  try {
    await api(`/videos/${id}/thumbnail/capture`, {
      method: 'POST',
      body: { atSeconds: Math.round(previewTime.value * 10) / 10 },
    })
    // The key does not change, so the browser has to be told the picture did.
    posterBust.value = Date.now()
    await refresh()
    toast.add({ title: 'Poster captured', color: 'success' })
  } catch (error) {
    toast.add({ title: message(error, 'Could not capture that frame'), color: 'error' })
  }
}

const posterBust = ref(0)
const posterUrl = computed(() => `/api/videos/${id}/thumbnail?v=${posterBust.value}`)

async function uploadPoster(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return

  const body = new FormData()
  body.append('file', file)
  try {
    await api(`/videos/${id}/thumbnail`, { method: 'POST', body })
    posterBust.value = Date.now()
    await refresh()
  } catch (error) {
    toast.add({ title: message(error, 'Could not upload that image'), color: 'error' })
  }
}

async function uploadSubtitle(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return

  const body = new FormData()
  body.append('file', file)
  body.append('language', 'en')
  try {
    await api(`/videos/${id}/subtitles`, { method: 'POST', body })
    await refreshSubs()
  } catch (error) {
    // An SRT accepted as .vtt loads as an empty track, so the API sniffs for
    // the WEBVTT signature and this is where that rejection surfaces.
    toast.add({ title: message(error, 'Could not add that subtitle'), color: 'error' })
  }
}

function message(error: unknown, fallback: string): string {
  const data = (error as { data?: { message?: string | string[], errors?: { message: string }[] } }).data
  return (
    data?.errors?.[0]?.message
    ?? (Array.isArray(data?.message) ? data.message[0] : data?.message)
    ?? fallback
  )
}

const markers = [
  { field: 'introStartSec', label: 'Intro start' },
  { field: 'introEndSec', label: 'Intro end' },
  { field: 'outroStartSec', label: 'Outro start' },
  { field: 'outroEndSec', label: 'Outro end' },
] as const
</script>

<template>
  <div v-if="video" class="space-y-6">
    <div class="flex flex-wrap items-start gap-4">
      <div class="grow">
        <NuxtLink to="/admin/drafts" class="text-sm text-white/40 hover:text-white">
          ← Drafts
        </NuxtLink>
        <h1 class="text-2xl font-bold tracking-tight">{{ video.title }}</h1>
        <div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-white/40">
          <UBadge :color="video.state === 'PUBLISHED' ? 'success' : 'neutral'" variant="subtle">
            {{ video.state }}
          </UBadge>
          <QualityBadge :width="video.width" :height="video.height" />
          <span>{{ runtime(video.durationSec) ?? 'not probed' }}</span>
          <span>{{ video.videoCodec }} / {{ video.audioCodec }}</span>
          <span>{{ video.storageKey }}</span>
        </div>
      </div>

      <div class="flex gap-2">
        <UButton
          v-if="video.state !== 'PUBLISHED'"
          :disabled="(video.missingFields?.length ?? 0) > 0"
          icon="i-lucide-check"
          @click="act('/publish', 'POST', 'Published')"
        >
          Publish
        </UButton>
        <UButton
          v-else
          variant="subtle"
          color="neutral"
          icon="i-lucide-archive"
          @click="act('/archive', 'POST', 'Archived')"
        >
          Archive
        </UButton>
      </div>
    </div>

    <UAlert
      v-if="video.missingFields?.length"
      color="warning"
      variant="subtle"
      icon="i-lucide-list-checks"
      :title="`Not ready to publish: ${video.missingFields.join(', ')}`"
    />
    <UAlert
      v-if="video.probeError"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="video.probeError"
    />

    <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
      <div class="space-y-6">
        <UCard>
          <template #header><h2 class="font-semibold">Details</h2></template>
          <div class="space-y-4">
            <UFormField label="Title">
              <UInput v-model="form.title" class="w-full" />
            </UFormField>
            <UFormField label="Description">
              <UTextarea v-model="form.description" :rows="4" class="w-full" />
            </UFormField>
            <UFormField label="Tags" hint="Comma separated">
              <UInput v-model="form.tags" class="w-full" />
            </UFormField>
            <UButton :loading="saving" @click="save">Save details</UButton>
          </div>
        </UCard>

        <UCard>
          <template #header>
            <h2 class="font-semibold">Skip markers</h2>
            <p class="text-xs text-white/40">
              Scrub to a position, then set. Each click saves on its own.
            </p>
          </template>

          <div class="space-y-4">
            <video
              ref="preview"
              class="aspect-video w-full rounded bg-black"
              controls
              :src="`/api/videos/${video.id}/stream`"
              @timeupdate="previewTime = ($event.target as HTMLVideoElement).currentTime"
            />

            <p class="text-sm text-white/50">
              Playhead at <span class="font-mono text-white">{{ timecode(previewTime) }}</span>
            </p>

            <div class="grid gap-2 sm:grid-cols-2">
              <div
                v-for="marker in markers"
                :key="marker.field"
                class="flex items-center gap-2 rounded-md bg-white/5 p-2"
              >
                <span class="w-24 text-sm text-white/60">{{ marker.label }}</span>
                <span class="font-mono text-sm">
                  {{ video[marker.field] === null ? '—' : timecode(video[marker.field]!) }}
                </span>
                <UButton size="xs" variant="subtle" class="ml-auto" @click="setMarker(marker.field)">
                  Set
                </UButton>
                <UButton
                  v-if="video[marker.field] !== null"
                  size="xs"
                  variant="ghost"
                  color="neutral"
                  icon="i-lucide-x"
                  :aria-label="`Clear ${marker.label}`"
                  @click="clearMarker(marker.field)"
                />
              </div>
            </div>
          </div>
        </UCard>

        <UCard>
          <template #header><h2 class="font-semibold">Subtitles</h2></template>
          <ul v-if="subtitles?.items?.length" class="mb-4 divide-y divide-white/5">
            <li
              v-for="track in subtitles.items"
              :key="track.id"
              class="flex items-center gap-3 py-2 text-sm"
            >
              <span class="font-medium">{{ track.label }}</span>
              <UBadge color="neutral" variant="subtle" size="sm">{{ track.language }}</UBadge>
              <UBadge v-if="track.isDefault" color="primary" variant="subtle" size="sm">
                default
              </UBadge>
              <span class="ml-auto text-xs text-white/30">{{ track.origin }}</span>
            </li>
          </ul>
          <p v-else class="mb-4 text-sm text-white/40">No subtitle tracks.</p>

          <div class="flex flex-wrap gap-2">
            <label class="cursor-pointer">
              <input type="file" accept=".vtt" class="hidden" @change="uploadSubtitle">
              <span
                class="inline-flex items-center gap-2 rounded-md bg-white/10 px-3 py-1.5 text-sm hover:bg-white/15"
              >
                <UIcon name="i-lucide-upload" class="size-4" /> Upload .vtt
              </span>
            </label>
            <UButton
              variant="subtle"
              color="neutral"
              icon="i-lucide-scissors"
              @click="act('/extract-subtitles', 'POST', 'Extraction queued')"
            >
              Extract embedded
            </UButton>
          </div>
        </UCard>
      </div>

      <div class="space-y-6">
        <UCard>
          <template #header>
            <h2 class="font-semibold">Poster</h2>
            <p class="text-xs text-white/40">{{ video.thumbnailSource }}</p>
          </template>

          <img
            :src="posterUrl"
            alt=""
            class="mb-3 aspect-video w-full rounded bg-(--ui-bg-accented) object-cover"
          >

          <div class="space-y-2">
            <UButton block variant="subtle" icon="i-lucide-crosshair" @click="captureThumbnail">
              Capture at {{ timecode(previewTime) }}
            </UButton>
            <label class="block cursor-pointer">
              <input type="file" accept="image/*" class="hidden" @change="uploadPoster">
              <span
                class="flex w-full items-center justify-center gap-2 rounded-md bg-white/10 px-3 py-1.5 text-sm hover:bg-white/15"
              >
                <UIcon name="i-lucide-image" class="size-4" /> Upload image
              </span>
            </label>
            <UButton
              block
              variant="ghost"
              color="neutral"
              icon="i-lucide-rotate-ccw"
              @click="act('/thumbnail', 'DELETE', 'Back to automatic')"
            >
              Reset to automatic
            </UButton>
          </div>
        </UCard>

        <UCard>
          <template #header><h2 class="font-semibold">Media</h2></template>
          <dl class="space-y-2 text-sm">
            <div class="flex justify-between">
              <dt class="text-white/50">Size</dt>
              <dd>{{ (Number(video.sizeBytes) / 1024 ** 3).toFixed(2) }} GB</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-white/50">Audio tracks</dt>
              <dd>{{ video.audioTracks ?? '—' }}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-white/50">Converted</dt>
              <dd>{{ video.playbackKey ? 'yes' : 'no' }}</dd>
            </div>
          </dl>

          <div class="mt-4 space-y-2">
            <UButton
              block
              variant="subtle"
              icon="i-lucide-refresh-cw"
              @click="act('/reprobe', 'POST', 'Reprobed')"
            >
              Re-probe
            </UButton>
            <!-- Nothing transcodes on its own; an admin decides when to spend the CPU. -->
            <UButton
              v-if="video.needsConversion"
              block
              color="warning"
              variant="subtle"
              icon="i-lucide-cpu"
              @click="act('/convert', 'POST', 'Conversion queued')"
            >
              Convert to MP4
            </UButton>
            <UAlert
              v-if="video.needsConversion && (video.audioTracks ?? 0) > 1"
              color="warning"
              variant="subtle"
              size="sm"
              :title="`${video.audioTracks} audio tracks — conversion keeps the first`"
            />
          </div>
        </UCard>
      </div>
    </div>
  </div>
</template>
