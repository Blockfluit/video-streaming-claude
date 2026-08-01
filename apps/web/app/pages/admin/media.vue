<script setup lang="ts">
/**
 * The disks, as they actually are.
 *
 * Ingest happens on its own, so this is the screen that explains it: what is on
 * each drive, what the library made of it, and what it would make of a folder
 * it has not taken yet. A drive holds unrelated things and the folder layout is
 * only a suggestion, so seeing the disk and the library side by side is the
 * only way to tell a deliberate arrangement from a file nobody has placed.
 *
 * Read-only, deliberately. Importing is the same scan as everything else —
 * a second path that created rows another way is exactly what this design is
 * trying not to have.
 */
definePageMeta({ layout: 'admin', middleware: 'admin' })

interface BrowseEntry {
  name: string
  path: string
  kind: 'drive' | 'folder' | 'video' | 'subtitle' | 'other'
  imported?: boolean
  videoId?: string
}

interface Proposal {
  kind: 'standalone' | 'collection'
  folderKey: string
  title: string
  seasons: { folder: string, number: number | null }[]
  videos: { storageKey: string, title: string, orderIndex: number | null }[]
}

interface BrowseResult {
  path: string
  parent: string | null
  entries: BrowseEntry[]
  proposal: Proposal | null
}

const route = useRoute()
const router = useRouter()
const toast = useToast()
const api = useApi()

const path = computed(() => String(route.query.path ?? ''))

const { data: view, refresh, status } = await useApiData<BrowseResult>(
  () => `media-browse-${path.value}`,
  () => `/admin/ingest/browse?path=${encodeURIComponent(path.value)}`,
  { watch: [path] },
)

/** Breadcrumbs, so it is obvious which disk you are looking inside. */
const crumbs = computed(() => {
  const segments = path.value.split('/').filter(Boolean)
  return segments.map((segment, index) => ({
    name: segment,
    path: segments.slice(0, index + 1).join('/'),
  }))
})

function open(entry: BrowseEntry) {
  if (entry.kind !== 'drive' && entry.kind !== 'folder') return
  router.push({ query: { path: entry.path } })
}

const scanning = ref(false)

async function scan() {
  scanning.value = true
  try {
    const summary = await api<{ created: number, issues: number }>('/admin/ingest/scan', {
      method: 'POST',
    })
    toast.add({
      title: 'Scan finished',
      description: `${summary.created} new, ${summary.issues} issue(s).`,
      color: 'success',
    })
    await refresh()
  } catch (error) {
    toast.add({ title: apiMessage(error, 'The scan failed.'), color: 'error' })
  } finally {
    scanning.value = false
  }
}

const iconFor = (kind: BrowseEntry['kind']) =>
  kind === 'drive'
    ? 'i-lucide-hard-drive'
    : kind === 'folder'
      ? 'i-lucide-folder'
      : kind === 'video'
        ? 'i-lucide-film'
        : kind === 'subtitle'
          ? 'i-lucide-captions'
          : 'i-lucide-file'

useHead({ title: 'Media' })
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="text-2xl font-bold tracking-tight">Media</h1>
        <p class="text-sm text-(--ui-text-muted)">
          The disks as they are on the machine, and what the library makes of them.
        </p>
      </div>
      <UButton :loading="scanning" icon="i-lucide-refresh-cw" @click="scan">
        Scan now
      </UButton>
    </div>

    <nav class="flex flex-wrap items-center gap-2 text-sm">
      <NuxtLink to="/admin/media" class="text-(--ui-text-muted) hover:text-white">
        All disks
      </NuxtLink>
      <template v-for="crumb in crumbs" :key="crumb.path">
        <span class="text-(--ui-text-dimmed)">/</span>
        <NuxtLink
          :to="{ query: { path: crumb.path } }"
          class="text-(--ui-text-muted) hover:text-white"
        >
          {{ crumb.name }}
        </NuxtLink>
      </template>
    </nav>

    <!--
      What this folder would become. Only shown at the level the rule applies
      at — a drive is not a collection, and a season folder is part of one.
    -->
    <UCard v-if="view?.proposal">
      <div class="flex flex-wrap items-center gap-3">
        <UBadge :color="view.proposal.kind === 'collection' ? 'primary' : 'neutral'" variant="subtle">
          {{ view.proposal.kind === 'collection' ? 'Collection' : 'Standalone video' }}
        </UBadge>
        <span class="font-medium">{{ view.proposal.title }}</span>
        <span class="text-sm text-(--ui-text-muted)">
          {{ view.proposal.videos.length }} video(s)
          <template v-if="view.proposal.seasons.length">
            · {{ view.proposal.seasons.length }} season(s)
          </template>
        </span>
      </div>
      <p class="mt-2 text-xs text-(--ui-text-muted)">
        What a scan would make of this folder the first time it sees it. Anything already in the
        library keeps the arrangement it has — the folders are a starting suggestion, not the model.
      </p>
    </UCard>

    <UCard>
      <p v-if="status === 'pending'" class="py-10 text-center text-(--ui-text-muted)">
        Reading the disk…
      </p>
      <p v-else-if="!view?.entries.length" class="py-10 text-center text-(--ui-text-muted)">
        Nothing here.
      </p>
      <ul v-else class="divide-y divide-(--ui-border)">
        <li
          v-for="entry in view.entries"
          :key="entry.path"
          class="flex items-center gap-3 py-2"
        >
          <UIcon :name="iconFor(entry.kind)" class="size-4 shrink-0 text-(--ui-text-dimmed)" />

          <component
            :is="entry.kind === 'drive' || entry.kind === 'folder' ? 'button' : 'span'"
            class="min-w-0 grow truncate text-left text-sm"
            :class="entry.kind === 'drive' || entry.kind === 'folder' ? 'hover:underline' : ''"
            @click="open(entry)"
          >
            {{ entry.name }}
          </component>

          <UBadge v-if="entry.imported === false" color="warning" variant="subtle" size="sm">
            not in the library
          </UBadge>
          <UButton
            v-else-if="entry.videoId"
            size="xs"
            color="neutral"
            variant="subtle"
            :to="`/admin/videos/${entry.videoId}`"
          >
            Open
          </UButton>
        </li>
      </ul>
    </UCard>
  </div>
</template>
