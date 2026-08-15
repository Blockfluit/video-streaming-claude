<script setup lang="ts">
/**
 * A video's subtitle tracks: what it has, and the three ways to add one.
 *
 * Extracted from the video editor when finding subtitles arrived — the panel
 * had outgrown a corner of a 700-line page, and a track list that can now
 * search a third party, install, and delete is its own thing.
 *
 * Finding is admin-initiated and never automatic. Searching sends this video's
 * title, or a hash of its file, to opensubtitles.com; that is a request leaving
 * a private library, so it happens because somebody clicked and not because a
 * file appeared in a folder.
 */
import type { SubtitleCandidate } from '@video/shared'

const props = defineProps<{ videoId: string }>()

/**
 * Extraction stays with the page: it queues a `MediaJob`, and the page owns the
 * job panel that has to refresh when one appears.
 */
const emit = defineEmits<{ extract: [] }>()

interface SubtitleTrack {
  id: string
  language: string
  label: string
  isDefault: boolean
  origin: string
}

const api = useApi()
const toast = useToast()

const { data: subtitles, refresh } = await useApiData<{ items: SubtitleTrack[] }>(
  `adm-subs-${props.videoId}`,
  `/videos/${props.videoId}/subtitles`,
)

/**
 * Asked once so the button can be hidden rather than offered and then failing.
 * Same reasoning as the metadata dialog, and the same shape of answer.
 */
const { data: status } = await useApiData<{ configured: boolean }>(
  'subtitle-search-status',
  '/subtitles/search/status',
)
const configured = computed(() => status.value?.configured === true)

const finding = ref(false)
const searching = ref(false)
const installing = ref<string | null>(null)
const uploading = ref(false)
const removing = ref<SubtitleTrack | null>(null)
const deleting = ref(false)
const results = ref<SubtitleCandidate[]>([])
const searched = ref(false)
const query = ref('')

interface LanguageOption { code: string, name: string }

/**
 * From the API rather than a table in here: ISO 639 is a standard, and a
 * hand-written copy of one is wrong the moment somebody needs the language it
 * left out. Fetched lazily — a list of 185 languages is not worth loading for
 * every admin who never opens this dialog.
 */
const { data: languages, execute: loadLanguages } = await useApiData<{ items: LanguageOption[] }>(
  'subtitle-languages',
  '/subtitles/languages',
  { immediate: false, server: false },
)

const languageItems = computed(() =>
  (languages.value?.items ?? []).map(language => ({ label: language.name, value: language.code })),
)

/** English by default because it is what most releases are subtitled in. */
const language = ref<{ label: string, value: string }>({ label: 'English', value: 'en' })

/**
 * Reset on every open. Left alone, the dialog reopens showing the results of the
 * last search, which reads as results for this video.
 */
watch(finding, (open) => {
  if (!open) return
  results.value = []
  searched.value = false
  query.value = ''
  void search()
})

async function search() {
  searching.value = true
  try {
    const parameters = new URLSearchParams({ language: language.value.value })
    if (query.value.trim()) parameters.set('query', query.value.trim())

    const page = await api<{ items: SubtitleCandidate[] }>(
      `/videos/${props.videoId}/subtitle-candidates?${parameters}`,
    )
    results.value = page.items
    searched.value = true
  }
  catch (error) {
    toast.add({ title: apiMessage(error, 'Could not search for subtitles'), color: 'error' })
  }
  finally {
    searching.value = false
  }
}

async function install(candidate: SubtitleCandidate) {
  installing.value = candidate.fileId
  try {
    await api(`/videos/${props.videoId}/subtitles/fetch`, {
      method: 'POST',
      body: {
        fileId: candidate.fileId,
        language: candidate.language || language.value.value,
        label: labelFor(candidate),
      },
    })
    finding.value = false
    await refresh()
    toast.add({ title: 'Subtitle added', color: 'success' })
  }
  catch (error) {
    toast.add({ title: apiMessage(error, 'Could not add that subtitle'), color: 'error' })
  }
  finally {
    installing.value = null
  }
}

/**
 * What the track ends up called. The release name is what distinguishes two
 * candidates in the picker but it is not a track name a viewer wants to read in
 * a menu, so it does not become one.
 */
function labelFor(candidate: SubtitleCandidate): string {
  const base = languageItems.value.find(item => item.value === candidate.language)?.label
    ?? candidate.language.toUpperCase()
  return candidate.hearingImpaired ? `${base} (SDH)` : base
}

async function upload(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  const body = new FormData()
  body.append('file', file)
  body.append('language', language.value.value)
  /*
   * The label is required and was never sent, so every upload through this
   * button was a 400 nobody could act on. The file's own name is the only thing
   * here that describes the track, and an admin can see what they picked.
   */
  body.append('label', file.name.replace(/\.[^.]+$/, '').slice(0, 100) || 'Subtitles')

  uploading.value = true
  try {
    await api(`/videos/${props.videoId}/subtitles`, { method: 'POST', body })
    await refresh()
    toast.add({ title: 'Subtitle added', color: 'success' })
  }
  catch (error) {
    // An SRT accepted as .vtt loads as an empty track, so the API sniffs for
    // the WEBVTT signature and this is where that rejection surfaces.
    toast.add({ title: apiMessage(error, 'Could not add that subtitle'), color: 'error' })
  }
  finally {
    uploading.value = false
    // Or picking the same file again after a failure fires no change event.
    input.value = ''
  }
}

/** UModal writes its own open state, so the subject is what is stored. */
const removingOpen = computed({
  get: () => removing.value !== null,
  set: (open: boolean) => {
    if (!open) removing.value = null
  },
})

