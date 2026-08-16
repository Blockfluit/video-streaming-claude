<script setup lang="ts">
import { MAX_ADMIN_NOTE_LENGTH, type Page, type RequestStatus } from '@video/shared'

/**
 * The request queue.
 *
 * The same rows the viewer page shows, with everything the viewer page hides:
 * who asked, who last answered and when. The status control is here and nowhere
 * else — `PATCH /requests/:id/status` is ADMIN-only, so this screen is the only
 * place it can be driven from.
 *
 * The one thing this screen has that no other does is `libraryMatch`: a request
 * whose title is already in the library as a **draft**. A viewer's request is
 * checked only against what a viewer can see, so a draft never refuses them —
 * which means this is where the two get put side by side.
 */
definePageMeta({ layout: 'admin', middleware: 'admin' })

const api = useApi()
const toast = useToast()

const q = ref('')
const statusFilter = ref<string>(ANY_STATUS)

// What the list is actually filtered by, once the typing has settled.
const searchTerm = ref('')

useDebounced(q, (value) => { searchTerm.value = value })

const query = computed(() => {
  const params = new URLSearchParams({ limit: '100' })
  if (statusFilter.value !== ANY_STATUS) params.set('status', statusFilter.value)
  if (searchTerm.value) params.set('q', searchTerm.value)
  return params.toString()
})

const { data, refresh } = await useApiData<Page<RequestView>>(
  'admin-requests',
  () => `/requests?${query.value}`,
  { watch: [query] },
)

const requests = computed(() => data.value?.items ?? [])

/** Which request has its note editor open, and what is in it. */
const editingNote = ref<string | null>(null)
const noteDraft = ref('')

function openNote(request: RequestView) {
  editingNote.value = request.id
  noteDraft.value = request.adminNote ?? ''
}

/**
 * Sends the status, and the note only when it is being edited.
 *
 * Omitting `adminNote` leaves the stored one alone — so changing a status from
 * the dropdown does not quietly wipe the explanation attached to the request.
 */
async function setStatus(request: RequestView, status: RequestStatus, withNote = false) {
  try {
    await api(`/requests/${request.id}/status`, {
      method: 'PATCH',
      body: withNote ? { status, adminNote: noteDraft.value } : { status },
    })
    editingNote.value = null
    await refresh()
    toast.add({ title: `Marked ${requestStatusLabel(status).toLowerCase()}`, color: 'success' })
  }
  catch (error) {
    toast.add({ title: apiMessage(error, 'Could not update that.'), color: 'error' })
  }
}

async function remove(request: RequestView) {
  try {
    await api(`/requests/${request.id}`, { method: 'DELETE' })
    await refresh()
    toast.add({ title: 'Request removed', color: 'success' })
  }
  catch (error) {
    toast.add({ title: apiMessage(error, 'Could not remove that.'), color: 'error' })
  }
}

function matchPath(match: RequestView['libraryMatch']): string | null {
  if (!match) return null

  return match.kind === 'collection'
    ? collectionPath(match)
    : videoPath({ slug: match.slug })
}

useHead({ title: 'Requests' })
</script>

