<!-- apps/web/app/components/FeedbackDialog.vue -->
<script setup lang="ts">
import { MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES } from '@video/shared'

import FeedbackAnnotatorComponent from './FeedbackAnnotator.vue'

const props = defineProps<{
  screenshot: string | null
}>()

const open = defineModel<boolean>('open', { required: true })

const api = useApi()
const toast = useToast()
const route = useRoute()

const message = ref('')
const submitting = ref(false)
const annotator = ref<InstanceType<typeof FeedbackAnnotatorComponent> | null>(null)

/*
 * The toolbar lives here, not inside `FeedbackAnnotator` — it's rendered at
 * the top of the message column instead of beside the picture (see that
 * component's own top-of-file comment). Everything it needs is read through
 * `annotator`'s exposed handle rather than owned here: Vue's `expose()`
 * proxy auto-unwraps refs in the exposed object, the same way a template
 * ref's own `.value` already reflects a component's setup-returned refs —
 * so `annotator.value?.tool` is already the current `Tool` string, not a
 * ref needing its own `.value`. Wrapped in `computed()` anyway so the
 * toolbar re-renders when the child's state changes, since a bare read in
 * the template only re-evaluates on `annotator` itself changing (mount/
 * unmount), not on the values inside it.
 */
const activeTool = computed(() => annotator.value?.tool)
const zoomPercent = computed(() => Math.round((annotator.value?.zoom ?? 1) * 100))
const canZoomIn = computed(() => annotator.value?.canZoomIn ?? false)
const canZoomOut = computed(() => annotator.value?.canZoomOut ?? false)
const canUndo = computed(() => annotator.value?.canUndo ?? false)

watch(open, (value) => {
  if (!value) message.value = ''
})

async function submit() {
  if (!message.value.trim()) return

  submitting.value = true
  try {
    const captured = annotator.value?.export() ?? props.screenshot ?? undefined

    /*
     * The API would reject an oversized screenshot with a 400 that this
     * dialog has no way to recover from — resubmitting fails identically
     * forever, since the image never gets smaller on its own. Checked here,
     * before the request goes out, so the worst case is losing the picture
     * rather than losing the feedback too.
     */
    const oversized = captured !== undefined && decodedByteLength(captured) > MAX_FEEDBACK_SCREENSHOT_BYTES
    if (oversized) {
      toast.add({
        title: 'Your screenshot was too large to attach, but your message will still be sent.',
        color: 'warning',
      })
    }

    await api('/feedback', {
      method: 'POST',
      body: {
        message: message.value,
        pageUrl: route.fullPath,
        userAgent: navigator.userAgent,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        screenshot: oversized ? undefined : captured,
      },
    })
    toast.add({ title: 'Thanks — feedback sent', color: 'success' })
    open.value = false
  }
  catch (error) {
    toast.add({ title: apiMessage(error, 'Could not send that.'), color: 'error' })
  }
  finally {
    submitting.value = false
  }
}
</script>

<template>
  <!--
    Fixed as a share of the viewport in both directions, not just a
    max-width — a bigger modal was asked for explicitly. The annotator fits
    its image by *width* alone (see its own scale comment), so the exact
    share in each direction is tuned against how tall the image ends up at
    that width, not picked for looks — see the values below for the
    reasoning at whatever they currently are.

    The body is a row, not a column: the image on the left, a column on the
    right holding — top to bottom — the annotator's toolbar, the message
    textarea, and the Cancel/Send buttons. The toolbar sits in this column
    rather than beside the picture, and Send/Cancel sit under the comment
    box rather than in a `#footer` spanning both columns — both asked for
    after the stacked layout put the toolbar next to the image and the
    buttons in a bar underneath everything.

    `body` drops Nuxt UI's default `overflow-y-auto` in favour of
    `overflow-hidden`: without that, scrolling a tall annotated image would
    scroll the *whole dialog* — toolbar, textarea and Send button included —
    off screen along with it, rather than just panning the picture. The inner
    `min-h-0`/`min-w-0` + `flex-1` chain (here, and again on
    `FeedbackAnnotator`'s own root and its scroll wrapper) is what makes only
    that one region — the image — actually own the scrollbar; a flex child
    needs `min-h-0`/`min-w-0` to be allowed to shrink below its content size
    at all, or `flex-1` alone does nothing.
  -->
  <UModal
    v-model:open="open"
    title="Send feedback"
    :ui="{
      content: 'w-[74vw] max-w-[74vw] h-[90vh] max-h-[90vh]',
      body: 'flex-1 min-h-0 overflow-hidden flex flex-col',
    }"
  >
    <template #body>
      <div class="flex min-h-0 min-w-0 flex-1 flex-row gap-4">
        <FeedbackAnnotator v-if="screenshot" ref="annotator" :screenshot="screenshot" class="min-h-0 min-w-0 flex-1" />
        <p v-else class="flex min-h-0 min-w-0 flex-1 items-center justify-center text-center text-sm text-(--ui-text-muted)">
          Couldn't capture a screenshot of this page — you can still describe what's wrong below.
        </p>

        <div class="flex h-full w-80 shrink-0 flex-col gap-3">
          <div v-if="screenshot" class="flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-2">
            <UButton size="md" :variant="activeTool === 'pen' ? 'solid' : 'subtle'" color="neutral" icon="i-lucide-pencil" aria-label="Pen" @click="annotator?.setTool('pen')" />
            <UButton size="md" :variant="activeTool === 'rectangle' ? 'solid' : 'subtle'" color="neutral" icon="i-lucide-square" aria-label="Rectangle" @click="annotator?.setTool('rectangle')" />
            <UButton size="md" :variant="activeTool === 'arrow' ? 'solid' : 'subtle'" color="neutral" icon="i-lucide-move-up-right" aria-label="Arrow" @click="annotator?.setTool('arrow')" />
            <UButton size="md" :variant="activeTool === 'text' ? 'solid' : 'subtle'" color="neutral" icon="i-lucide-type" aria-label="Text" @click="annotator?.setTool('text')" />
            <UButton size="md" :variant="activeTool === 'hand' ? 'solid' : 'subtle'" color="neutral" icon="i-lucide-hand" aria-label="Move" @click="annotator?.setTool('hand')" />

            <div class="mx-1 flex items-center gap-1.5">
              <UButton size="md" variant="ghost" color="neutral" icon="i-lucide-zoom-out" :disabled="!canZoomOut" aria-label="Zoom out" @click="annotator?.zoomOut()" />
              <span class="w-12 text-center text-sm text-(--ui-text-muted)">{{ zoomPercent }}%</span>
              <UButton size="md" variant="ghost" color="neutral" icon="i-lucide-zoom-in" :disabled="!canZoomIn" aria-label="Zoom in" @click="annotator?.zoomIn()" />
            </div>

            <UButton size="md" variant="ghost" color="neutral" icon="i-lucide-undo-2" :disabled="!canUndo" aria-label="Undo" class="ml-auto" @click="annotator?.undo()" />
          </div>

          <UTextarea
            v-model="message"
            :maxlength="MAX_FEEDBACK_MESSAGE_LENGTH"
            placeholder="What's wrong, or what could be better?"
            aria-label="Feedback message"
            class="min-h-0 flex-1"
            :ui="{ root: 'h-full', base: 'h-full resize-none' }"
          />

          <div class="flex shrink-0 justify-end gap-2">
            <UButton color="neutral" variant="ghost" @click="open = false">Cancel</UButton>
            <UButton :loading="submitting" :disabled="!message.trim()" @click="submit">Send</UButton>
          </div>
        </div>
      </div>
    </template>
  </UModal>
</template>
