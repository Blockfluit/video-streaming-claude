<script setup lang="ts">
import type { Page } from '@video/shared'

/**
 * The person directory.
 *
 * Search before you add: the API refuses a duplicate name case-insensitively,
 * but the point of the search box is that nobody tries in the first place —
 * a directory full of near-duplicates is what kills a credits system.
 */
definePageMeta({ layout: 'admin', middleware: 'admin' })

interface Person {
  id: string
  slug: string
  name: string
  bio: string | null
  _count?: { credits: number }
}

const api = useApi()
const toast = useToast()

const q = ref('')
const { data, refresh } = await useApiData<Page<Person>>(
  'admin-people',
  () => `/people?limit=100${q.value ? `&q=${encodeURIComponent(q.value)}` : ''}`,
  { watch: [q] },
)

const newName = ref('')

async function create() {
  if (!newName.value.trim()) return
  try {
    await api('/people', { method: 'POST', body: { name: newName.value } })
    newName.value = ''
    await refresh()
  } catch (error) {
    const message = (error as { data?: { message?: string } }).data?.message
    toast.add({ title: message ?? 'Could not add that person.', color: 'error' })
  }
}

async function remove(person: Person) {
  // The cascade takes their credits with them; a credit with no person is not
  // a fact about anything.
  await api(`/people/${person.id}`, { method: 'DELETE' })
  await refresh()
}
</script>

<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-bold tracking-tight">People</h1>
      <p class="text-sm text-white/65">Cast and crew, shared across the library.</p>
    </div>

    <div class="flex flex-wrap gap-2">
      <UInput v-model="q" icon="i-lucide-search" placeholder="Search" class="w-64" />
      <div class="ml-auto flex gap-2">
        <UInput v-model="newName" placeholder="New person" class="w-56" @keyup.enter="create" />
        <UButton icon="i-lucide-plus" @click="create">Add</UButton>
      </div>
    </div>

    <div v-if="data?.items?.length" class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      <div
        v-for="person in data.items"
        :key="person.id"
        class="flex items-center gap-3 rounded-lg border border-white/12 bg-(--ui-bg-elevated) p-3"
      >
        <div class="grid size-10 shrink-0 place-items-center rounded-full bg-white/5 text-xs font-semibold">
          {{ person.name.slice(0, 2).toUpperCase() }}
        </div>
        <div class="min-w-0 grow">
          <NuxtLink :to="`/people/${person.slug}`" class="truncate text-sm font-medium hover:underline">
            {{ person.name }}
          </NuxtLink>
          <p class="text-xs text-white/70">{{ person._count?.credits ?? 0 }} credits</p>
        </div>
        <UButton
          size="xs"
          variant="ghost"
          color="error"
          icon="i-lucide-trash-2"
          :aria-label="`Remove ${person.name}`"
          @click="remove(person)"
        />
      </div>
    </div>

    <p v-else class="py-20 text-center text-white/70">
      {{ q ? 'Nobody matches.' : 'No people yet.' }}
    </p>
  </div>
</template>
