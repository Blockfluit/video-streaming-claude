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
  updatedAt?: string
  /** Imported. Shown and edited in the Metadata card. */
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
  seriesStatus?: string | null
  seasonCount?: number | null
  episodeCount?: number | null
  metadataUpdatedAt?: string | null
  slug: string
  title: string
  description: string | null
  year: number | null
  tags: string[]
  state: string
  /** The admin's overrides. Null means the collection inherits from its first video. */
  posterKey: string | null
  bannerKey: string | null
  trailerYoutubeId: string | null
  /** What a cascade publish would take with it — computed server-side. */
  publishableVideoCount?: number
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
  title: '',
  description: '',
  year: null as number | null,
  tags: '',
  trailer: '',
})

/**
 * Re-seeded when the server record changes, not only once at setup.
 *
 * It used to be built eagerly from the first fetch and never read again, so
 * after a metadata import refreshed the page the form still held the *old*
 * values — and pressing Save wrote them straight back over what had just been
 * imported. Keying on `updatedAt` re-reads after a save or an import and leaves
 * whatever is being typed alone otherwise.
 */
function resetForm() {
  if (!collection.value) return
  form.title = collection.value.title
  form.description = collection.value.description ?? ''
  form.year = collection.value.year
  form.tags = collection.value.tags.join(', ')
  form.trailer = collection.value.trailerYoutubeId ?? ''
}

resetForm()
watch(() => collection.value?.updatedAt, resetForm)
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
        trailerYoutubeId: form.trailer,
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

async function setState(action: 'publish' | 'archive', cascade = false) {
  try {
    const query = action === 'publish' && cascade ? '?cascade=true' : ''
    await api(`/collections/${collection.value!.id}/${action}${query}`, { method: 'POST' })
    await refresh()
    toast.add({ title: action === 'publish' ? 'Published' : 'Archived', color: 'success' })
  }
  catch (error) {
    toast.add({ title: apiMessage(error, `Could not ${action} it`), color: 'error' })
  }
}

/**
 * Publishing asks first, and names the number.
 *
 * A collection full of drafts is the normal case after an ingest, and publishing
 * each episode by hand is the thing this exists to avoid. The count comes from
 * the server — the same `publishableVideoCount` the readiness check uses — so
 * the dialog cannot promise something different from what happens.
 *
 * Named rather than "are you sure?", the way removing a season names how many
 * files go.
 */
const confirmingPublish = ref(false)
const cascadePublish = ref(true)

const publishableCount = computed(() => collection.value?.publishableVideoCount ?? 0)

async function confirmPublish() {
  confirmingPublish.value = false
  await setState('publish', cascadePublish.value)
}

/* --- artwork --------------------------------------------------------- */

/**
 * A collection's poster and banner are an **override**. With none set it shows
 * its first video's, so "Reset" here means go back to inheriting rather than
 * leave the shelf blank — which is why the panel says which of the two it is
 * currently showing.
 */
const artwork = useArtworkEditor('collections', () => collection.value?.id, refresh)

function isOwnArtwork(shape: ArtworkShape): boolean {
  return Boolean(shape === 'poster' ? collection.value?.posterKey : collection.value?.bannerKey)
}

const uploadArtwork = (event: Event, shape: ArtworkShape) =>
  artwork.upload(event, shape, { success: 'Artwork updated' })

async function resetArtwork(shape: ArtworkShape) {
  try {
    await api(`/collections/${collection.value!.id}/${shape}`, { method: 'DELETE' })
    artwork.replaced(shape)
    await refresh()
    toast.add({ title: 'Back to inheriting', color: 'success' })
  }
  catch (error) {
    toast.add({ title: apiMessage(error, 'Could not reset that'), color: 'error' })
  }
}

/**
 * A collection's `posterKey` may already have been set, so "it has one now" is no
 * evidence that this import gave it one — which is why the dialog names the shapes.
 */
const metadataApplied = artwork.applied

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

/**
 * The season a destructive delete is being confirmed for.
 *
 * An empty season goes straight away: the API removes the empty folder with it,
 * so the screen and the disk agree. One that still holds episodes cannot —
 * deleting it would leave the films behind, reconcile would rebuild the season
 * from that folder on the next scan, and the deletion would appear to undo
 * itself. Saying so beats letting someone discover it.
 */
const confirming = ref<{ season: Season, episodes: number } | null>(null)
const deleting = ref(false)

