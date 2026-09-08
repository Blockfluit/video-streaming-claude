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
    max-width — a bigger modal was asked for explicitly. Width and height
    are deliberately different shares (70/85, not 80/80): the annotator
    fits its image by *width* alone (see its own scale comment), so a
    dialog shaped too wide relative to its height produces a display size
    taller than the space available for it, forcing a vertical scroll on
    the very first paint — before anyone has touched the zoom controls,
    which reads as "already zoomed in." Less width and more height brings
    the width-driven fit size back within the vertical room actually on
    offer, checked against a 1920×1080 screen specifically.

    `body` drops Nuxt UI's default `overflow-y-auto` in favour of
    `overflow-hidden`: without that, scrolling a tall annotated image would
    scroll the *whole dialog* — toolbar, textarea and Send button included —
    off screen along with it, rather than just panning the picture. The inner
    `min-h-0 flex-1` chain (here, and again on `FeedbackAnnotator`'s own root
    and its scroll wrapper) is what makes only that one region — the image —
    actually own the scrollbar; a flex child needs `min-h-0` to be allowed to
    shrink below its content size at all, or `flex-1` alone does nothing.
  -->
  <UModal
    v-model:open="open"
    title="Send feedback"
    :ui="{
      content: 'w-[58vw] max-w-[58vw] h-[90vh] max-h-[90vh]',
      body: 'flex-1 min-h-0 overflow-hidden flex flex-col',
    }"
  >
    <template #body>
      <div class="flex min-h-0 flex-1 flex-col gap-4">
        <FeedbackAnnotator v-if="screenshot" ref="annotator" :screenshot="screenshot" class="min-h-0 flex-1" />
        <p v-else class="flex flex-1 items-center justify-center text-center text-sm text-(--ui-text-muted)">
          Couldn't capture a screenshot of this page — you can still describe what's wrong below.
        </p>

        <UTextarea
          v-model="message"
          :maxlength="MAX_FEEDBACK_MESSAGE_LENGTH"
          :rows="3"
          placeholder="What's wrong, or what could be better?"
          aria-label="Feedback message"
          class="w-full shrink-0"
        />
      </div>
    </template>

    <template #footer>
      <div class="flex justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="open = false">Cancel</UButton>
        <UButton :loading="submitting" :disabled="!message.trim()" @click="submit">Send</UButton>
      </div>
    </template>
  </UModal>
</template>
