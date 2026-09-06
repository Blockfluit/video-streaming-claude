<!-- apps/web/app/components/FeedbackButton.vue -->
<script setup lang="ts">
/**
 * The floating "send feedback" trigger, mounted once in app.vue for every
 * signed-in visitor.
 */
const open = ref(false)
const screenshot = ref<string | null>(null)
const capturing = ref(false)

async function openDialog() {
  capturing.value = true
  screenshot.value = await captureScreenshot()
  capturing.value = false
  open.value = true
}
</script>

<template>
  <button
    type="button"
    data-feedback-ui
    :disabled="capturing"
    class="fixed right-6 bottom-6 z-40 flex size-12 items-center justify-center rounded-full bg-(--ui-primary) text-(--ui-bg) shadow-lg transition-transform hover:scale-105 disabled:opacity-60"
    aria-label="Send feedback"
    @click="openDialog"
  >
    <UIcon name="i-lucide-message-circle-warning" class="size-5" />
  </button>

  <FeedbackDialog v-model:open="open" :screenshot="screenshot" />
</template>
