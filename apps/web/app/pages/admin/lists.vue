<script setup lang="ts">
import type { Page } from '@video/shared'

/**
 * Building the home page's curated rows.
 *
 * A row's order is rewritten wholesale rather than patched item by item:
 * `ListItem.position` is deliberately not unique, because a unique index
 * collides mid drag-reorder when two items momentarily hold the same number.
 */
definePageMeta({ layout: 'admin', middleware: 'admin' })

interface RowItem {
  id: string
  video: { id: string, title: string } | null
  collection: { id: string, title: string } | null
}

interface CuratedRow {
  id: string
  slug: string
  title: string
  isVisible: boolean
  position: number
  items: RowItem[]
}

const api = useApi()
const toast = useToast()

const { data, refresh } = await useApiData<Page<CuratedRow>>(
  'admin-lists',
  '/lists?includeHidden=true&limit=100',
)
const { data: collections } = await useApiData<Page<{ id: string, title: string }>>(
  'admin-lists-collections',
  '/collections?limit=100',
)

const newTitle = ref('')

async function create() {
  if (!newTitle.value.trim()) return
  await api('/lists', { method: 'POST', body: { title: newTitle.value } })
  newTitle.value = ''
  await refresh()
}

async function addItem(row: CuratedRow, collectionId: string) {
  if (!collectionId) return
  await api(`/lists/${row.id}/items`, { method: 'POST', body: { collectionId } })
  await refresh()
}

async function removeItem(row: CuratedRow, item: RowItem) {
  await api(`/lists/${row.id}/items/${item.id}`, { method: 'DELETE' })
  await refresh()
}

/** Whole order, every id exactly once — a partial list is refused. */
async function move(row: CuratedRow, index: number, direction: -1 | 1) {
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
  } catch {
    toast.add({ title: 'Could not reorder.', color: 'error' })
  }
}

async function toggleVisible(row: CuratedRow) {
  await api(`/lists/${row.id}`, { method: 'PATCH', body: { isVisible: !row.isVisible } })
  await refresh()
}

async function remove(row: CuratedRow) {
  await api(`/lists/${row.id}`, { method: 'DELETE' })
  await refresh()
}

useHead({ title: 'Curated rows' })
</script>

<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-bold tracking-tight">Curated rows</h1>
      <p class="text-sm text-(--ui-text-muted)">The shelves on the home page, in order.</p>
    </div>

    <div class="flex gap-2">
      <UInput v-model="newTitle" placeholder="New row title" class="w-64" @keyup.enter="create" />
      <UButton icon="i-lucide-plus" @click="create">Add row</UButton>
    </div>

    <div v-for="row in data?.items ?? []" :key="row.id" class="rounded-lg border border-(--ui-border) p-4">
      <div class="mb-3 flex flex-wrap items-center gap-3">
        <h2 class="font-semibold">{{ row.title }}</h2>
        <UBadge v-if="!row.isVisible" color="neutral" variant="subtle" size="sm">hidden</UBadge>
        <div class="ml-auto flex gap-2">
          <UButton size="xs" color="neutral" variant="subtle" @click="toggleVisible(row)">
            {{ row.isVisible ? 'Hide' : 'Show' }}
          </UButton>
          <UButton size="xs" color="error" variant="subtle" @click="remove(row)">Delete</UButton>
        </div>
      </div>

      <ul v-if="row.items.length" class="mb-3 space-y-1">
        <li
          v-for="(item, index) in row.items"
          :key="item.id"
          class="flex items-center gap-2 rounded bg-(--ui-bg-elevated) px-3 py-2 text-sm"
        >
          <span class="grow truncate">
            {{ item.collection?.title ?? item.video?.title }}
          </span>
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

      <USelect
        :items="(collections?.items ?? []).map(c => ({ label: c.title, value: c.id }))"
        placeholder="Add a collection…"
        class="w-64"
        @update:model-value="(value: string) => addItem(row, value)"
      />
    </div>

    <p v-if="!data?.items?.length" class="py-20 text-center text-(--ui-text-muted)">
      No curated rows yet.
    </p>
  </div>
</template>
