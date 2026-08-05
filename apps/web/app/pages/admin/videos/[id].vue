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
  updatedAt?: string
  /** Imported. Shown and edited in the Metadata card. */
  year?: number | null
  tmdbId?: number | null
  tmdbType?: string | null
  imdbId?: string | null
  genres?: string[]
  tagline?: string | null
  originalTitle?: string | null
  originalLanguage?: string | null
  releaseDate?: string | null
  certification?: string | null
  tmdbRating?: number | null
  tmdbVoteCount?: number | null
  metadataUpdatedAt?: string | null
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
  posterSource: string
  bannerSource: string
  trailerYoutubeId: string | null
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

const form = reactive({ title: '', description: '', year: undefined as number | undefined, tags: '', trailer: '' })

/**
 * Seeded when the server record actually changes, not on every refresh.
 *
 * This was a `watchEffect`, which re-ran on any refresh and silently discarded
 * whatever was being typed — and refreshes got much more frequent once a
 * metadata import could fire one. Keying on `updatedAt` re-reads the form after
 * a save or an import and leaves it alone otherwise.
 */
function resetForm() {
  if (!video.value) return
  form.title = video.value.title
  form.description = video.value.description ?? ''
  form.year = video.value.year ?? undefined
  form.tags = video.value.tags.join(', ')
  form.trailer = video.value.trailerYoutubeId ?? ''
}

resetForm()
watch(() => video.value?.updatedAt, resetForm)

const saving = ref(false)

async function save() {
  saving.value = true
  try {
    await api(`/videos/${id}`, {
      method: 'PATCH',
      body: {
        title: form.title,
        description: form.description,
        year: form.year ?? undefined,
        tags: form.tags.split(',').map(t => t.trim()).filter(Boolean),
        // Sent as typed. The API parses a pasted URL down to an id and refuses
        // what it cannot read, so a mistyped link is a message on this form
        // rather than a player that silently shows nothing.
        trailerYoutubeId: form.trailer,
      },
    })
    await refresh()
    toast.add({ title: 'Saved', color: 'success' })
  } catch (error) {
    toast.add({ title: apiMessage(error, 'Could not save'), color: 'error' })
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
    toast.add({ title: apiMessage(error, 'That marker was refused'), color: 'error' })
  }
}

async function clearMarker(field: string) {
  await api(`/videos/${id}/markers`, { method: 'PATCH', body: { [field]: null } })
  await refresh()
}

/** The jobs panel, so queueing something shows up in it straight away. */
const jobs = ref<{ refresh: () => Promise<void> } | null>(null)

async function act(path: string, method: 'POST' | 'DELETE' = 'POST', label = 'Done') {
  try {
    await api(`/videos/${id}${path}`, { method })
    await refresh()
    toast.add({ title: label, color: 'success' })

    /*
     * Pulls the new job into the panel rather than waiting up to 2s for the
     * next poll, which reads as the button having done nothing.
     *
     * Deliberately after the toast and deliberately not awaited into the catch
     * below: this is a nicety, and the first version had it before the toast
     * and inside the try — so a refresh of a *side panel* could swallow the
     * confirmation of an action that had already succeeded on the server.
     */
    void jobs.value?.refresh().catch(() => undefined)
  } catch (error) {
    toast.add({ title: apiMessage(error, 'That did not work'), color: 'error' })
  }
}

/**
 * The two shapes, each edited on its own.
 *
 * Separately on purpose: the sources are tracked per shape, so an admin can
 * hand-pick a poster for a film and still let the banner regenerate on the next
 * probe. One combined control would have to overwrite both.
 */
type ArtworkShape = 'poster' | 'banner'

const ARTWORK = [
  {
    shape: 'poster' as const,
    label: 'Poster',
    hint: '2:3 — every card in the app',
    frame: 'aspect-2/3 w-32',
  },
  {
    shape: 'banner' as const,
    label: 'Banner',
    hint: '16:9 — episode rows and page backdrops',
    frame: 'aspect-video w-full',
  },
]

