<script setup lang="ts">
import type { Page } from '@video/shared'

/**
 * Finding something to put on a hand-picked row.
 *
 * This replaced a `USelect` listing `/collections?limit=100`, which had two
 * problems: scrolling a flat list stops being usable long before a library gets
 * large, and the API caps a page at 100, so collection 101 was not merely hard
 * to reach — it was unreachable. Searching server-side fixes both, and it is the
 * same pairing `browse.vue` searches: collections **and films**, the two things
 * the library is made of. A film could not be put on a hand-picked row at all
 * before this, though `ListItem` has always had a column for it.
 *
 * Deliberately **not** a `USelectMenu` with its search term bound to a refetch.
 * `CreditsEditor` tried that and records what happened: replacing the options
 * while the popover is open leaves it stuck open with its own search box
 * focused, so the next thing typed goes into the search field instead. A plain
 * input with results underneath has no popover to get stuck.
 */
interface Found {
  id: string
  title: string
  year?: number | null
  state: string
  /** Collections only: what the shelf holds, which is what its chip says. */
  seasonsHere?: number | null
  videosHere?: number | null
}

const props = defineProps<{
  /** Names the controls, so the accessible name says which row is being added to. */
  rowTitle: string
  /** Already on the row. Offering these again invites a click that does nothing. */
  presentCollectionIds: string[]
  presentVideoIds: string[]
}>()

const emit = defineEmits<{ add: [entry: { collectionId: string } | { videoId: string }] }>()

const api = useApi()

/** How many matches are worth showing before the answer is "type more". */
const LIMIT = 8

type Entry = { kind: 'collection' | 'video', entry: Found }

/**
 * `useRemoteSearch` owns the debounce and the only-the-newest-answer-wins rule;
 * what is left here is the query itself.
 *
 * `searchBlank` because a first look costs nothing on a small library and saves
 * typing to see what exists — which is also why it is asked for on mount.
 */
const {
  query: search,
  results,
  busy,
  failed,
  run,
} = useRemoteSearch<Entry[]>(
  async (term) => {
    const query = term ? `&q=${encodeURIComponent(term)}` : ''

    // Both, because "the library" is both. Films only for videos: an episode is
    // reachable through its show, and listing episodes would bury one show
    // under forty of its own instalments.
    const [collections, videos] = await Promise.all([
      api<Page<Found>>(`/collections?limit=${LIMIT}${query}`),
      api<Page<Found>>(`/videos?film=true&limit=${LIMIT}${query}`),
    ])

    return [
      ...collections.items.map(entry => ({ kind: 'collection' as const, entry })),
      ...videos.items.map(entry => ({ kind: 'video' as const, entry })),
    ].sort((a, b) => a.entry.title.localeCompare(b.entry.title))
  },
  { empty: [], searchBlank: true },
)

onMounted(run)

const alreadyOn = (found: { kind: string, entry: Found }): boolean =>
  found.kind === 'collection'
    ? props.presentCollectionIds.includes(found.entry.id)
    : props.presentVideoIds.includes(found.entry.id)

const visible = computed(() => results.value.filter(found => !alreadyOn(found)).slice(0, LIMIT))

function add(found: { kind: 'collection' | 'video', entry: Found }): void {
  emit('add', found.kind === 'collection' ? { collectionId: found.entry.id } : { videoId: found.entry.id })
}
</script>

<template>
  <div class="max-w-xl space-y-2">
    <UFormField label="Add an entry">
      <UInput
        v-model="search"
        icon="i-lucide-search"
        placeholder="Search shows and films…"
        :aria-label="`Search for something to add to ${rowTitle}`"
        class="w-full"
      />
    </UFormField>

    <p v-if="failed" class="text-sm text-(--ui-text-muted)">
      Could not search just now. Try again in a moment.
    </p>

    <ul v-else-if="visible.length" class="space-y-1">
      <li
        v-for="found in visible"
        :key="`${found.kind}:${found.entry.id}`"
        class="flex items-center gap-2 rounded bg-(--ui-bg-elevated) px-3 py-2 text-sm"
      >
        <span class="grow truncate">{{ found.entry.title }}</span>
        <span v-if="found.entry.year" class="text-(--ui-text-dimmed)">{{ found.entry.year }}</span>
        <!--
          Which of the two it is, because a shelf and a film of the same name
          are different entries and the title alone does not say which. It says
          what the shelf holds rather than "show": a saga of eight films is a
          collection and not a show, and calling it one was wrong the moment a
          season-less shelf could appear in these results.
        -->
        <UBadge color="neutral" variant="subtle" size="sm">
          {{ found.kind === 'collection' ? collectionChip(found.entry) : 'film' }}
        </UBadge>
        <!-- A draft is addable on purpose; the row filters it out per viewer. -->
        <UBadge v-if="found.entry.state !== 'PUBLISHED'" color="neutral" variant="subtle" size="sm">
          {{ found.entry.state.toLowerCase() }}
        </UBadge>
        <UButton
          size="xs"
          color="neutral"
          variant="subtle"
          :aria-label="`Add ${found.entry.title} to ${rowTitle}`"
          @click="add(found)"
        >
          Add
        </UButton>
      </li>
    </ul>

    <p v-else-if="!busy" class="text-sm text-(--ui-text-muted)">
      {{ search.trim() ? 'Nothing matches that.' : 'Nothing left to add.' }}
    </p>
  </div>
</template>
