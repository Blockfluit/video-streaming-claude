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

/*
 * Fit-by-default, zoom-to-scroll — the same rule `FeedbackAnnotator` uses
 * for its own screenshot view (see that component's top-of-file comment),
 * reimplemented here for a plain `<img>` rather than a Konva stage since
 * there's nothing to draw on an admin's read-only view. `fitScale` and
 * `clampZoom` are the shared math (`app/utils/zoom.ts`); the anchor-
 * preserving zoom-to-cursor scroll math below is copied rather than shared,
 * since it reads/writes this component's own `scrollWrapperEl` and would
 * otherwise need a live template ref threaded through a composable for two
 * call sites.
 *
 * Natural size and the wrapper's own measured size both reset to 0 on
 * `viewing`, so opening the next item starts fit-to-width and un-zoomed
 * rather than carrying over whatever the previous item's zoom happened to
 * be, or a wrapper measurement taken from a screenshot no longer showing.
 */
const MIN_ZOOM = 0.5
const MAX_ZOOM = 3
const ZOOM_STEP = 0.25

const zoom = ref(1)
const naturalWidth = ref(0)
const naturalHeight = ref(0)
const scrollWrapperEl = useTemplateRef<HTMLDivElement>('lightboxWrapper')
const containerWidth = ref(0)
const containerHeight = ref(0)

/**
 * Preloaded the same way `FeedbackAnnotator` preloads its own screenshot —
 * through a bare `Image()`, not the template `<img>`'s own `@load` — so the
 * real `<img>` only ever renders already sized (`v-if="naturalWidth"` below)
 * rather than flashing up at its native size for a frame first. The actual
 * `<img>` still requests the same URL; the browser serves that from cache.
 */
watch(viewing, (item) => {
  zoom.value = 1
  naturalWidth.value = 0
  naturalHeight.value = 0
  if (!item) return

  const img = new Image()
  img.onload = () => {
    naturalWidth.value = img.naturalWidth
    naturalHeight.value = img.naturalHeight
    if (scrollWrapperEl.value) {
      containerWidth.value = scrollWrapperEl.value.clientWidth
      containerHeight.value = scrollWrapperEl.value.clientHeight
    }
  }
  img.src = `/api/admin/feedback/${item.id}/screenshot`
})

const scale = computed(() => fitScale(containerWidth.value, naturalWidth.value))
const displayScale = computed(() => scale.value * zoom.value)
const displayWidth = computed(() => naturalWidth.value * displayScale.value)
const displayHeight = computed(() => naturalHeight.value * displayScale.value)
const fitsWidth = computed(() => displayWidth.value <= containerWidth.value)
const fitsHeight = computed(() => displayHeight.value <= containerHeight.value)
const zoomPercent = computed(() => Math.round(zoom.value * 100))
const canZoomIn = computed(() => zoom.value < MAX_ZOOM)
const canZoomOut = computed(() => zoom.value > MIN_ZOOM)

/** Keeps one content point fixed under a given position in the wrapper's own viewport — the cursor, for a wheel zoom; the wrapper's centre, for the toolbar buttons. See `FeedbackAnnotator.zoomTo` for the full reasoning. */
function zoomTo(newZoom: number, anchorX?: number, anchorY?: number) {
  const wrapper = scrollWrapperEl.value
  if (!wrapper || newZoom === zoom.value) {
    zoom.value = newZoom
    return
  }

  const ax = anchorX ?? wrapper.clientWidth / 2
  const ay = anchorY ?? wrapper.clientHeight / 2
  const oldScale = displayScale.value
  const contentX = (wrapper.scrollLeft + ax) / oldScale
  const contentY = (wrapper.scrollTop + ay) / oldScale

  zoom.value = newZoom

  nextTick(() => {
    const newScale = displayScale.value
    wrapper.scrollLeft = contentX * newScale - ax
    wrapper.scrollTop = contentY * newScale - ay
  })
}