/**
 * A cache-buster per shape.
 *
 * The storage key does not change when a picture is replaced, so the ETag alone
 * cannot help an `<img>` the browser never re-requests. Per shape rather than
 * shared, or replacing the banner would silently reload the poster too and hide
 * whether the thing you just did worked.
 */
const bust = reactive<Record<ArtworkShape, number>>({ poster: 0, banner: 0 })

function artworkUrl(shape: ArtworkShape): string {
  return `/api/videos/${id}/${shape}?v=${bust[shape]}`
}

function artworkSource(shape: ArtworkShape): string {
  return shape === 'poster' ? (video.value?.posterSource ?? '') : (video.value?.bannerSource ?? '')
}

async function captureArtwork(shape: ArtworkShape) {
  try {
    await api(`/videos/${id}/${shape}/capture`, {
      method: 'POST',
      body: { atSeconds: Math.round(previewTime.value * 10) / 10 },
    })
    bust[shape] = Date.now()
    await refresh()
    toast.add({ title: `${shape === 'poster' ? 'Poster' : 'Banner'} captured`, color: 'success' })
  } catch (error) {
    toast.add({ title: apiMessage(error, 'Could not capture that frame'), color: 'error' })
  }
}

async function uploadArtwork(event: Event, shape: ArtworkShape) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return

  const body = new FormData()
  body.append('file', file)
  try {
    await api(`/videos/${id}/${shape}`, { method: 'POST', body })
    bust[shape] = Date.now()
    await refresh()
  } catch (error) {
    toast.add({ title: apiMessage(error, 'Could not upload that image'), color: 'error' })
  }
}

async function resetArtwork(shape: ArtworkShape) {
  await act(`/${shape}`, 'DELETE', 'Back to automatic')
  bust[shape] = Date.now()
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
    toast.add({ title: apiMessage(error, 'Could not add that subtitle'), color: 'error' })
  }
}

const markers = [
  { field: 'introStartSec', label: 'Intro start' },
  { field: 'introEndSec', label: 'Intro end' },
  { field: 'outroStartSec', label: 'Outro start' },
  { field: 'outroEndSec', label: 'Outro end' },
] as const

// Computed, not a literal: an admin editing three videos has three tabs open
// and they should not all read "Edit".
useHead({ title: () => (video.value?.title ? `Edit ${video.value.title}` : 'Edit') })
</script>

