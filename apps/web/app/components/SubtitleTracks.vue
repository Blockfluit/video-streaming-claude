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

const props = defineProps<{
  videoId: string
  /** AUTO lets the English rule choose; MANUAL means an admin already has. */
  defaultSource: string
}>()

/**
 * `extract` stays with the page: it queues a `MediaJob`, and the page owns the
 * job panel that has to refresh when one appears. `changed` says the video row
 * itself needs re-reading, which is true whenever the default may have moved —
 * `subtitleDefaultSource` is on the video, and the track list alone cannot show
 * whether the choice was automatic.
 */
const emit = defineEmits<{ extract: [], changed: [] }>()

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
 * Today's remaining downloads.
 *
 * The free allowance is about twenty a day, which is small enough that reaching
 * it is an ordinary afternoon — so it is worth saying before somebody clicks
 * rather than after. Null means this server has no such number (it can search
 * but has no account), which is different from an allowance of nothing; that
 * distinction lives in `quotaNotice`, where it is tested.
 */
const quota = ref<SubtitleQuota | null>(null)
const notice = computed(() => quotaNotice(quota.value))

/**
 * Failing quietly, deliberately. The allowance is an aside; if reading it goes
 * wrong the picker still works, and an error toast about a number nobody asked
 * for would be noise on top of whatever actually broke.
 */
async function readQuota() {
  try {
    const response = await api<{ quota: SubtitleQuota | null }>('/subtitles/search/quota')
    quota.value = response.quota
  }
  catch {
    quota.value = null
  }
}

const exhausted = computed(() => notice.value?.exhausted === true)

/**
 * Reset on every open. Left alone, the dialog reopens showing the results of the
 * last search, which reads as results for this video.
 */
watch(finding, (open) => {
  if (!open) return
  results.value = []
  searched.value = false
  query.value = ''
  void readQuota()
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
    // A downloaded English track can become the default, exactly like an
    // uploaded one, so the video row may have moved too.
    emit('changed')
    toast.add({ title: 'Subtitle added', color: 'success' })
    // One fewer than a moment ago. Re-read rather than decrement: the allowance
    // is shared with anything else using this account, so our arithmetic would
    // drift from the truth the first time it was.
    void readQuota()
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

/**
 * A language's English name, from the platform rather than from a list.
 *
 * `Intl.DisplayNames` ships with the browser and knows both the two- and
 * three-letter forms, so there is no table here to fall out of date. It throws
 * on a code it cannot parse at all, which is why the code itself is the
 * fallback — an admin typing a private code still gets a usable label.
 *
 * This answers "what is this code called". `GET /subtitles/languages` answers
 * the different question "which codes are there", which `Intl` cannot: it names
 * a code but does not enumerate them. Two questions, not two answers to one.
 */
function languageLabel(code: string): string {
  const trimmed = code.trim().toLowerCase()
  if (!trimmed) return ''

  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(trimmed) ?? trimmed
  }
  catch {
    return trimmed
  }
}

/**
 * The upload form.
 *
 * `label` is required by the endpoint and the old form never sent it, so that
 * button returned a 400 for every file it was ever given. The language is asked
 * for rather than assumed to be English.
 */
const subtitleUpload = reactive({ open: false, language: 'en', label: '', file: null as File | null })

function pickSubtitleFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] ?? null
  subtitleUpload.file = file
  // A label nobody edits still has to be something, and the language is the
  // only thing we know about the track at this point.
  if (file && !subtitleUpload.label) subtitleUpload.label = languageLabel(subtitleUpload.language)
  subtitleUpload.open = Boolean(file)
  // Or picking the same file again after a cancel fires no change event.
  input.value = ''
}

async function upload() {
  if (!subtitleUpload.file) return

  const body = new FormData()
  body.append('file', subtitleUpload.file)
  body.append('language', subtitleUpload.language.trim().toLowerCase())
  body.append('label', subtitleUpload.label.trim() || languageLabel(subtitleUpload.language))

  uploading.value = true
  try {
    await api(`/videos/${props.videoId}/subtitles`, { method: 'POST', body })
    subtitleUpload.open = false
    subtitleUpload.file = null
    subtitleUpload.label = ''
    await refresh()
    // An uploaded English track can become the default on its own.
    emit('changed')
    toast.add({ title: 'Subtitle added', color: 'success' })
  }
  catch (error) {
    // An SRT accepted as .vtt loads as an empty track, so the API sniffs for
    // the WEBVTT signature and this is where that rejection surfaces.
    toast.add({ title: apiMessage(error, 'Could not add that subtitle'), color: 'error' })
  }
  finally {
    uploading.value = false
  }
}

/**
 * Reka UI reserves the empty string for "cleared" and throws during render if
 * an option uses it — which takes the whole page down, not just the select.
 */
