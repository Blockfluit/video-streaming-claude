<script setup lang="ts">
import type { Page } from '@video/shared'

/**
 * Finding something to put on a hand-picked row.
 *
 * This replaced a `USelect` listing `/collections?limit=100`, which had two
 * problems: scrolling a flat list stops being usable long before a library gets
 * large, and the API caps a page at 100, so collection 101 was not merely hard
 * to reach — it was unreachable. Searching server-side fixes both, and it is the
 * same pairing `browse.vue` searches: collections **and standalone videos**, the
 * two things the library is made of. A film could not be put on a hand-picked
 * row at all before this, though `ListItem` has always had a column for it.
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
}

const props = defineProps<{
  /** Names the controls, so the accessible name says which row is being added to. */
  rowTitle: string
  /** Already on the row. Offering these again invites a click that does nothing. */
  presentCollectionIds: string[]
  presentVideoIds: string[]
}>()

const emit = defineEmits<{ add: [ref: { collectionId: string } | { videoId: string }] }>()

const api = useApi()

const search = ref('')
const results = ref<{ kind: 'collection' | 'video', entry: Found }[]>([])
const busy = ref(false)
const failed = ref(false)

/** How many matches are worth showing before the answer is "type more". */
const LIMIT = 8

/**
 * Debounced by hand.
 *
 * `refDebounced` is VueUse, which is not a dependency here. Without a debounce
 * every keystroke is a request and the answers can land out of order, leaving
 * the list showing whatever the *slowest* one returned — the same reason
 * `browse.vue` does this.
 */
let timer: ReturnType<typeof setTimeout> | undefined
watch(search, () => {
  clearTimeout(timer)
  timer = setTimeout(run, 250)
})

onBeforeUnmount(() => clearTimeout(timer))

/** Only the newest search may write the results, whatever order they come back in. */
let latest = 0

async function run(): Promise<void> {
  const mine = (latest += 1)
  const q = search.value.trim()
  const query = q ? `&q=${encodeURIComponent(q)}` : ''

  busy.value = true
  failed.value = false

  try {
    // Both, because "the library" is both. Standalone only for videos: an
    // episode is reachable through its show, and listing episodes would bury
    // one show under forty of its own instalments.
    const [collections, videos] = await Promise.all([
      api<Page<Found>>(`/collections?limit=${LIMIT}${query}`),
      api<Page<Found>>(`/videos?standalone=true&limit=${LIMIT}${query}`),
    ])

    if (mine !== latest) return

    results.value = [
      ...collections.items.map(entry => ({ kind: 'collection' as const, entry })),
      ...videos.items.map(entry => ({ kind: 'video' as const, entry })),
    ].sort((a, b) => a.entry.title.localeCompare(b.entry.title))
  }
  catch {
    if (mine === latest) {
      results.value = []
      failed.value = true
    }
  }
  finally {
    if (mine === latest) busy.value = false
  }
}

/** The first look costs nothing on a small library and saves typing to see what exists. */
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
          Which of the two it is, because a show and a film of the same name are
          different entries and the title alone does not say which is which.
        -->
        <UBadge color="neutral" variant="subtle" size="sm">
          {{ found.kind === 'collection' ? 'show' : 'film' }}
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
