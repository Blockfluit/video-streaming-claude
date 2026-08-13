<script setup lang="ts">
/**
 * Matching a title against TMDB, and choosing what to keep.
 *
 * Three steps, in one dialog: search, pick a candidate, then approve a diff
 * field by field. The third step is the point — an import that just overwrote
 * everything would need a source column per field to be safe, and this needs
 * none, because a person has looked at both values.
 */
import type { MetadataField } from '@video/shared'

import type { ArtworkShape } from '~/composables/useArtworkBust'

const props = defineProps<{
  kind: 'collection' | 'video'
  id: string
  title: string
  year?: number | null
  /** Already matched, so the dialog can say so rather than offering a first match. */
  matchedTo?: number | null
}>()

/**
 * Which pictures the import replaced, so the page can re-request exactly those.
 *
 * Told rather than inferred: the record the page refetches afterwards reads the same
 * either way — `posterSource` may already have been MANUAL, and a collection's
 * `posterKey` may already have been set — so this dialog is the only thing that knows.
 */
const emit = defineEmits<{ applied: [replaced: ArtworkShape[]] }>()

const api = useApi()
const toast = useToast()

const open = ref(false)
const query = ref(props.title)
const kindFilter = ref<'both' | 'movie' | 'tv'>('both')
const searching = ref(false)
const applying = ref(false)

interface Candidate {
  tmdbId: number
  tmdbType: 'movie' | 'tv'
  title: string
  year: number | null
  description: string | null
  posterPath: string | null
}

interface FieldDiff {
  field: MetadataField
  current: unknown
  proposed: unknown
  changed: boolean
  suggested: boolean
}

interface Preview {
  tmdbId: number
  tmdbType: 'movie' | 'tv'
  imdbId: string | null
  fields: FieldDiff[]
  credits: { cast: number, crew: number }
  artwork: { poster: boolean, banner: boolean, posterIsManual: boolean, bannerIsManual: boolean }
  episodes: { seasons: number } | null
}

const candidates = ref<Candidate[]>([])
const preview = ref<Preview | null>(null)
const chosen = ref<Candidate | null>(null)

/** Which field checkboxes are ticked. Seeded from the diff's own suggestion. */
const picked = ref<Set<MetadataField>>(new Set())
const includeCredits = ref(true)
const includeArtwork = ref(true)
const includeEpisodes = ref(true)

/**
 * Whether the feature is switched on at all.
 *
 * Asked once so the button can be *hidden* rather than offered and then failing
 * — a control that always errors is worse than one that is not there.
 */
const { data: status } = await useApiData<{ configured: boolean }>(
  'metadata-status',
  '/admin/metadata/status',
)
const configured = computed(() => status.value?.configured === true)

/**
 * Reset on every open. Left alone, the dialog reopens showing the diff of
 * whatever was matched last time, which reads as a match that has already
 * happened.
 */
watch(open, (isOpen) => {
  if (!isOpen) return
  query.value = props.title
  candidates.value = []
  preview.value = null
  chosen.value = null
  void search()
})

async function search() {
  if (query.value.trim().length === 0) return
  searching.value = true
  try {
    const params = new URLSearchParams({ title: query.value.trim(), limit: '10' })
    if (kindFilter.value !== 'both') params.set('type', kindFilter.value)
    if (props.year) params.set('year', String(props.year))

    const page = await api<{ items: Candidate[] }>(`/admin/metadata/search?${params}`)
    candidates.value = page.items
    if (page.items.length === 0) {
      toast.add({ title: 'Nothing matched that title', color: 'warning' })
    }
  }
  catch (error) {
    toast.add({ title: apiMessage(error, 'Could not search'), color: 'error' })
  }
  finally {
    searching.value = false
  }
}

async function choose(candidate: Candidate) {
  chosen.value = candidate
  preview.value = null
  try {
    const result = await api<Preview>(
      `/admin/metadata/${props.kind}s/${props.id}/preview?tmdbId=${candidate.tmdbId}&type=${candidate.tmdbType}`,
    )
    preview.value = result
    picked.value = new Set(result.fields.filter(f => f.suggested).map(f => f.field))
  }
  catch (error) {
    chosen.value = null
    toast.add({ title: apiMessage(error, 'Could not read that title'), color: 'error' })
  }
}

function toggle(field: MetadataField, on: boolean) {
  const next = new Set(picked.value)
  if (on) next.add(field)
  else next.delete(field)
  picked.value = next
}

async function apply() {
  if (!chosen.value) return
  applying.value = true
  try {
    await api(`/admin/metadata/${props.kind}s/${props.id}/apply`, {
      method: 'POST',
      body: {
        tmdbId: chosen.value.tmdbId,
        type: chosen.value.tmdbType,
        fields: [...picked.value],
        includeCredits: includeCredits.value,
        includeArtwork: includeArtwork.value,
        includeEpisodes: includeEpisodes.value && preview.value?.episodes !== null,
      },
    })

    // The tick alone is not the answer: `includeArtwork` stays true while its checkbox is
    // hidden, which is what a title TMDB has no artwork for gets, and TMDB may hold one
    // shape and not the other. Naming a picture that never moved would reload it.
    const replaced = includeArtwork.value
      ? (['poster', 'banner'] as const).filter(shape => preview.value?.artwork[shape])
      : []

    open.value = false
    emit('applied', replaced)
    toast.add({ title: 'Metadata imported', color: 'success' })
  }
  catch (error) {
    toast.add({ title: apiMessage(error, 'Could not import that'), color: 'error' })
  }
  finally {
    applying.value = false
  }
}

/** Only the fields that would actually change. The rest is a wall of "same". */
const changes = computed(() => preview.value?.fields.filter(field => field.changed) ?? [])

