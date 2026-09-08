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
      <article
        v-for="item in items"
        :key="item.id"
        class="rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-4"
      >
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
          `truncate` rather than letting the full string set the card's
          width — a user agent is diagnostic detail nobody reads at a
          glance, and printed in full it routinely outran every other line
          on the card. The full string is still there on hover via `title`.
        -->
        <p class="mt-1 truncate text-xs text-(--ui-text-dimmed)" :title="item.userAgent">
          {{ item.viewportWidth }}×{{ item.viewportHeight }} · {{ item.userAgent }}
        </p>

        <!--
          A border that brightens on hover, not an overlay — the same
          affordance every other clickable card in this app uses, so this
          one doesn't need to be discovered by accident.
        -->
        <button
          v-if="item.hasScreenshot"
          type="button"
          class="mt-3 block"
          :aria-label="`View the full screenshot from ${item.user.displayName}`"
          @click="viewing = item"
        >
          <img
            :src="`/api/admin/feedback/${item.id}/screenshot`"
            alt="Submitted screenshot"
            class="h-32 rounded border border-(--ui-border) object-cover transition-colors hover:border-(--ui-border-accented)"
          >
        </button>
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

    <UModal :open="viewing !== null" title="Screenshot" :ui="{ content: 'max-w-4xl' }" @update:open="viewing = null">
      <template #body>
        <img
          v-if="viewing"
          :src="`/api/admin/feedback/${viewing.id}/screenshot`"
          alt="Submitted screenshot"
          class="mx-auto max-h-[85vh] w-full rounded object-contain"
        >
      </template>
    </UModal>
  </div>
</template>
