<script setup lang="ts">
/**
 * What an import wrote, visible and correctable.
 *
 * Everything here was previously stored and shown to viewers but invisible to
 * the admin who owns it — you could import a synopsis and an age rating and then
 * have no way to see, let alone fix, either. Reported as "I wish to see the
 * newly fetched data on the edit page and also be able to change it manually".
 *
 * It saves on its own rather than joining the Details form. The two are edited
 * at different moments — Details when a title is first curated, this after an
 * import — and one Save button that writes both means a stale copy of one
 * silently overwrites the other.
 *
 * Shared by the video and collection screens because a film here is a video
 * belonging to no collection, so both carry the same fields.
 */
interface MetadataRecord {
  id: string
  updatedAt?: string
  tagline?: string | null
  genres?: string[]
  certification?: string | null
  originalTitle?: string | null
  originalLanguage?: string | null
  releaseDate?: string | null
  imdbId?: string | null
  tmdbId?: number | null
  tmdbType?: string | null
  tmdbRating?: number | null
  tmdbVoteCount?: number | null
  seriesStatus?: string | null
  seasonCount?: number | null
  episodeCount?: number | null
  metadataUpdatedAt?: string | null
}

const props = defineProps<{
  kind: 'video' | 'collection'
  record: MetadataRecord
}>()

const emit = defineEmits<{ saved: [] }>()

const api = useApi()
const toast = useToast()

const saving = ref(false)
const unmatching = ref(false)

const form = reactive({
  tagline: '',
  genres: '',
  certification: '',
  originalTitle: '',
  originalLanguage: '',
  releaseDate: '',
  imdbId: '',
})

/**
 * Seeded explicitly rather than by a `watchEffect`.
 *
 * An effect re-runs on every refresh and throws away whatever is being typed;
 * seeding once never picks up an import. Keying on `updatedAt` does both: the
 * form re-reads exactly when the server record actually changed.
 */
function resetForm() {
  form.tagline = props.record.tagline ?? ''
  form.genres = (props.record.genres ?? []).join(', ')
  form.certification = props.record.certification ?? ''
  form.originalTitle = props.record.originalTitle ?? ''
  form.originalLanguage = props.record.originalLanguage ?? ''
  // `<input type="date">` wants YYYY-MM-DD; the column is a timestamp.
  form.releaseDate = props.record.releaseDate ? props.record.releaseDate.slice(0, 10) : ''
  form.imdbId = props.record.imdbId ?? ''
}

resetForm()
watch(() => props.record.updatedAt, resetForm)

const matched = computed(() => typeof props.record.tmdbId === 'number')

const tmdbUrl = computed(() =>
  matched.value
    ? `https://www.themoviedb.org/${props.record.tmdbType}/${props.record.tmdbId}`
    : null,
)

async function save() {
  saving.value = true
  try {
    await api(`/${props.kind}s/${props.record.id}`, {
      method: 'PATCH',
      body: {
        tagline: form.tagline,
        genres: form.genres.split(',').map(g => g.trim()).filter(Boolean),
        certification: form.certification,
        originalTitle: form.originalTitle,
        originalLanguage: form.originalLanguage || null,
        releaseDate: form.releaseDate,
        // Sent as typed. The API parses a pasted imdb.com link down to the id
        // and refuses what it cannot read, so a mistyped one is a message on
        // this form rather than a link that quietly goes nowhere.
        imdbId: form.imdbId,
      },
    })
    emit('saved')
    toast.add({ title: 'Metadata saved', color: 'success' })
  }
  catch (error) {
    toast.add({ title: apiMessage(error, 'Could not save that'), color: 'error' })
  }
  finally {
    saving.value = false
  }
}

/**
 * Forgets which TMDB title this is. Keeps everything imported from it — those
 * were approved one at a time, and unmatching says "this is not that title",
 * not "throw away my work".
 */
async function unmatch() {
  unmatching.value = true
  try {
    await api(`/admin/metadata/${props.kind}s/${props.record.id}/match`, { method: 'DELETE' })
    emit('saved')
    toast.add({ title: 'Match cleared', color: 'success' })
  }
  catch (error) {
    toast.add({ title: apiMessage(error, 'Could not clear the match'), color: 'error' })
  }
  finally {
    unmatching.value = false
  }
}
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="font-semibold">Metadata</h2>
        <p v-if="record.metadataUpdatedAt" class="text-xs text-(--ui-text-muted)">
          <!-- `shortDate`, not `toLocaleDateString`: the locale and time zone are
               pinned there, and the ambient ones differ between Nitro and the
               browser — which renders two different days and costs the subtree. -->
          Imported {{ shortDate(record.metadataUpdatedAt) }}
        </p>
      </div>
    </template>

    <div class="space-y-4">
      <UFormField label="Tagline">
        <UInput v-model="form.tagline" class="w-full" placeholder="One line under the title" />
      </UFormField>

      <!--
        Visibly its own control, not a second field that looks like Tags. The
        two are separately owned — tags are curated, genres are the provider's —
        and one column shared between them means a re-import cannot tell which
        entries it may replace.
      -->
      <UFormField label="Genres" hint="Comma separated · replaced by an import">
        <UInput v-model="form.genres" class="w-full" placeholder="Drama, Thriller" />
      </UFormField>

      <div class="flex flex-wrap gap-4">
        <UFormField label="Age rating">
          <UInput v-model="form.certification" class="w-32" placeholder="PG-13" />
        </UFormField>
        <UFormField label="Released">
          <UInput v-model="form.releaseDate" type="date" class="w-44" />
        </UFormField>
        <UFormField label="Original language">
          <UInput v-model="form.originalLanguage" class="w-24" placeholder="en" />
        </UFormField>
      </div>

      <UFormField label="Original title">
        <UInput v-model="form.originalTitle" class="w-full" />
      </UFormField>

      <UFormField label="IMDb" hint="An id or an imdb.com link">
        <div class="flex items-center gap-2">
          <UInput v-model="form.imdbId" class="w-full" placeholder="tt1179933" />
          <ImdbLink :imdb-id="record.imdbId" :label="'This title'" />
        </div>
      </UFormField>

      <UButton :loading="saving" @click="save">Save metadata</UButton>

      <!--
        The provider's own facts, read-only. A hand-edited "TMDB rating" would be
        a lie, and there is no reason anyone would want to type one.
      -->
      <div class="space-y-2 border-t border-(--ui-border) pt-4 text-sm">
        <div v-if="matched" class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span class="text-(--ui-text-muted)">Matched to</span>
          <a
            :href="tmdbUrl!"
            target="_blank"
            rel="noopener noreferrer"
            class="underline hover:text-(--ui-text)"
          >
            TMDB {{ record.tmdbType }} {{ record.tmdbId }}
          </a>
          <span v-if="record.tmdbRating" class="text-(--ui-text-muted)">
            {{ record.tmdbRating.toFixed(1) }} ★
            <template v-if="record.tmdbVoteCount">({{ record.tmdbVoteCount }} votes)</template>
          </span>
          <span v-if="record.seasonCount" class="text-(--ui-text-muted)">
            {{ record.seasonCount }} seasons · {{ record.episodeCount }} episodes
            <template v-if="record.seriesStatus">· {{ record.seriesStatus }}</template>
          </span>
          <UButton
            size="xs"
            color="neutral"
            variant="subtle"
            :loading="unmatching"
            class="ml-auto"
            @click="unmatch"
          >
            Unmatch
          </UButton>
        </div>
        <p v-else class="text-(--ui-text-muted)">
          Not matched to TMDB. Everything above can still be filled in by hand.
        </p>
      </div>
    </div>
  </UCard>
</template>
