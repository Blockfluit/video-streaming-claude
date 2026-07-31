<script setup lang="ts">
import { MAX_COMMENT_LENGTH } from '@video/shared'

/**
 * Comments under the player. Flat, newest first.
 *
 * A deleted comment keeps its place in the thread as a tombstone with no body
 * and no author — that is what the API serves, and rendering it as a gap is
 * what makes the surrounding replies still read.
 */
interface CommentView {
  id: string
  body: string | null
  timestampSec: number | null
  editedAt: string | null
  deleted: boolean
  createdAt: string
  user: { id: string, displayName: string } | null
}

const props = defineProps<{
  videoId: string
  /** Current playback position, so a comment can be pinned to the moment. */
  currentTime?: number
}>()

const emit = defineEmits<{ seek: [seconds: number] }>()

const api = useApi()
const toast = useToast()
const { user, isAdmin } = useSession()

const { data, refresh } = await useApiData<{ items: CommentView[], total: number }>(
  `comments-${props.videoId}`,
  `/videos/${props.videoId}/comments?limit=100`,
)

const draft = ref('')
const pinToMoment = ref(false)
const posting = ref(false)

async function post() {
  if (!draft.value.trim()) return
  posting.value = true

  try {
    await api(`/videos/${props.videoId}/comments`, {
      method: 'POST',
      body: {
        body: draft.value,
        timestampSec: pinToMoment.value ? Math.floor(props.currentTime ?? 0) : null,
      },
    })
    draft.value = ''
    pinToMoment.value = false
    await refresh()
  } catch {
    toast.add({ title: 'Could not post that.', color: 'error' })
  } finally {
    posting.value = false
  }
}

async function remove(comment: CommentView) {
  try {
    await api(`/comments/${comment.id}`, { method: 'DELETE' })
    await refresh()
  } catch {
    toast.add({ title: 'Could not delete that.', color: 'error' })
  }
}

/** The author's own, or anyone's for an admin — editing is the author's alone. */
const canDelete = (comment: CommentView) =>
  !comment.deleted && (comment.user?.id === user.value?.id || isAdmin.value)
</script>

<template>
  <section class="space-y-5">
    <h2 class="text-lg font-semibold">
      Comments
      <span class="text-white/70">{{ data?.total ?? 0 }}</span>
    </h2>

    <div class="space-y-2">
      <UTextarea
        v-model="draft"
        :maxlength="MAX_COMMENT_LENGTH"
        :rows="3"
        placeholder="Say something about this…"
        class="w-full"
      />
      <div class="flex items-center gap-3">
        <UCheckbox v-model="pinToMoment" :label="`Pin to ${timecode(currentTime)}`" />
        <UButton class="ml-auto" :loading="posting" :disabled="!draft.trim()" @click="post">
          Post
        </UButton>
      </div>
    </div>

    <ul class="space-y-4">
      <li v-for="comment in data?.items ?? []" :key="comment.id" class="group flex gap-3">
        <div
          class="grid size-9 shrink-0 place-items-center rounded-full text-xs font-semibold"
          :class="comment.deleted ? 'bg-white/5 text-white/65' : 'bg-(--ui-bg-accented) text-white/80'"
        >
          {{ comment.deleted ? '—' : comment.user?.displayName.slice(0, 2).toUpperCase() }}
        </div>

        <div class="min-w-0 grow">
          <p v-if="comment.deleted" class="text-sm text-white/55 italic">
            This comment was removed.
          </p>

          <template v-else>
            <div class="flex items-baseline gap-2">
              <span class="text-sm font-medium">{{ comment.user?.displayName }}</span>
              <button
                v-if="comment.timestampSec !== null"
                type="button"
                class="text-xs text-(--ui-primary) hover:underline"
                @click="emit('seek', comment.timestampSec!)"
              >
                {{ timecode(comment.timestampSec) }}
              </button>
              <span v-if="comment.editedAt" class="text-xs text-white/55">edited</span>

              <UButton
                v-if="canDelete(comment)"
                icon="i-lucide-trash-2"
                variant="ghost"
                color="neutral"
                size="xs"
                class="ml-auto opacity-60 transition-opacity group-hover:opacity-100 focus:opacity-100"
                aria-label="Delete comment"
                @click="remove(comment)"
              />
            </div>
            <p class="text-sm whitespace-pre-wrap text-white/80">{{ comment.body }}</p>
          </template>
        </div>
      </li>
    </ul>

    <p v-if="(data?.items?.length ?? 0) === 0" class="text-sm text-white/70">
      Nothing yet. Say the first thing.
    </p>
  </section>
</template>