<template>
  <div v-if="video" class="space-y-6">
    <div class="flex flex-wrap items-start gap-4">
      <div class="grow">
        <NuxtLink to="/admin/drafts" class="text-sm text-(--ui-text-muted) hover:text-white">
          ← Drafts
        </NuxtLink>
        <h1 class="text-2xl font-bold tracking-tight">{{ video.title }}</h1>
        <div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-(--ui-text-muted)">
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
        <MetadataMatchModal
          kind="video"
          :id="video.id"
          :title="video.title"
          :year="video.year"
          :matched-to="video.tmdbId"
          @applied="refresh"
        />
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
            <div class="flex flex-wrap gap-4">
              <!--
                A film here is a video belonging to no collection, so a video
                needs a year of its own. The schema has accepted one since the
                metadata columns landed; there was simply no control for it.
              -->
              <UFormField label="Year">
                <UInput v-model.number="form.year" type="number" class="w-28" />
              </UFormField>
              <UFormField label="Tags" hint="Comma separated" class="grow">
                <UInput v-model="form.tags" class="w-full" />
              </UFormField>
            </div>
            <UFormField label="Trailer" hint="Paste a YouTube link, or leave empty for none">
              <UInput v-model="form.trailer" class="w-full" placeholder="https://youtu.be/…" />
            </UFormField>
            <UButton :loading="saving" @click="save">Save details</UButton>
          </div>
        </UCard>

        <UCard>
          <template #header>
            <h2 class="font-semibold">Skip markers</h2>
            <p class="text-xs text-(--ui-text-muted)">
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

            <p class="text-sm text-(--ui-text-muted)">
              Playhead at <span class="font-mono text-white">{{ timecode(previewTime) }}</span>
            </p>

            <div class="grid gap-2 sm:grid-cols-2">
              <div
                v-for="marker in markers"
                :key="marker.field"
                class="flex items-center gap-2 rounded-md bg-(--ui-bg-elevated) p-2"
              >
                <span class="w-24 text-sm text-(--ui-text-muted)">{{ marker.label }}</span>
                <span class="font-mono text-sm">
                  {{ video[marker.field] === null ? '—' : timecode(video[marker.field]!) }}
                </span>
                <UButton size="xs" color="neutral" variant="subtle" class="ml-auto" @click="setMarker(marker.field)">
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
          <VideoJobs ref="jobs" :video-id="id" />
        </UCard>

        <MetadataCard
          v-if="video"
          kind="video"
          :record="{ ...video, releaseDate: video.releaseDate ?? null }"
          @saved="refresh"
        />

        <UCard>
          <CreditsEditor :video-id="id" />
        </UCard>

        <UCard>
          <template #header><h2 class="font-semibold">Subtitles</h2></template>
          <ul v-if="subtitles?.items?.length" class="mb-4 divide-y divide-(--ui-border)">
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
              <span class="ml-auto text-xs text-(--ui-text-dimmed)">{{ track.origin }}</span>
            </li>
          </ul>
          <p v-else class="mb-4 text-sm text-(--ui-text-muted)">No subtitle tracks.</p>

          <div class="flex flex-wrap gap-2">
            <label class="cursor-pointer">
              <input type="file" accept=".vtt" class="hidden" @change="uploadSubtitle">
              <span
                class="inline-flex items-center gap-2 rounded-md bg-(--ui-bg-accented) px-3 py-1.5 text-sm hover:bg-(--ui-border-accented)"
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
        <!--
          One panel per shape. Both are captured from the same frame — the
          poster is a 2:3 crop of it — so "capture at 12:04" on each gives two
          different pictures of the same moment rather than the same one twice.
        -->
        <UCard v-for="art in ARTWORK" :key="art.shape">
          <template #header>
            <h2 class="font-semibold">{{ art.label }}</h2>
            <p class="text-xs text-(--ui-text-muted)">
              {{ art.hint }} · {{ artworkSource(art.shape) }}
            </p>
          </template>

          <img
            :src="artworkUrl(art.shape)"
            alt=""
            class="mb-3 rounded bg-(--ui-bg-accented) object-cover"
            :class="art.frame"
          >

          <div class="space-y-2">
            <UButton
              block
              color="neutral"
              variant="subtle"
              icon="i-lucide-crosshair"
              @click="captureArtwork(art.shape)"
            >
              Capture at {{ timecode(previewTime) }}
            </UButton>
            <label class="block cursor-pointer">
              <input
                type="file"
                accept="image/*"
                class="hidden"
                @change="event => uploadArtwork(event, art.shape)"
              >
              <span
                class="flex w-full items-center justify-center gap-2 rounded-md bg-(--ui-bg-accented) px-3 py-1.5 text-sm hover:bg-(--ui-border-accented)"
              >
                <UIcon name="i-lucide-image" class="size-4" /> Upload image
              </span>
            </label>
            <UButton
              block
              variant="ghost"
              color="neutral"
              icon="i-lucide-rotate-ccw"
              @click="resetArtwork(art.shape)"
            >
              Reset to automatic
            </UButton>
          </div>
        </UCard>

        <UCard>
          <template #header><h2 class="font-semibold">Media</h2></template>
          <dl class="space-y-2 text-sm">
            <div class="flex justify-between">
              <dt class="text-(--ui-text-muted)">Size</dt>
              <dd>{{ (Number(video.sizeBytes) / 1024 ** 3).toFixed(2) }} GB</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-(--ui-text-muted)">Audio tracks</dt>
              <dd>{{ video.audioTracks ?? '—' }}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-(--ui-text-muted)">Converted</dt>
              <dd>{{ video.playbackKey ? 'yes' : 'no' }}</dd>
            </div>
          </dl>

          <div class="mt-4 space-y-2">
            <UButton
              block
              color="neutral" variant="subtle"
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