/** UModal writes its own open state, so it needs a boolean of its own. */
const confirmingOpen = computed({
  get: () => confirming.value !== null,
  set: (open: boolean) => { if (!open) confirming.value = null },
})

function askToRemove(group: Group) {
  if (!group.season) return

  if (group.videos.length === 0) {
    void removeSeason(group.season, false)
    return
  }
  confirming.value = { season: group.season, episodes: group.videos.length }
}

async function removeSeason(season: Season, deleteFiles: boolean) {
  deleting.value = true
  try {
    await api(`/seasons/${season.id}${deleteFiles ? '?deleteFiles=true' : ''}`, {
      method: 'DELETE',
    })
    confirming.value = null
    await refresh()
    toast.add({
      title: deleteFiles ? 'Season and its files deleted' : 'Season removed',
      color: 'success',
    })
  }
  catch (error) {
    toast.add({ title: apiMessage(error, 'Could not remove it'), color: 'error' })
  }
  finally {
    deleting.value = false
  }
}

/**
 * Videos grouped under their season, with loose ones last.
 *
 * Held in a ref rather than computed straight off the fetch so a drag can
 * rearrange it immediately. Reordering is a direct-manipulation gesture: the
 * card has to follow the cursor and stay where it is dropped, not vanish and
 * reappear a round trip later. The server is then told, and a failure puts the
 * list back.
 */
interface Group { season: Season | null, videos: VideoRow[] }

const groups = ref<Group[]>([])

function regroup(): void {
  const detail = collection.value
  if (!detail) {
    groups.value = []
    return
  }

  const ordered = (list: VideoRow[]) =>
    [...list].sort(
      (a, b) =>
        // A null orderIndex means "ingest could not tell" and sorts last;
        // treating it as zero would put an unnumbered extra ahead of episode one.
        (a.orderIndex ?? Number.POSITIVE_INFINITY) - (b.orderIndex ?? Number.POSITIVE_INFINITY)
        || a.title.localeCompare(b.title),
    )

  const bySeason: Group[] = detail.seasons.map(season => ({
    season,
    videos: ordered(detail.videos.filter(v => v.seasonId === season.id)),
  }))

  // Always present, even when empty — it is a drop target for pulling an
  // episode back out of a season, and you cannot drop onto something absent.
  bySeason.push({ season: null, videos: ordered(detail.videos.filter(v => v.seasonId === null)) })
  groups.value = bySeason
}

watch(collection, regroup, { immediate: true })

/* --- dragging -------------------------------------------------------- */

const dragging = ref<{ videoId: string, from: string } | null>(null)
const dropTarget = ref<string | null>(null)

/** A stable key per group, since a season id can be null. */
const keyOf = (season: Season | null) => season?.id ?? 'loose'

