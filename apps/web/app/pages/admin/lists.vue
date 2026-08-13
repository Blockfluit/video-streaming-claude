<script setup lang="ts">
import {
  DEFAULT_TRENDING_WINDOW_DAYS,
  ROW_SOURCES,
  ROW_SOURCE_SPECS,
  type Page,
  type RowKind,
  type RowSource,
} from '@video/shared'

/**
 * Building the home page, row by row.
 *
 * A row is a source, a kind, a size and a filter. Which of those it reads comes
 * from `ROW_SOURCE_SPECS` rather than from anything written here — a form
 * offering a field the endpoint ignores is exactly how the two drift apart.
 *
 * Every row shows what it currently resolves to. For a computed row that is the
 * only way to tell what a filter combination actually does before publishing
 * it, and `GET /lists` already returns the entries, so it costs nothing.
 */
definePageMeta({ layout: 'admin', middleware: 'admin' })

interface RowItem {
  id: string
  video: { id: string, title: string } | null
  collection: { id: string, title: string } | null
}

/** What a hand-picked row already holds, so the picker stops offering it. */
const presentIds = (row: HomeRow, kind: 'collection' | 'video'): string[] =>
  row.items
    .map(item => (kind === 'collection' ? item.collection?.id : item.video?.id))
    .filter((id): id is string => Boolean(id))

interface HomeRow {
  id: string
  slug: string
  title: string
  isVisible: boolean
  position: number
  source: RowSource
  kind: RowKind
  maxItems: number
  windowDays: number | null
  tags: string[]
  items: RowItem[]
}

const api = useApi()
const toast = useToast()

/**
 * `error` is taken, not discarded.
 *
 * `data` is null whether the request failed or the library simply has no rows,
 * and both then fall into `v-if="!data?.items?.length"` — so an outage read as
 * "No rows yet, so the home page has nothing to show", which is a sentence that
 * sends an admin looking in the wrong place entirely.
 */
const { data, error, refresh } = await useApiData<Page<HomeRow>>(
  'admin-lists',
  '/lists?includeHidden=true&limit=100',
)
const newTitle = ref('')
const newSource = ref<RowSource>('MANUAL')

const sourceOptions = ROW_SOURCES.map(source => ({
  label: ROW_SOURCE_SPECS[source].label,
  value: source,
}))

const kindOptions: { label: string, value: RowKind }[] = [
  { label: 'Shows and films', value: 'AUTO' },
  { label: 'Shows only', value: 'COLLECTIONS' },
  { label: 'Individual videos', value: 'VIDEOS' },
]

// `rowSpec` rather than a bare lookup: `row.source` is whatever the API sent,
// and an unrecognised one throwing here would draw nothing at all.
const reads = (row: HomeRow, field: string): boolean =>
  (rowSpec(row.source).fields as readonly string[]).includes(field)

async function create() {
  if (!newTitle.value.trim()) return

  try {
    await api('/lists', {
      method: 'POST',
      body: {
        title: newTitle.value,
        source: newSource.value,
        // A trending row without one is not a question anyone asked.
        ...(newSource.value === 'TRENDING' ? { windowDays: DEFAULT_TRENDING_WINDOW_DAYS } : {}),
      },
    })
    newTitle.value = ''
    newSource.value = 'MANUAL'
    await refresh()
  }
  catch (error) {
    // The one that actually happens: a second Continue watching row.
    toast.add({ title: apiMessage(error, 'Could not add that row.'), color: 'error' })
  }
}

/** Every setting goes back the same way, so there is one error path rather than six. */
async function patch(row: HomeRow, body: Record<string, unknown>) {
  try {
    await api(`/lists/${row.id}`, { method: 'PATCH', body })
    await refresh()
  }
  catch (error) {
    toast.add({ title: apiMessage(error, 'Could not save that.'), color: 'error' })
  }
}

/**
 * The body is already `{ collectionId }` or `{ videoId }` — exactly one, as the API requires.
 *
 * The parameter is `entry` and must not be called `ref`. A binding of that name
 * anywhere in the script makes the **production** build drop Nuxt's auto-imported
 * `ref`, so `ref('')` above becomes a free global and setup throws
 * `ReferenceError: ref is not defined` — which renders the page as nothing at all
 * inside an intact admin layout. `npm run dev` does not reproduce it.
 */
