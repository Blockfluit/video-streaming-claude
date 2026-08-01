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
type Group = SeasonGroup<Season, VideoRow>

const groups = ref<Group[]>([])

/**
 * Held in a ref rather than computed straight off the fetch so a drag can
 * rearrange it immediately, and grouped by the shared helper the viewer's
 * collection overview also uses — two copies of "which episode belongs where,
 * and in what order" is how one screen ends up numbering episodes differently
 * from the other.
 *
 * `includeEmptyLoose` because this screen needs the "not in a season" bucket as
 * a drop target even when it is empty: you cannot drop onto something absent.
 * The viewer wants the opposite and passes nothing.
 */
function regroup(): void {
  const detail = collection.value
  groups.value = detail
    ? groupVideosBySeason(detail.seasons, detail.videos, { includeEmptyLoose: true })
    : []
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
    <!--
      Only shown for a season that still holds episodes. The wording names the
      real consequence — the films go — rather than asking "are you sure?",
      which tells nobody anything.
    -->
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
                    :src="`/api/videos/${video.id}/thumbnail`"
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