function zoomIn(anchorX?: number, anchorY?: number) {
  zoomTo(clampZoom(zoom.value + ZOOM_STEP, MIN_ZOOM, MAX_ZOOM), anchorX, anchorY)
}
function zoomOut(anchorX?: number, anchorY?: number) {
  zoomTo(clampZoom(zoom.value - ZOOM_STEP, MIN_ZOOM, MAX_ZOOM), anchorX, anchorY)
}

/** Ctrl/Cmd+scroll zooms toward the cursor; a plain wheel scrolls the wrapper as normal. */
function onWheel(event: WheelEvent) {
  if (!event.ctrlKey && !event.metaKey) return
  event.preventDefault()
  const wrapper = scrollWrapperEl.value
  const rect = wrapper?.getBoundingClientRect()
  const anchorX = rect ? event.clientX - rect.left : undefined
  const anchorY = rect ? event.clientY - rect.top : undefined
  if (event.deltaY < 0) zoomIn(anchorX, anchorY)
  else zoomOut(anchorX, anchorY)
}

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
      Same behaviour as the feedback dialog's own screenshot view, in
      `FeedbackAnnotator`: fits the frame by default, no scrollbars, and
      only ctrl/cmd+scroll or the zoom buttons ever make it scroll. See that
      component's top-of-file comment for the full reasoning behind the
      fit-scale, the anchor-preserving zoom, and why zooming needs `nextTick`
      before it can move `scrollLeft`/`scrollTop`; the state and functions
      here are the same math (`fitScale`/`clampZoom` from `app/utils/zoom.ts`
      are literally shared) reimplemented for a plain `<img>` rather than a
      Konva stage, since there's nothing to draw on an admin's read-only view.

      Sized to the same `74vw` share of the viewport as the dialog itself,
      for the same reason it's there: a fixed `max-w` is routinely narrower
      than a capture, and this is the one screen an admin opens specifically
      to look closely at one.

      `body` gets `flex flex-col` so the zoom toolbar and the frame below it
      stack instead of overlapping, and drops Nuxt UI's default
      `overflow-y-auto` — the same override `FeedbackDialog` needs and
      explains: `ui` *merges* onto that default rather than replacing it, so
      without `overflow-hidden` here there were two nested scroll containers
      fighting over the same wheel gesture instead of just the picture
      panning inside its frame.
    -->
    <UModal
      :open="viewing !== null"
      title="Screenshot"
      :ui="{ content: 'w-[74vw] max-w-[74vw]', body: 'p-0 overflow-hidden flex flex-col' }"
      @update:open="viewing = null"
    >
      <template #body>
        <div v-if="viewing" class="flex min-h-0 flex-1 flex-col">
          <div class="flex shrink-0 items-center justify-end gap-1.5 border-b border-(--ui-border) bg-(--ui-bg-elevated) px-3 py-2">
            <UButton size="md" variant="ghost" color="neutral" icon="i-lucide-zoom-out" :disabled="!canZoomOut" aria-label="Zoom out" @click="zoomOut()" />
            <span class="w-12 text-center text-sm text-(--ui-text-muted) tabular-nums">{{ zoomPercent }}%</span>
            <UButton size="md" variant="ghost" color="neutral" icon="i-lucide-zoom-in" :disabled="!canZoomIn" aria-label="Zoom in" @click="zoomIn()" />
          </div>

          <div
            ref="lightboxWrapper"
            class="min-h-0 flex-1 overflow-auto rounded-b-lg bg-(--ui-bg-elevated)"
            :class="fitsWidth && fitsHeight ? 'flex items-center justify-center' : ''"
            @wheel="onWheel"
          >
            <img
              v-if="naturalWidth"
              :src="`/api/admin/feedback/${viewing.id}/screenshot`"
              alt="Submitted screenshot"
              class="block max-w-none"
              :style="{ width: `${displayWidth}px`, height: `${displayHeight}px` }"
            >
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
