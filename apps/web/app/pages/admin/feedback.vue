<!-- apps/web/app/pages/admin/feedback.vue -->
<script setup lang="ts">
import { MAX_PAGE_LIMIT, type Page } from '@video/shared'

/**
 * Everything submitted through the floating feedback button, newest first.
 *
 * No status workflow, unlike Comments or Requests — read it, act on it, and
 * delete it when you're done. The screenshot (when there is one) is served
 * from its own admin-only route rather than embedded in this response.
 *
 * Feedback is never filtered or searched — the only question this screen asks
 * is "the next window" — so this is `useLoadMore` on its own, the way
 * `admin/people.vue` uses it, minus the search box and its debounce.
 */
definePageMeta({ layout: 'admin', middleware: 'admin' })

interface FeedbackAdminView {
  id: string
  message: string
  pageUrl: string
  userAgent: string
  viewportWidth: number
  viewportHeight: number
  hasScreenshot: boolean
  createdAt: string
  user: { id: string, displayName: string }
}

const api = useApi()
const toast = useToast()

/** A hundred at a time — the most the endpoint will serve in one request. */
const PAGE_SIZE = MAX_PAGE_LIMIT

function feedbackQuery(offset: number): string {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) })
  // Left out at zero: `?offset=0` says the same thing and reads like a bug.
  if (offset > 0) params.set('offset', String(offset))
  return `/admin/feedback?${params.toString()}`
}

const { data, error, refresh } = await useApiData<Page<FeedbackAdminView>>(
  'admin-feedback',
  () => feedbackQuery(0),
  {},
)

const total = computed(() => data.value?.total ?? 0)

const {
  items,
  label: moreLabel,
  loading: loadingMore,
  loadMore,
  reset,
} = useLoadMore<FeedbackAdminView>({
  first: () => data.value?.items ?? [],
  total: () => total.value,
  pageSize: PAGE_SIZE,
  // There is no filter here, so every call is the same question.
  question: () => true,
  query: feedbackQuery,
  failure: 'Could not load more feedback',
})

const viewing = ref<FeedbackAdminView | null>(null)

/**
 * Back to one window, and re-fetch it.
 *
 * `refresh()` alone would leave appended windows in place across a delete
 * that shifted every later row up by one — see `useLoadMore`'s own doc
 * comment for why that reads as a row vanishing rather than moving.
 */
async function remove(item: FeedbackAdminView) {
  try {
    await api(`/admin/feedback/${item.id}`, { method: 'DELETE' })
    reset()
    await refresh()
    toast.add({ title: 'Feedback removed', color: 'success' })
  }
  catch (error) {
    toast.add({ title: apiMessage(error, 'Could not remove that.'), color: 'error' })
  }
}

useHead({ title: 'Feedback' })
</script>

<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-bold tracking-tight">Feedback</h1>
      <p class="text-sm text-(--ui-text-muted)">
        Everything submitted through the feedback button, newest first.
        <span v-if="total">· {{ total }} {{ total === 1 ? 'submission' : 'submissions' }}</span>
      </p>
    </div>

    <div v-if="items.length" class="space-y-2">
      <!--
        The same shape as the feedback dialog itself: the screenshot in its
        own framed box on the left, everything else in a column on the
        right — no toolbar here (there's nothing to draw), but the same
        "picture on one side, its context on the other" split, rather than
        the picture as an afterthought stacked under three lines of text.
      -->
      <article
        v-for="item in items"
        :key="item.id"
        class="flex gap-4 rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-4"
      >
        <button
          v-if="item.hasScreenshot"
          type="button"
          class="block h-40 w-56 shrink-0 overflow-hidden rounded-lg border border-(--ui-border) transition-colors hover:border-(--ui-border-accented)"
          :aria-label="`View the full screenshot from ${item.user.displayName}`"
          @click="viewing = item"
        >
          <img
            :src="`/api/admin/feedback/${item.id}/screenshot`"
            alt="Submitted screenshot"
            class="size-full object-cover"
          >
        </button>
        <div
          v-else
          class="flex h-40 w-56 shrink-0 items-center justify-center rounded-lg border border-(--ui-border) text-center text-sm text-(--ui-text-dimmed)"
        >
          No screenshot
        </div>

        <div class="flex min-w-0 flex-1 flex-col">
          <div class="flex flex-wrap items-center gap-2 text-sm">
            <span class="font-medium">{{ item.user.displayName }}</span>
            <span class="text-(--ui-text-dimmed)">{{ dateTime(item.createdAt) }}</span>
            <a
              :href="item.pageUrl"
              target="_blank"
              rel="noopener"
              class="inline-flex items-center gap-1 text-(--ui-text-muted) hover:text-(--ui-text-highlighted)"
            >
              <UIcon name="i-lucide-external-link" class="size-3.5 shrink-0" />
              {{ item.pageUrl }}
            </a>

            <UButton
              class="ml-auto"
              size="xs"
              color="error"
              variant="subtle"
              icon="i-lucide-trash-2"
              :aria-label="`Remove feedback from ${item.user.displayName}`"
              @click="remove(item)"
            >
              Remove
            </UButton>
          </div>

          <p class="mt-2 text-sm whitespace-pre-wrap">{{ item.message }}</p>

          <!--
            `mt-auto` pins this to the bottom of the column, which is as
            tall as the screenshot beside it (flex row children stretch to
            match by default) — so a short message doesn't leave the
            technical detail floating awkwardly in the middle of empty
            space. `truncate` rather than letting the full string set the
            column's width — a user agent is diagnostic detail nobody reads
            at a glance; the full string is still there on hover via `title`.
          -->
          <p class="mt-auto truncate pt-2 text-xs text-(--ui-text-dimmed)" :title="item.userAgent">
            {{ item.viewportWidth }}×{{ item.viewportHeight }} · {{ item.userAgent }}
          </p>
        </div>
      </article>
    </div>

    <p v-else-if="error" class="py-20 text-center text-(--ui-text-muted)">
      Could not load feedback. Try refreshing the page.
    </p>

    <p v-else class="py-20 text-center text-(--ui-text-muted)">
      Nobody has submitted feedback yet.
    </p>

    <!-- The offer names what is left, same as `admin/people.vue` and for the same reason. -->
    <div v-if="moreLabel" class="flex justify-center pt-2">
      <UButton color="neutral" variant="subtle" :loading="loadingMore" @click="loadMore">
        {{ moreLabel }}
      </UButton>
    </div>

    <!--
      The screenshot at its native resolution, not shrunk to fit — a capture
      is routinely wider and taller than 85vh, and squeezing it down is
      exactly what a moderator reviewing a small UI detail doesn't want.
      `overflow-auto` on a fixed-height frame scrolls the picture instead;
      `w-max` keeps the image itself from being flexed down to the frame's
      width the way `w-full` would.
    -->
    <UModal
      :open="viewing !== null"
      title="Screenshot"
      :ui="{ content: 'max-w-4xl', body: 'p-0' }"
      @update:open="viewing = null"
    >
      <template #body>
        <div
          v-if="viewing"
          class="max-h-[80vh] overflow-auto rounded-b-lg border-t border-(--ui-border) bg-(--ui-bg-elevated)"
        >
          <img
            :src="`/api/admin/feedback/${viewing.id}/screenshot`"
            alt="Submitted screenshot"
            class="mx-auto block w-max max-w-none"
          >
        </div>
      </template>
    </UModal>
  </div>
</template>
