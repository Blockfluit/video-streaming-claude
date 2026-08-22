<script setup lang="ts">
import type { Page } from '@video/shared'

/**
 * Moderating comments across the whole library.
 *
 * Deleting from the thread under a video works, but only if you already know
 * where the comment is — which is the wrong way round. Something worth removing
 * is most likely on a video nobody is watching, and this is the only screen
 * that looks at every video at once.
 *
 * **Removal only.** Editing someone's words and leaving their name on it is not
 * moderation, and the API refuses it for admins too — `editedAt` would make it
 * look as though the author had done it themselves.
 */
definePageMeta({ layout: 'admin', middleware: 'admin' })

interface ModeratedComment {
  id: string
  videoId: string
  body: string | null
  timestampSec: number | null
  deleted: boolean
  createdAt: string
  user: { id: string, displayName: string } | null
  video: { id: string, slug: string, title: string, state: string } | null
}

const api = useApi()
const toast = useToast()

const q = ref('')
const includeDeleted = ref(false)

// What the list is actually filtered by, once the typing has settled.
const searchTerm = ref('')

useDebounced(q, (value) => { searchTerm.value = value })

const query = computed(() => {
  const params = new URLSearchParams({ limit: '100' })
  if (searchTerm.value) params.set('q', searchTerm.value)
  // booleanParam on the API side: "false" is false, unlike z.coerce.boolean().
  if (includeDeleted.value) params.set('includeDeleted', 'true')
  return params.toString()
})

const { data, refresh } = await useApiData<Page<ModeratedComment>>(
  'admin-comments',
  () => `/admin/comments?${query.value}`,
  { watch: [query] },
)

const comments = computed(() => data.value?.items ?? [])

async function remove(comment: ModeratedComment) {
  try {
    // Idempotent by design, so a double-click is not an error.
    await api(`/comments/${comment.id}`, { method: 'DELETE' })
    await refresh()
    toast.add({ title: 'Comment removed', color: 'success' })
  }
  catch (error) {
    toast.add({ title: apiMessage(error, 'Could not remove that'), color: 'error' })
  }
}

useHead({ title: 'Comments' })
</script>

<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-bold tracking-tight">Comments</h1>
      <p class="text-sm text-(--ui-text-muted)">
        Everything posted across the library, newest first.
      </p>
    </div>

    <div class="flex flex-wrap items-center gap-3">
      <UInput
        v-model="q"
        icon="i-lucide-search"
        placeholder="Search comments"
        class="w-full sm:w-72"
      />
      <UCheckbox v-model="includeDeleted" label="Show removed" />
      <span class="ml-auto text-sm text-(--ui-text-muted)">
        {{ data?.total ?? 0 }} total
      </span>
    </div>

    <div v-if="comments.length" class="space-y-2">
      <article
        v-for="comment in comments"
        :key="comment.id"
        class="rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-4"
      >
        <div class="flex flex-wrap items-center gap-2 text-sm">
          <span class="font-medium">{{ comment.user?.displayName ?? 'Removed' }}</span>
          <span class="text-(--ui-text-dimmed)">{{ dateTime(comment.createdAt) }}</span>

          <NuxtLink
            v-if="comment.video"
            :to="`/admin/videos/${comment.video.id}`"
            class="text-(--ui-text-muted) hover:text-(--ui-text-highlighted)"
          >
            on {{ comment.video.title }}
          </NuxtLink>
          <UBadge
            v-if="comment.video && comment.video.state !== 'PUBLISHED'"
            color="neutral"
            variant="subtle"
            size="sm"
          >
            {{ comment.video.state }}
          </UBadge>
          <UBadge v-if="comment.deleted" color="warning" variant="subtle" size="sm">
            removed
          </UBadge>

          <UButton
            v-if="!comment.deleted"
            class="ml-auto"
            size="xs"
            color="error"
            variant="subtle"
            icon="i-lucide-trash-2"
            :aria-label="`Remove comment by ${comment.user?.displayName ?? 'unknown'}`"
            @click="remove(comment)"
          >
            Remove
          </UButton>
        </div>

        <!--
          A tombstone carries no body at all — `toCommentView` builds it from
          nothing rather than blanking fields, so there is genuinely nothing to
          print here for a removed comment.
        -->
        <p v-if="comment.body" class="mt-2 text-sm whitespace-pre-wrap">{{ comment.body }}</p>
        <p v-else class="mt-2 text-sm text-(--ui-text-dimmed) italic">
          This comment was removed.
        </p>
      </article>
    </div>

    <p v-else class="py-20 text-center text-(--ui-text-muted)">
      {{ q ? 'Nothing matches that.' : 'Nobody has commented yet.' }}
    </p>
  </div>
</template>