async function addItem(row: HomeRow, entry: { collectionId: string } | { videoId: string }) {
  try {
    await api(`/lists/${row.id}/items`, { method: 'POST', body: entry })
    await refresh()
  }
  catch (error) {
    toast.add({ title: apiMessage(error, 'Could not add that.'), color: 'error' })
  }
}

async function removeItem(row: HomeRow, item: RowItem) {
  await api(`/lists/${row.id}/items/${item.id}`, { method: 'DELETE' })
  await refresh()
}

/** Whole order, every id exactly once — a partial list is refused. */
async function move(row: HomeRow, index: number, direction: -1 | 1) {
  const ids = row.items.map(i => i.id)
  const target = index + direction
  const moving = ids[index]
  const displaced = ids[target]
  if (moving === undefined || displaced === undefined) return
  ids[index] = displaced
  ids[target] = moving

  try {
    await api(`/lists/${row.id}/reorder`, { method: 'PATCH', body: { itemIds: ids } })
    await refresh()
  }
  catch {
    toast.add({ title: 'Could not reorder.', color: 'error' })
  }
}

/**
 * Moving a row up or down the page.
 *
 * `position` is not unique and the rows arrive sorted by it, so swapping the two
 * numbers is enough — there is no whole sequence to rewrite the way a row's own
 * entries need.
 */
async function moveRow(index: number, direction: -1 | 1) {
  const rows = data.value?.items ?? []
  const row = rows[index]
  const other = rows[index + direction]
  if (!row || !other) return

  try {
    await api(`/lists/${row.id}`, { method: 'PATCH', body: { position: other.position } })
    await api(`/lists/${other.id}`, { method: 'PATCH', body: { position: row.position } })
    await refresh()
  }
  catch (error) {
    toast.add({ title: apiMessage(error, 'Could not move that row.'), color: 'error' })
  }
}

async function remove(row: HomeRow) {
  await api(`/lists/${row.id}`, { method: 'DELETE' })
  await refresh()
}

useHead({ title: 'Home page rows' })
</script>