async function remove(track: SubtitleTrack) {
  deleting.value = true
  try {
    await api(`/subtitles/${track.id}`, { method: 'DELETE' })
    removing.value = null
    await refresh()
    toast.add({ title: 'Subtitle removed', color: 'success' })
  }
  catch (error) {
    toast.add({ title: apiMessage(error, 'Could not remove that subtitle'), color: 'error' })
  }
  finally {
    deleting.value = false
  }
}

/**
 * Whether losing this track loses the only copy. An ingested one is rebuilt from
 * its sidecar on the next scan; the other three came from somewhere that is not
 * coming back on its own.
 */
function isRecoverable(track: SubtitleTrack): boolean {
  return track.origin === 'INGEST'
}

function openFinder() {
  // Fetched on first open and then kept: the list is a frozen standard, so
  // re-asking for it every time the dialog opens buys nothing.
  if (!languages.value) void loadLanguages()
  finding.value = true
}
</script>

<template>
  <section class="space-y-4">
    <h2 class="text-sm font-semibold tracking-wide text-(--ui-text-muted) uppercase">
      Subtitles
    </h2>

    <ul v-if="subtitles?.items?.length" class="divide-y divide-(--ui-border)">
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
        <span class="ml-auto text-xs text-(--ui-text-dimmed)">{{ track.origin.toLowerCase() }}</span>
        <UButton
          size="xs"
          color="error"
          variant="subtle"
          icon="i-lucide-trash-2"
          :aria-label="`Remove the ${track.label} subtitle track`"
          @click="removing = track"
        />
      </li>
    </ul>
    <p v-else class="text-sm text-(--ui-text-muted)">No subtitle tracks.</p>

    <div class="flex flex-wrap gap-2">
      <UButton
        v-if="configured"
        color="neutral"
        variant="subtle"
        icon="i-lucide-search"
        @click="openFinder"
      >
        Find subtitles
      </UButton>

      <label class="cursor-pointer">
        <input type="file" accept=".vtt" class="hidden" :disabled="uploading" @change="upload">
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
        @click="emit('extract')"
      >
        Extract embedded
      </UButton>
    </div>

    <UModal v-model:open="finding" title="Find subtitles" :ui="{ content: 'max-w-3xl' }">
      <template #body>
        <div class="space-y-5">
          <form class="flex flex-wrap items-end gap-2" @submit.prevent="search">
            <UFormField label="Language">
              <USelectMenu
                v-model="language"
                :items="languageItems"
                class="w-48"
                aria-label="Which language to look for"
              />
            </UFormField>
            <UFormField label="Search for" class="min-w-56 flex-1">
              <UInput
                v-model="query"
                placeholder="Leave empty to match this file"
                class="w-full"
              />
            </UFormField>
            <UButton type="submit" :loading="searching" color="neutral" variant="subtle">
              Search
            </UButton>
          </form>

          <ul v-if="results.length" class="divide-y divide-(--ui-border)">
            <li
              v-for="candidate in results"
              :key="candidate.fileId"
              class="flex items-center gap-3 py-3"
            >
              <div class="min-w-0 flex-1 space-y-1">
                <p class="truncate text-sm font-medium">{{ candidate.releaseName }}</p>
                <div class="flex flex-wrap items-center gap-2 text-xs text-(--ui-text-muted)">
                  <!--
                    The one distinction worth a badge: a hash match was timed
                    against this exact file, and a title match was not.
                  -->
                  <UBadge v-if="candidate.fromHash" color="primary" variant="subtle" size="sm">
                    matches this file
                  </UBadge>
                  <span>{{ candidate.format.toUpperCase() }}</span>
                  <span>{{ candidate.downloadCount.toLocaleString() }} downloads</span>
                  <span v-if="candidate.hearingImpaired">SDH</span>
                </div>
              </div>
              <UButton
                size="xs"
                color="neutral"
                variant="subtle"
                :loading="installing === candidate.fileId"
                :disabled="installing !== null"
                @click="install(candidate)"
              >
                Use this
              </UButton>
            </li>
          </ul>

          <p v-else-if="searched && !searching" class="text-sm text-(--ui-text-muted)">
            Nothing found for this video in that language. Try typing a different title above —
            a release is often catalogued under a name the library does not use.
          </p>
        </div>
      </template>

      <template #footer>
        <div class="flex w-full justify-end">
          <UButton color="neutral" variant="ghost" @click="finding = false">Close</UButton>
        </div>
      </template>
    </UModal>

    <!--
      A dialog because for three of the four origins this is the only copy:
      an uploaded, downloaded or extracted track has no source to rebuild it
      from. The title says which, rather than asking "are you sure?".
    -->
    <UModal
      v-model:open="removingOpen"
      :title="removing ? `Remove the ${removing.label} track` : ''"
    >
      <template #body>
        <p v-if="removing" class="text-sm">
          <template v-if="isRecoverable(removing)">
            This track came from a sidecar file next to the video, so the next scan puts it back.
          </template>
          <template v-else>
            This is the only copy — it was {{ removing.origin.toLowerCase() }}, so nothing on disk
            will bring it back. Finding or uploading it again is the way to undo this.
          </template>
        </p>
      </template>
      <template #footer>
        <div class="flex w-full gap-2">
          <UButton color="neutral" variant="subtle" @click="removing = null">Cancel</UButton>
          <UButton
            class="ml-auto"
            color="error"
            :loading="deleting"
            @click="removing && remove(removing)"
          >
            Remove this track
          </UButton>
        </div>
      </template>
    </UModal>
  </section>
</template>
