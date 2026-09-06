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
  <UModal v-model:open="open" title="Send feedback">
    <template #body>
      <div class="space-y-4">
        <FeedbackAnnotator v-if="screenshot" ref="annotator" :screenshot="screenshot" />
        <p v-else class="text-sm text-(--ui-text-muted)">
          Couldn't capture a screenshot of this page — you can still describe what's wrong below.
        </p>

        <UTextarea
          v-model="message"
          :maxlength="MAX_FEEDBACK_MESSAGE_LENGTH"
          :rows="3"
          placeholder="What's wrong, or what could be better?"
          aria-label="Feedback message"
          class="w-full"
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
