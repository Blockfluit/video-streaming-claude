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
  imdbId: string | null
  knownFor: string | null
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
const resolving = ref(false)

/**
 * Fills in the IMDb ids an import could not.
 *
 * TMDB does not return a person's IMDb id alongside a title's credits, so they
 * are normally resolved lazily behind whoever gets looked at. That is fine for a
 * library being browsed and slow for one that has just had a hundred films
 * imported, which is what this is for.
 */
async function resolveLinks() {
  resolving.value = true
  try {
    const result = await api<{ resolved: number, checked: number }>(
      '/admin/metadata/people/resolve-links',
      { method: 'POST' },
    )
    await refresh()
    toast.add({
      title: result.checked === 0
        ? 'Everybody who can be linked already is'
        : `Linked ${result.resolved} of ${result.checked}`,
      color: 'success',
    })
  }
  catch (error) {
    toast.add({ title: apiMessage(error, 'Could not resolve links'), color: 'error' })
  }
  finally {
    resolving.value = false
  }
}

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

useHead({ title: 'People' })
</script>

<template>
  <div class="space-y-6">
    <div>
      <div class="flex items-center justify-between gap-3">
        <h1 class="text-2xl font-bold tracking-tight">People</h1>
        <UButton
          color="neutral"
          variant="subtle"
          icon="i-lucide-link"
          :loading="resolving"
          @click="resolveLinks"
        >
          Resolve IMDb links
        </UButton>
      </div>
      <p class="text-sm text-(--ui-text-muted)">Cast and crew, shared across the library.</p>
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
        class="flex items-center gap-3 rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-3"
      >
        <div class="grid size-10 shrink-0 place-items-center rounded-full bg-(--ui-bg-elevated) text-xs font-semibold">
          {{ person.name.slice(0, 2).toUpperCase() }}
        </div>
        <div class="min-w-0 grow">
          <NuxtLink :to="`/people/${person.slug}`" class="truncate text-sm font-medium hover:underline">
            {{ person.name }}
          </NuxtLink>
          <p class="text-xs text-(--ui-text-muted)">
            {{ person._count?.credits ?? 0 }} credits
            <!-- What they do, which is what a people search wants to show. -->
            <span v-if="person.knownFor"> · {{ person.knownFor }}</span>
          </p>
        </div>
        <ImdbLink :imdb-id="person.imdbId" kind="person" :label="person.name" />
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

    <p v-else class="py-20 text-center text-(--ui-text-muted)">
      {{ q ? 'Nobody matches.' : 'No people yet.' }}
    </p>
  </div>
</template>