const AUTO_DEFAULT = '__auto__'
const NO_DEFAULT = '__none__'

const defaultChoice = computed(() => {
  if (props.defaultSource !== 'MANUAL') return AUTO_DEFAULT
  return subtitles.value?.items?.find(track => track.isDefault)?.id ?? NO_DEFAULT
})

const defaultOptions = computed(() => [
  { label: 'Automatic (English)', value: AUTO_DEFAULT },
  { label: 'No default', value: NO_DEFAULT },
  ...(subtitles.value?.items ?? []).map(track => ({
    label: `${track.label} (${track.language})`,
    value: track.id,
  })),
])

async function chooseDefault(value: string) {
  const body
    = value === AUTO_DEFAULT
      ? { mode: 'AUTO' }
      : { mode: 'MANUAL', subtitleId: value === NO_DEFAULT ? null : value }

  try {
    await api(`/videos/${props.videoId}/subtitles/default`, { method: 'PUT', body })
    // Both change: the track list carries isDefault, the video carries whether
    // the choice is a choice at all.
    await refresh()
    emit('changed')
  }
  catch (error) {
    toast.add({ title: apiMessage(error, 'Could not set the default track'), color: 'error' })
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
    // Removing the default lets another English track take over.
    emit('changed')
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
        class="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm"
      >
        <!-- A label like "English (SDH) - forced" plus two badges, an origin
             and a delete button is past 343px on its own, and the label is the
             only part that can give. -->
        <span class="min-w-0 truncate font-medium">{{ track.label }}</span>
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
          class="tap justify-center"
          :aria-label="`Remove the ${track.label} subtitle track`"
          @click="removing = track"
        />
      </li>
    </ul>
    <p v-else class="text-sm text-(--ui-text-muted)">No subtitle tracks.</p>

    <div v-if="subtitles?.items?.length">
      <label for="subtitle-default" class="mb-1 block text-sm text-(--ui-text-muted)">
        Default track
      </label>
      <USelect
        id="subtitle-default"
        :model-value="defaultChoice"
        :items="defaultOptions"
        class="w-full"
        aria-label="Default subtitle track"
        @update:model-value="(value: string) => chooseDefault(value)"
      />
      <p class="mt-1 text-xs text-(--ui-text-dimmed)">
        Automatic picks the English track, and leaves the video without one when there is
        no English track to pick.
      </p>
    </div>

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
        <input type="file" accept=".vtt" class="hidden" @change="pickSubtitleFile">
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

    <!--
      The language and label are asked for rather than assumed. The old form
      hardcoded `en` and sent no label at all, which the endpoint requires — so
      every upload it ever attempted came back a 400.
    -->
    <UModal v-model:open="subtitleUpload.open" title="Add a subtitle track">
      <template #body>
        <div class="space-y-4">
          <p class="text-sm text-(--ui-text-muted)">{{ subtitleUpload.file?.name }}</p>
          <UFormField label="Language" help="An ISO 639 code, such as en, nl or eng.">
            <UInput
              v-model="subtitleUpload.language"
              aria-label="Subtitle language code"
              @blur="subtitleUpload.label ||= languageLabel(subtitleUpload.language)"
            />
          </UFormField>
          <UFormField label="Label" help="What the viewer picks from in the track menu.">
            <UInput v-model="subtitleUpload.label" aria-label="Subtitle track label" />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton variant="subtle" color="neutral" @click="subtitleUpload.open = false">
            Cancel
          </UButton>
          <UButton
            variant="solid"
            :loading="uploading"
            :disabled="!subtitleUpload.language.trim()"
            @click="upload"
          >
            Add track
          </UButton>
        </div>
      </template>
    </UModal>

    <UModal v-model:open="finding" title="Find subtitles" :ui="{ content: 'max-w-3xl' }">
      <template #body>
        <div class="space-y-5">
          <form class="flex flex-wrap items-end gap-2" @submit.prevent="search">
            <UFormField label="Language">
              <USelectMenu
                v-model="language"
                :items="languageItems"
                class="w-full sm:w-48"
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

          <!--
            Only when there is a number to show. A server that can search but
            has no account has no allowance, and inventing "0 of 0" for it would
            read as exhausted rather than absent.
          -->
          <p
            v-if="notice"
            class="text-sm"
            :class="notice.exhausted ? 'text-(--ui-text)' : 'text-(--ui-text-muted)'"
          >
            {{ notice.text }}
          </p>

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
              <!--
                Disabled once the allowance is gone, rather than left clickable
                to fail: the refusal comes back from a machine the admin has
                never heard of, and one they can see coming reads very
                differently from one they cannot.
              -->
              <UButton
                size="xs"
                color="neutral"
                variant="subtle"
                :loading="installing === candidate.fileId"
                :disabled="installing !== null || exhausted"
                :title="exhausted ? 'No downloads left today' : undefined"
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
