<!-- apps/web/app/components/FeedbackDialog.vue -->
<script setup lang="ts">
import { MAX_FEEDBACK_MESSAGE_LENGTH } from '@video/shared'

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
    await api('/feedback', {
      method: 'POST',
      body: {
        message: message.value,
        pageUrl: route.fullPath,
        userAgent: navigator.userAgent,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        screenshot: annotator.value?.export() ?? props.screenshot ?? undefined,
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