function onDragStart(event: DragEvent, video: VideoRow, group: Group) {
  dragging.value = { videoId: video.id, from: keyOf(group.season) }
  // Firefox refuses to start a drag at all without data on the transfer.
  event.dataTransfer?.setData('text/plain', video.id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onDragEnd() {
  dragging.value = null
  dropTarget.value = null
}

/**
 * Moves the dragged card to `index` within `group`, in place.
 *
 * Runs on dragover rather than on drop so the list rearranges under the cursor
 * and you can see where it will land. `index` of -1 means the end of the list,
 * which is what dropping on the container itself means.
 */
function reorderPreview(group: Group, index: number) {
  const drag = dragging.value
  if (!drag) return

  const source = groups.value.find(g => g.videos.some(v => v.id === drag.videoId))
  if (!source) return

  const from = source.videos.findIndex(v => v.id === drag.videoId)
  const target = index === -1 ? group.videos.length : index
  if (source === group && (from === target || from === target - 1)) return

  const [moved] = source.videos.splice(from, 1)
  if (!moved) return
  group.videos.splice(source === group && from < target ? target - 1 : target, 0, moved)
}

/**
 * Dragging over the group's own box, rather than over one of its rows.
 *
 * This has to move the card too, not just highlight — the rows carry `.stop`
 * on their own handler, so this fires for the gaps and, crucially, for an
 * empty season, which has no rows at all. Without it dropping onto a new
 * season sent the server that season's contents unchanged: an empty list,
 * which is a request that succeeds and does nothing.
 */
function onGroupDragOver(group: Group) {
  dropTarget.value = keyOf(group.season)
  if (!dragging.value) return
  // Already here: the row handlers own the position within a group.
  if (group.videos.some(v => v.id === dragging.value!.videoId)) return
  reorderPreview(group, -1)
}

async function commit(group: Group) {
  const drag = dragging.value
  onDragEnd()
  if (!drag) return

  try {
    // The whole season in one request. A PATCH per video is a dozen calls that
    // can half-fail, leaving an order nobody chose.
    await api(`/collections/${collection.value!.id}/videos/order`, {
      method: 'PATCH',
      body: {
        seasonId: group.season?.id ?? null,
        videoIds: group.videos.map(v => v.id),
      },
    })
    await refresh()
  }
  catch (error) {
    toast.add({ title: apiMessage(error, 'Could not move that'), color: 'error' })
    // Put the list back rather than leaving the screen showing an order the
    // server does not have.
    regroup()
  }
}

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
        <MetadataMatchModal
          kind="collection"
          :id="collection.id"
          :title="collection.title"
          :year="collection.year"
          :matched-to="collection.tmdbId"
          @applied="metadataApplied"
        />
        <UButton :to="`/c/${collection.slug}`" color="neutral" variant="subtle" icon="i-lucide-eye">
          View
        </UButton>
        <UButton
          v-if="collection.state !== 'PUBLISHED'"
          icon="i-lucide-check"
          @click="confirmingPublish = true"
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
    <!--
      Only shown for a season that still holds episodes. The wording names the
      real consequence — the films go — rather than asking "are you sure?",
      which tells nobody anything.
    -->
    <!--
      Names the number rather than asking "are you sure?", the same way removing
      a season says how many files go. Publishing a shelf full of drafts is the
      normal case after an ingest, and doing each episode by hand is what this
      exists to avoid.
    -->
    <UModal v-model:open="confirmingPublish" :title="`Publish ${collection.title}?`">
      <template #body>
        <div class="space-y-4 text-sm">
          <p v-if="publishableCount > 0">
            <strong>{{ publishableCount }}</strong>
            {{ publishableCount === 1 ? 'video is' : 'videos are' }} ready to go out with it.
          </p>
          <p v-else class="text-(--ui-text-muted)">
            Nothing inside it is ready to publish yet.
          </p>

          <UCheckbox
            v-if="publishableCount > 0"
            v-model="cascadePublish"
            :label="`Publish ${publishableCount === 1 ? 'it' : 'them'} too`"
          />
          <p v-if="publishableCount > 0" class="text-xs text-(--ui-text-muted)">
            Unticked, only the collection is published and the videos stay drafts.
          </p>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="confirmingPublish = false">
            Cancel
          </UButton>
          <UButton icon="i-lucide-check" @click="confirmPublish">Publish</UButton>
        </div>
      </template>
    </UModal>

    <UModal v-model:open="confirmingOpen" title="This season still has episodes">
      <template #body>
        <div v-if="confirming" class="space-y-3 text-sm">
          <p>
            <strong>{{ seasonLabel(confirming.season) }}</strong> holds
            {{ confirming.episodes }}
            {{ confirming.episodes === 1 ? 'episode' : 'episodes' }}.
          </p>
          <p class="text-(--ui-text-muted)">
            Deleting the season on its own leaves its folder and those files on
            the drive, and the next scan of the media folder will find them and
            recreate the season. To remove it for good, either drag the episodes
            out first, or delete the video files with it.
          </p>
          <p class="text-(--ui-text-muted)">
            Deleting the files cannot be undone.
          </p>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full gap-2">
          <UButton color="neutral" variant="subtle" @click="confirming = null">
            Cancel
          </UButton>
          <UButton
            class="ml-auto"
            color="error"
            :loading="deleting"
            @click="confirming && removeSeason(confirming.season, true)"
          >
            Delete the season and {{ confirming?.episodes }}
            {{ confirming?.episodes === 1 ? 'file' : 'files' }}
          </UButton>
        </div>
      </template>
    </UModal>

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
            <UFormField label="Trailer" hint="Paste a YouTube link, or leave empty for none">
              <UInput v-model="form.trailer" class="w-full" placeholder="https://youtu.be/…" />
            </UFormField>
            <UButton :loading="saving" @click="save">Save changes</UButton>
          </div>
        </UCard>

        <MetadataCard
          kind="collection"
          :record="{ ...collection, releaseDate: collection.releaseDate ?? null }"
          @saved="refresh"
        />

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

          <p class="mb-3 text-xs text-(--ui-text-muted)">
            Drag an episode onto a season to move it. Where you drop it is the
            order it plays in.
          </p>

          <div class="space-y-4">
            <!--
              A named region, not a bare div. Each season is an independent drop
              target, and without a name a screen reader announces a run of
              identical unlabelled groups.
            -->
            <section
              v-for="group in groups"
              :key="keyOf(group.season)"
              :aria-label="seasonLabel(group.season)"
              class="rounded-lg border p-3 transition-colors"
              :class="dropTarget === keyOf(group.season)
                ? 'border-(--ui-primary) bg-(--ui-bg-accented)'
                : 'border-(--ui-border)'"
              @dragover.prevent="onGroupDragOver(group)"
              @dragenter.prevent="onGroupDragOver(group)"
              @drop.prevent="commit(group)"
            >
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
                  @click="askToRemove(group)"
                />
              </div>

              <ul v-if="group.videos.length" class="space-y-1">
                <li
                  v-for="(video, index) in group.videos"
                  :key="video.id"
                  draggable="true"
                  class="flex cursor-grab items-center gap-3 rounded-md p-2 transition-opacity active:cursor-grabbing"
                  :class="dragging?.videoId === video.id
                    ? 'opacity-40'
                    : 'hover:bg-(--ui-bg-elevated)'"
                  @dragstart="onDragStart($event, video, group)"
                  @dragend="onDragEnd"
                  @dragover.prevent.stop="reorderPreview(group, index)"
                  @drop.prevent.stop="commit(group)"
                >
                  <!-- The handle is decorative: the whole row is draggable, and
                       a grip you must hit exactly is worse than one you cannot
                       miss. -->
                  <UIcon
                    name="i-lucide-grip-vertical"
                    aria-hidden="true"
                    class="size-4 shrink-0 text-(--ui-text-dimmed)"
                  />
                  <span class="w-6 shrink-0 text-right text-xs tabular-nums text-(--ui-text-dimmed)">
                    {{ index + 1 }}
                  </span>
                  <img
                    :src="`/api/videos/${video.id}/banner`"
                    alt=""
                    loading="lazy"
                    draggable="false"
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
              <p v-else class="py-3 text-center text-sm text-(--ui-text-dimmed)">
                Drop an episode here.
              </p>
            </section>
          </div>

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
          <template #header><h2 class="font-semibold">Artwork</h2></template>

          <!--
            Each shape says whether it is this collection's own or inherited,
            because "why is this the poster?" is otherwise unanswerable from
            here: nothing was ever set, and it is showing an episode's picture.
            Without that, Reset is a button whose effect is invisible.
          -->
          <div class="space-y-4">
            <div v-for="shape in (['poster', 'banner'] as const)" :key="shape">
              <div class="flex items-start gap-3">
                <img
                  :src="artwork.url(shape)"
                  :alt="shape === 'poster' ? 'Poster' : 'Banner'"
                  class="shrink-0 rounded-md bg-(--ui-bg-accented) object-cover"
                  :class="shape === 'poster' ? 'aspect-2/3 w-20' : 'aspect-video w-32'"
                >
                <div class="min-w-0 flex-1 space-y-2">
                  <p class="text-sm font-medium capitalize">{{ shape }}</p>
                  <p class="text-xs text-(--ui-text-muted)">
                    {{ isOwnArtwork(shape) ? 'Set on this collection' : 'Inherited from its first video' }}
                  </p>
                  <div class="flex flex-wrap gap-2">
                    <label class="cursor-pointer">
                      <input
                        type="file"
                        accept="image/*"
                        class="hidden"
                        @change="event => uploadArtwork(event, shape)"
                      >
                      <span
                        class="flex items-center gap-1.5 rounded-md bg-(--ui-bg-accented) px-2 py-1 text-xs hover:bg-(--ui-border-accented)"
                      >
                        <UIcon name="i-lucide-image" class="size-3.5" /> Upload
                      </span>
                    </label>
                    <UButton
                      v-if="isOwnArtwork(shape)"
                      size="xs"
                      color="neutral"
                      variant="ghost"
                      icon="i-lucide-rotate-ccw"
                      @click="resetArtwork(shape)"
                    >
                      Use the episode's
                    </UButton>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </UCard>
      </div>
    </div>
  </div>
</template>