<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-bold tracking-tight">Requests</h1>
      <p class="text-sm text-(--ui-text-muted)">
        What people have asked for, newest first. Only you can change a status.
      </p>
    </div>

    <div class="flex flex-wrap items-center gap-3">
      <UInput
        v-model="q"
        icon="i-lucide-search"
        placeholder="Search titles"
        class="w-72"
      />
      <USelect
        v-model="statusFilter"
        :items="requestStatusFilterOptions"
        aria-label="Filter requests by status"
        class="w-44"
      />
      <span class="ml-auto text-sm text-(--ui-text-muted)">
        {{ data?.total ?? 0 }} total
      </span>
    </div>

    <div v-if="requests.length" class="space-y-2">
      <article
        v-for="request in requests"
        :key="request.id"
        class="rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-4"
      >
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="font-medium">{{ request.title }}</h2>
          <span v-if="request.year" class="text-sm text-(--ui-text-muted)">
            {{ request.year }}
          </span>

          <UBadge
            :color="requestStatusColour(request.status)"
            variant="subtle"
            size="sm"
          >
            {{ requestStatusLabel(request.status) }}
          </UBadge>

          <UButton
            class="ml-auto"
            size="xs"
            color="neutral"
            variant="subtle"
            icon="i-lucide-trash-2"
            :aria-label="`Remove the request for ${request.title}`"
            @click="remove(request)"
          >
            Remove
          </UButton>
        </div>

        <!-- Who and when: the whole reason this screen is separate. -->
        <p class="mt-1 text-sm text-(--ui-text-muted)">
          Asked by
          <span class="text-(--ui-text)">{{ request.requestedBy?.displayName ?? 'a deleted account' }}</span>
          on {{ dateTime(request.createdAt) }}
          <template v-if="request.statusChangedBy && request.statusChangedAt">
            · last changed by
            <span class="text-(--ui-text)">{{ request.statusChangedBy.displayName }}</span>
            on {{ dateTime(request.statusChangedAt) }}
          </template>
        </p>

        <p v-if="request.comment" class="mt-2 text-sm whitespace-pre-wrap text-(--ui-text)">
          {{ request.comment }}
        </p>

        <!--
          Already in the library. Usually a draft — a published one would have
          refused the request before it was ever made.
        -->
        <div
          v-if="request.libraryMatch"
          class="mt-3 flex flex-wrap items-center gap-2 rounded-md bg-(--ui-bg-accented) px-3 py-2 text-sm"
        >
          <UIcon name="i-lucide-library" class="size-4 shrink-0" />
          <span>
            Already in the library as
            <span class="text-(--ui-text-highlighted)">{{ request.libraryMatch.title }}</span>
          </span>
          <UBadge color="neutral" variant="subtle" size="sm">
            {{ request.libraryMatch.state }}
          </UBadge>
          <NuxtLink
            v-if="matchPath(request.libraryMatch)"
            :to="matchPath(request.libraryMatch)!"
            class="text-(--ui-text-muted) underline hover:text-(--ui-text-highlighted)"
          >
            Open it
          </NuxtLink>
        </div>

        <p v-if="request.adminNote && editingNote !== request.id" class="mt-2 text-sm text-(--ui-text-muted)">
          <span class="font-medium text-(--ui-text)">Your reply:</span>
          {{ request.adminNote }}
        </p>

        <!-- The controls. -->
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <USelect
            :model-value="request.status"
            :items="requestStatusOptions"
            :aria-label="`Set the status of the request for ${request.title}`"
            class="w-44"
            @update:model-value="value => setStatus(request, value as RequestStatus)"
          />

          <UButton
            size="xs"
            color="neutral"
            variant="subtle"
            icon="i-lucide-message-square"
            @click="editingNote === request.id ? (editingNote = null) : openNote(request)"
          >
            {{ request.adminNote ? 'Edit reply' : 'Add a reply' }}
          </UButton>
        </div>

        <div v-if="editingNote === request.id" class="mt-3 space-y-2">
          <UTextarea
            v-model="noteDraft"
            :maxlength="MAX_ADMIN_NOTE_LENGTH"
            :rows="2"
            placeholder="Why, or what happens next. Everyone sees this."
            class="w-full"
            :aria-label="`Reply to the request for ${request.title}`"
          />
          <div class="flex justify-end gap-2">
            <UButton size="xs" color="neutral" variant="ghost" @click="editingNote = null">
              Cancel
            </UButton>
            <UButton size="xs" variant="solid" @click="setStatus(request, request.status, true)">
              Save reply
            </UButton>
          </div>
        </div>
      </article>
    </div>

    <p v-else class="py-20 text-center text-(--ui-text-muted)">
      {{ q || statusFilter !== ANY_STATUS ? 'Nothing matches that.' : 'Nobody has requested anything yet.' }}
    </p>
  </div>
</template>