<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-bold tracking-tight">Home page rows</h1>
      <p class="text-sm text-(--ui-text-muted)">
        The shelves on the home page, top to bottom. A hand-picked row holds what you put in it;
        every other kind works itself out and keeps up with the library.
      </p>
    </div>

    <div>
      <div class="flex flex-wrap items-end gap-2">
        <UFormField label="Title" class="w-64">
          <UInput
            v-model="newTitle"
            placeholder="New row title"
            class="w-full"
            @keyup.enter="create"
          />
        </UFormField>
        <UFormField label="Contents" class="w-56">
          <USelect
            v-model="newSource"
            :items="sourceOptions"
            aria-label="Where the new row gets its contents"
            class="w-full"
          />
        </UFormField>
        <UButton icon="i-lucide-plus" @click="create">Add row</UButton>
      </div>
      <p class="mt-2 text-sm text-(--ui-text-muted)">{{ ROW_SOURCE_SPECS[newSource].hint }}</p>
    </div>

    <div
      v-for="(row, rowIndex) in data?.items ?? []"
      :key="row.id"
      class="rounded-lg border border-(--ui-border) p-4"
    >
      <div class="mb-3 flex flex-wrap items-center gap-3">
        <h2 class="font-semibold">{{ row.title }}</h2>
        <UBadge color="neutral" variant="subtle" size="sm">
          {{ rowSpec(row.source).label }}
        </UBadge>
        <UBadge v-if="!row.isVisible" color="neutral" variant="subtle" size="sm">hidden</UBadge>

        <div class="ml-auto flex gap-2">
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-chevron-up"
            :disabled="rowIndex === 0"
            aria-label="Move this row up the page"
            @click="moveRow(rowIndex, -1)"
          />
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-chevron-down"
            :disabled="rowIndex === (data?.items?.length ?? 0) - 1"
            aria-label="Move this row down the page"
            @click="moveRow(rowIndex, 1)"
          />
          <UButton
            size="xs"
            color="neutral"
            variant="subtle"
            @click="patch(row, { isVisible: !row.isVisible })"
          >
            {{ row.isVisible ? 'Hide' : 'Show' }}
          </UButton>
          <UButton size="xs" color="error" variant="subtle" @click="remove(row)">Delete</UButton>
        </div>
      </div>

      <p class="mb-3 text-sm text-(--ui-text-muted)">{{ rowSpec(row.source).hint }}</p>

      <!-- Only the settings this source actually reads. -->
      <div v-if="!reads(row, 'items')" class="mb-4 flex flex-wrap items-end gap-3">
        <UFormField v-if="reads(row, 'kind')" label="Cards show" class="w-48">
          <USelect
            :model-value="row.kind"
            :items="kindOptions"
            :aria-label="`What ${row.title} puts on its cards`"
            class="w-full"
            @update:model-value="(value: RowKind) => patch(row, { kind: value })"
          />
        </UFormField>

        <UFormField v-if="reads(row, 'maxItems')" label="How many" class="w-24">
          <UInput
            :model-value="row.maxItems"
            type="number"
            :min="1"
            :max="50"
            :aria-label="`How many cards ${row.title} shows`"
            class="w-full"
            @change="(event: Event) =>
              patch(row, { maxItems: Number((event.target as HTMLInputElement).value) })"
          />
        </UFormField>

        <UFormField v-if="reads(row, 'windowDays')" label="Days back" class="w-28">
          <UInput
            :model-value="row.windowDays ?? DEFAULT_TRENDING_WINDOW_DAYS"
            type="number"
            :min="1"
            :max="365"
            :aria-label="`How far back ${row.title} counts`"
            class="w-full"
            @change="(event: Event) =>
              patch(row, { windowDays: Number((event.target as HTMLInputElement).value) })"
          />
        </UFormField>

        <UFormField v-if="reads(row, 'tags')" label="Only these tags" class="w-64">
          <UInput
            :model-value="row.tags.join(', ')"
            placeholder="Any tag"
            :aria-label="`Which tags ${row.title} is limited to`"
            class="w-full"
            @change="(event: Event) => patch(row, {
              tags: (event.target as HTMLInputElement).value
                .split(',').map(tag => tag.trim()).filter(Boolean),
            })"
          />
        </UFormField>
      </div>

      <!-- A hand-picked row is arranged here; every other kind is only shown. -->
      <template v-if="reads(row, 'items')">
        <ul v-if="row.items.length" class="mb-3 space-y-1">
          <li
            v-for="(item, index) in row.items"
            :key="item.id"
            class="flex items-center gap-2 rounded bg-(--ui-bg-elevated) px-3 py-2 text-sm"
          >
            <span class="grow truncate">{{ item.collection?.title ?? item.video?.title }}</span>
            <UButton
              size="xs"
              variant="ghost"
              color="neutral"
              icon="i-lucide-chevron-up"
              :disabled="index === 0"
              aria-label="Move up"
              @click="move(row, index, -1)"
            />
            <UButton
              size="xs"
              variant="ghost"
              color="neutral"
              icon="i-lucide-chevron-down"
              :disabled="index === row.items.length - 1"
              aria-label="Move down"
              @click="move(row, index, 1)"
            />
            <UButton
              size="xs"
              variant="ghost"
              color="error"
              icon="i-lucide-x"
              aria-label="Remove"
              @click="removeItem(row, item)"
            />
          </li>
        </ul>
        <p v-else class="mb-3 text-sm text-(--ui-text-muted)">Empty.</p>

        <RowEntryPicker
          :row-title="row.title"
          :present-collection-ids="presentIds(row, 'collection')"
          :present-video-ids="presentIds(row, 'video')"
          @add="(entry) => addItem(row, entry)"
        />
      </template>

      <div v-else class="mb-1">
        <p class="mb-2 text-xs font-semibold tracking-wider text-(--ui-text-dimmed) uppercase">
          Showing now
        </p>
        <ul v-if="row.items.length" class="flex flex-wrap gap-2">
          <li
            v-for="item in row.items"
            :key="item.id"
            class="rounded bg-(--ui-bg-elevated) px-3 py-1.5 text-sm"
          >
            {{ item.collection?.title ?? item.video?.title }}
          </li>
        </ul>
        <p v-else class="text-sm text-(--ui-text-muted)">
          Nothing matches this yet, so the row stays off the home page.
        </p>
      </div>
    </div>

    <!--
      A failure and an empty library are different things and must not read the
      same. `error` first, because when it is set `data` is null and the line
      below would otherwise claim there are no rows.
    -->
    <div v-if="error" class="py-20 text-center">
      <p class="text-(--ui-text)">{{ apiMessage(error, 'Could not load the rows.') }}</p>
      <UButton class="mt-3" color="neutral" variant="subtle" @click="refresh()">Try again</UButton>
    </div>
    <p v-else-if="!data?.items?.length" class="py-20 text-center text-(--ui-text-muted)">
      No rows yet, so the home page has nothing to show.
    </p>
  </div>
</template>
