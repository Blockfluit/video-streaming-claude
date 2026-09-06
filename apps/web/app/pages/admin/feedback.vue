<!-- apps/web/app/pages/admin/feedback.vue -->
<script setup lang="ts">
import type { Page } from '@video/shared'

/**
 * Everything submitted through the floating feedback button, newest first.
 *
 * No status workflow, unlike Comments or Requests — read it, act on it, and
 * delete it when you're done. The screenshot (when there is one) is served
 * from its own admin-only route rather than embedded in this response.
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

const { data, refresh } = await useApiData<Page<FeedbackAdminView>>(
  'admin-feedback',
  () => '/admin/feedback?limit=100',
  {},
)

const items = computed(() => data.value?.items ?? [])

const viewing = ref<FeedbackAdminView | null>(null)

async function remove(item: FeedbackAdminView) {
  try {
    await api(`/admin/feedback/${item.id}`, { method: 'DELETE' })
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
          <a :href="item.pageUrl" target="_blank" rel="noopener" class="text-(--ui-text-muted) hover:text-(--ui-text-highlighted)">
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

        <p class="mt-1 text-xs text-(--ui-text-dimmed)">
          {{ item.viewportWidth }}×{{ item.viewportHeight }} · {{ item.userAgent }}
        </p>

        <button
          v-if="item.hasScreenshot"
          type="button"
          class="mt-2 block"
          @click="viewing = item"
        >
          <img
            :src="`/api/admin/feedback/${item.id}/screenshot`"
            alt="Submitted screenshot"
            class="h-24 rounded border border-(--ui-border) object-cover"
          >
        </button>
      </article>
    </div>

    <p v-else class="py-20 text-center text-(--ui-text-muted)">
      Nobody has submitted feedback yet.
    </p>

    <UModal :open="viewing !== null" title="Screenshot" @update:open="viewing = null">
      <template #body>
        <img
          v-if="viewing"
          :src="`/api/admin/feedback/${viewing.id}/screenshot`"
          alt="Submitted screenshot"
          class="w-full rounded"
        >
      </template>
    </UModal>
  </div>
</template>
