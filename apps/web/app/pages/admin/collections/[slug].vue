<script setup lang="ts">
/**
 * A collection's own editor: details, seasons, credits and how it is doing.
 *
 * Until this existed the admin screens could edit a *video* and nothing else.
 * A collection's title, its state, its seasons and its cast were all reachable
 * only through the API, which meant a show's shared credits — the ones every
 * episode inherits — could not be entered anywhere at all.
 *
 * Routed by slug rather than id because the detail endpoint is slug-based and
 * slugs are stable once created; the id it returns is what the writes use.
 */
definePageMeta({ layout: 'admin', middleware: 'admin' })

interface Season {
  id: string
  number: number | null
  slug: string
  title: string | null
  description: string | null
}

interface VideoRow {
  id: string
  slug: string
  title: string
  seasonId: string | null
  orderIndex: number | null
  state: string
  durationSec: number | null
  width: number | null
  height: number | null
}

interface CollectionDetail {
  id: string
  slug: string
  title: string
  description: string | null
  year: number | null
  tags: string[]
  state: string
  seasons: Season[]
  videos: VideoRow[]
}

interface Stats {
  videoCount: number
  totals: {
    viewers: number
    views: number
    secondsWatched: number
    completions: number
    averageCompletion: number | null
  }
}

const route = useRoute()
const api = useApi()
const toast = useToast()
const slug = computed(() => String(route.params.slug))

const { data: collection, refresh } = await useApiData<CollectionDetail>(
  () => `adm-collection-${slug.value}`,
  () => `/collections/${slug.value}`,
  { watch: [slug] },
)

if (!collection.value) {
  throw createError({ statusCode: 404, statusMessage: 'No such collection', fatal: true })
}

// Aggregate figures are ADMIN-only, which is exactly who is on this page.
const { data: stats } = await useApiData<Stats>(
  () => `adm-collection-stats-${slug.value}`,
  () => `/collections/${collection.value?.id}/stats`,
  { watch: [slug] },
)

const form = reactive({
  title: collection.value.title,
  description: collection.value.description ?? '',
  year: collection.value.year,
  tags: collection.value.tags.join(', '),
})
const saving = ref(false)

async function save() {
  saving.value = true
  try {
    await api(`/collections/${collection.value!.id}`, {
      method: 'PATCH',
      body: {
        title: form.title,
        description: form.description || null,
        year: form.year ?? undefined,
        tags: form.tags.split(',').map(t => t.trim()).filter(Boolean),
      },
    })
    await refresh()
    toast.add({ title: 'Saved', color: 'success' })
  }
  catch (error) {
    toast.add({ title: apiMessage(error, 'Could not save that'), color: 'error' })
  }
  finally {
    saving.value = false
  }
}

async function setState(action: 'publish' | 'archive') {
  try {
    await api(`/collections/${collection.value!.id}/${action}`, { method: 'POST' })
    await refresh()
    toast.add({ title: action === 'publish' ? 'Published' : 'Archived', color: 'success' })
  }
  catch (error) {
    toast.add({ title: apiMessage(error, `Could not ${action} it`), color: 'error' })
  }
}

/* --- seasons --------------------------------------------------------- */

const newSeasonNumber = ref<number | null>(null)

async function addSeason() {
  try {
    await api('/seasons', {
      method: 'POST',
      body: {
        collectionId: collection.value!.id,
        // Left off entirely rather than sent as null: "Specials" is a season
        // with no number, and the schema treats absent and 0 differently.
        ...(newSeasonNumber.value === null ? {} : { number: newSeasonNumber.value }),
      },
    })
    newSeasonNumber.value = null
    await refresh()
  }
  catch (error) {
    toast.add({ title: apiMessage(error, 'Could not add that season'), color: 'error' })
  }
}

async function removeSeason(season: Season) {
  // Files are kept unless asked otherwise — reconcile rebuilds the rows on the
  // next scan, so the default is the recoverable mistake.
  try {
    await api(`/seasons/${season.id}`, { method: 'DELETE' })
    await refresh()
    toast.add({ title: 'Season removed', color: 'success' })
  }
  catch (error) {
    toast.add({ title: apiMessage(error, 'Could not remove it'), color: 'error' })
  }
}

/** Videos grouped under their season, with loose ones last. */
const grouped = computed(() => {
  const detail = collection.value
  if (!detail) return []

  const bySeason = detail.seasons.map(season => ({
    season,
    videos: detail.videos.filter(v => v.seasonId === season.id),
  }))
  const loose = detail.videos.filter(v => v.seasonId === null)
  return loose.length > 0 ? [...bySeason, { season: null, videos: loose }] : bySeason
})

function seasonLabel(season: Season | null): string {
  if (!season) return 'Not in a season'
  if (season.title) return season.title
  return season.number === null ? 'Unnumbered season' : `Season ${season.number}`
}

/** Seconds as something a person reads at a glance. */
function watchTime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.round((seconds % 3600) / 60)
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

useHead(() => ({ title: collection.value?.title ?? 'Collection' }))
</script>