const FIELD_LABELS: Partial<Record<MetadataField, string>> = {
  title: 'Title',
  description: 'Synopsis',
  tagline: 'Tagline',
  year: 'Year',
  releaseDate: 'Release date',
  genres: 'Genres',
  certification: 'Age rating',
  originalTitle: 'Original title',
  originalLanguage: 'Original language',
  tmdbRating: 'Rating',
  seriesStatus: 'Status',
  seasonCount: 'Seasons',
  episodeCount: 'Episodes',
  trailerYoutubeId: 'Trailer',
}

function show(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—'
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) return value.slice(0, 10)
  return String(value)
}
</script>

<template>
  <div v-if="configured">
    <UButton color="neutral" variant="subtle" icon="i-lucide-sparkles" @click="open = true">
      {{ matchedTo ? 'Re-import metadata' : 'Find metadata' }}
    </UButton>

    <UModal v-model:open="open" title="Find metadata" :ui="{ content: 'max-w-3xl' }">
      <template #body>
        <div class="space-y-5">
          <form class="flex flex-wrap items-end gap-2" @submit.prevent="search">
            <UFormField label="Title" class="min-w-56 flex-1">
              <UInput v-model="query" placeholder="Search TMDB" class="w-full" />
            </UFormField>
            <UFormField label="Kind">
              <USelect
                v-model="kindFilter"
                :items="[
                  { label: 'Film or series', value: 'both' },
                  { label: 'Film', value: 'movie' },
                  { label: 'Series', value: 'tv' },
                ]"
              />
            </UFormField>
            <UButton type="submit" :loading="searching" color="neutral" variant="subtle">
              Search
            </UButton>
          </form>

          <!-- Step two: which of these is it. -->
          <ul v-if="!chosen && candidates.length" class="divide-y divide-(--ui-border)">
            <li v-for="candidate in candidates" :key="`${candidate.tmdbType}-${candidate.tmdbId}`">
              <button
                type="button"
                class="w-full space-y-1 py-3 text-left transition-colors hover:bg-(--ui-bg-elevated)"
                @click="choose(candidate)"
              >
                <div class="flex items-center gap-2">
                  <span class="font-medium">{{ candidate.title }}</span>
                  <span class="text-sm text-(--ui-text-muted)">{{ candidate.year ?? '' }}</span>
                  <UBadge color="neutral" variant="outline" size="sm">
                    {{ candidate.tmdbType === 'tv' ? 'Series' : 'Film' }}
                  </UBadge>
                </div>
                <p v-if="candidate.description" class="line-clamp-2 text-sm text-(--ui-text-muted)">
                  {{ candidate.description }}
                </p>
              </button>
            </li>
          </ul>

          <!-- Step three: what it would change. -->
          <div v-if="chosen && preview" class="space-y-4">
            <div class="flex items-center justify-between gap-3">
              <p class="text-sm">
                Matched to <strong>{{ chosen.title }}</strong>
                <span v-if="chosen.year" class="text-(--ui-text-muted)"> ({{ chosen.year }})</span>
              </p>
              <UButton size="xs" color="neutral" variant="ghost" @click="chosen = null">
                Pick another
              </UButton>
            </div>

            <p v-if="changes.length === 0" class="text-sm text-(--ui-text-muted)">
              Nothing here differs from what is already stored.
            </p>

            <table v-else class="w-full text-sm">
              <thead class="text-left text-xs uppercase tracking-wide text-(--ui-text-muted)">
                <tr>
                  <th class="w-8 pb-2" />
                  <th class="pb-2">Field</th>
                  <th class="pb-2">Now</th>
                  <th class="pb-2">Would become</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-(--ui-border)">
                <tr v-for="field in changes" :key="field.field">
                  <td class="py-2 align-top">
                    <UCheckbox
                      :model-value="picked.has(field.field)"
                      :aria-label="`Import ${FIELD_LABELS[field.field] ?? field.field}`"
                      @update:model-value="toggle(field.field, $event === true)"
                    />
                  </td>
                  <td class="py-2 align-top">{{ FIELD_LABELS[field.field] ?? field.field }}</td>
                  <td class="py-2 align-top text-(--ui-text-muted)">
                    <span class="line-clamp-3">{{ show(field.current) }}</span>
                  </td>
                  <td class="py-2 align-top">
                    <span class="line-clamp-3">{{ show(field.proposed) }}</span>
                  </td>
                </tr>
              </tbody>
            </table>

            <div class="space-y-2 border-t border-(--ui-border) pt-4">
              <UCheckbox
                v-model="includeCredits"
                :label="`Cast and crew (${preview.credits.cast} cast, ${preview.credits.crew} crew)`"
              />
              <UCheckbox v-if="preview.artwork.poster || preview.artwork.banner" v-model="includeArtwork">
                <template #label>
                  Artwork
                  <!--
                    Said out loud rather than skipped quietly. Somebody who chose
                    a poster by hand should be told this replaces it.
                  -->
                  <span
                    v-if="preview.artwork.posterIsManual || preview.artwork.bannerIsManual"
                    class="text-(--ui-text-muted)"
                  >
                    — replaces artwork you chose by hand
                  </span>
                </template>
              </UCheckbox>
              <UCheckbox
                v-if="preview.episodes"
                v-model="includeEpisodes"
                :label="`Episode titles and synopses (${preview.episodes.seasons} seasons)`"
              />
            </div>
          </div>
        </div>
      </template>

      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="open = false">Cancel</UButton>
          <UButton :disabled="!preview" :loading="applying" @click="apply">Import</UButton>
        </div>
      </template>
    </UModal>

    <p class="sr-only">Metadata from TMDB.</p>
  </div>
</template>