<template>
  <div v-if="collection" class="space-y-6">
    <div class="flex flex-wrap items-center gap-3">
      <h1 class="text-2xl font-bold tracking-tight">{{ collection.title }}</h1>
      <UBadge :color="collection.state === 'PUBLISHED' ? 'success' : 'neutral'" variant="subtle">
        {{ collection.state }}
      </UBadge>
      <div class="ml-auto flex gap-2">
        <UButton :to="`/c/${collection.slug}`" color="neutral" variant="subtle" icon="i-lucide-eye">
          View
        </UButton>
        <UButton
          v-if="collection.state !== 'PUBLISHED'"
          icon="i-lucide-check"
          @click="setState('publish')"
        >
          Publish
        </UButton>
        <UButton
          v-else
          color="neutral"
          variant="subtle"
          icon="i-lucide-archive"
          @click="setState('archive')"
        >
          Archive
        </UButton>
      </div>
    </div>

    <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
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
            <div class="flex gap-4">
              <UFormField label="Year">
                <UInput v-model.number="form.year" type="number" class="w-32" />
              </UFormField>
              <UFormField label="Tags" class="grow" hint="Comma separated">
                <UInput v-model="form.tags" class="w-full" />
              </UFormField>
            </div>
            <UButton :loading="saving" @click="save">Save changes</UButton>
          </div>
        </UCard>

        <UCard>
          <!-- The same editor the video page uses. A credit entered here is
               inherited by every episode, which is the whole point of it. -->
          <CreditsEditor :collection-id="collection.id" />
        </UCard>

        <UCard>
          <template #header><h2 class="font-semibold">Seasons and episodes</h2></template>

          <div class="mb-4 flex items-end gap-2">
            <UFormField label="Add a season" hint="Leave blank for specials">
              <UInput
                v-model.number="newSeasonNumber"
                type="number"
                placeholder="Number"
                class="w-32"
              />
            </UFormField>
            <UButton color="neutral" variant="subtle" @click="addSeason">Add</UButton>
          </div>

          <div v-if="grouped.length" class="space-y-4">
            <div v-for="group in grouped" :key="group.season?.id ?? 'loose'">
              <div class="mb-2 flex items-center gap-2">
                <h3 class="text-sm font-semibold tracking-wide text-(--ui-text-muted) uppercase">
                  {{ seasonLabel(group.season) }}
                </h3>
                <span class="text-xs text-(--ui-text-dimmed)">{{ group.videos.length }}</span>
                <UButton
                  v-if="group.season"
                  class="ml-auto"
                  size="xs"
                  color="error"
                  variant="subtle"
                  :aria-label="`Remove ${seasonLabel(group.season)}`"
                  icon="i-lucide-trash-2"
                  @click="removeSeason(group.season)"
                />
              </div>

              <ul v-if="group.videos.length" class="divide-y divide-(--ui-border)">
                <li
                  v-for="video in group.videos"
                  :key="video.id"
                  class="flex items-center gap-3 py-2"
                >
                  <img
                    :src="`/api/videos/${video.id}/thumbnail`"
                    alt=""
                    loading="lazy"
                    class="aspect-video w-16 shrink-0 rounded bg-(--ui-bg-accented) object-cover"
                  >
                  <span class="min-w-0 grow truncate text-sm">{{ video.title }}</span>
                  <UBadge
                    :color="video.state === 'PUBLISHED' ? 'success' : 'neutral'"
                    variant="subtle"
                    size="sm"
                  >
                    {{ video.state }}
                  </UBadge>
                  <QualityBadge :width="video.width" :height="video.height" />
                  <UButton
                    :to="`/admin/videos/${video.id}`"
                    size="xs"
                    color="neutral"
                    variant="subtle"
                  >
                    Edit
                  </UButton>
                </li>
              </ul>
              <p v-else class="py-2 text-sm text-(--ui-text-muted)">Nothing here yet.</p>
            </div>
          </div>
          <p v-else class="text-sm text-(--ui-text-muted)">
            No seasons. Films sit directly in the collection.
          </p>
        </UCard>
      </div>

      <div class="space-y-6">
        <UCard>
          <template #header><h2 class="font-semibold">How it is doing</h2></template>
          <dl v-if="stats" class="space-y-3 text-sm">
            <div class="flex justify-between gap-4">
              <dt class="text-(--ui-text-muted)">Titles</dt>
              <dd class="tabular-nums">{{ stats.videoCount }}</dd>
            </div>
            <div class="flex justify-between gap-4">
              <!-- Distinct people, not the sum of per-video counts: one person
                   watching six episodes is one viewer. -->
              <dt class="text-(--ui-text-muted)">Viewers</dt>
              <dd class="tabular-nums">{{ stats.totals.viewers }}</dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-(--ui-text-muted)">Views</dt>
              <dd class="tabular-nums">{{ stats.totals.views }}</dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-(--ui-text-muted)">Watch time</dt>
              <dd class="tabular-nums">{{ watchTime(stats.totals.secondsWatched) }}</dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-(--ui-text-muted)">Finished</dt>
              <dd class="tabular-nums">{{ stats.totals.completions }}</dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-(--ui-text-muted)">Avg. completion</dt>
              <dd class="tabular-nums">
                {{ stats.totals.averageCompletion === null
                  ? '—'
                  : `${Math.round(stats.totals.averageCompletion * 100)}%` }}
              </dd>
            </div>
          </dl>
          <p v-else class="text-sm text-(--ui-text-muted)">No figures yet.</p>
        </UCard>

        <UCard>
          <template #header><h2 class="font-semibold">Poster</h2></template>
          <img
            :src="`/api/collections/${collection.id}/poster`"
            alt=""
            class="aspect-2/3 w-full rounded-md bg-(--ui-bg-accented) object-cover"
          >
          <p class="mt-2 text-xs text-(--ui-text-muted)">
            Taken from the collection folder. There is no upload endpoint for a
            collection poster yet.
          </p>
        </UCard>
      </div>
    </div>
  </div>
</template>
