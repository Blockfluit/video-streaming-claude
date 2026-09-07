<!-- apps/web/app/components/FeedbackButton.vue -->
<script setup lang="ts">
/**
 * The floating "send feedback" trigger, mounted once in app.vue for every
 * signed-in visitor.
 *
 * The dismiss badge hides it for the rest of the browser session —
 * `sessionStorage`, not `localStorage`: "go away for now" is what gets asked
 * for, not "never show this again." Read only in `onMounted`, never at
 * declaration: this component renders during SSR (nothing here gates it
 * behind `<ClientOnly>`), and `sessionStorage` does not exist there.
 */
const DISMISS_KEY = 'feedback-button-hidden'

const open = ref(false)
const screenshot = ref<string | null>(null)
const capturing = ref(false)
const hidden = ref(false)

onMounted(() => {
  try {
    hidden.value = sessionStorage.getItem(DISMISS_KEY) === 'true'
  }
  catch {
    // Safari private mode throws on the API itself — showing the button is the safe default.
  }
})

function dismissForSession() {
  hidden.value = true
  try {
    sessionStorage.setItem(DISMISS_KEY, 'true')
  }
  catch {
    // Nothing to persist; it stays hidden for at least the rest of this page load.
  }
}

async function openDialog() {
  capturing.value = true
  screenshot.value = await captureScreenshot()
  capturing.value = false
  open.value = true
}
</script>

<template>
  <div v-if="!hidden" class="fixed right-6 bottom-6 z-40">
    <button
      type="button"
      data-feedback-ui
      :disabled="capturing"
      class="flex size-12 items-center justify-center rounded-full bg-(--ui-primary) text-(--ui-bg) shadow-lg transition-transform hover:scale-105 disabled:opacity-60"
      aria-label="Send feedback"
      @click="openDialog"
    >
      <UIcon name="i-lucide-message-circle-warning" class="size-5" />
    </button>

    <!--
      `.tap` grows the touch target to 44px under a coarse pointer without
      inflating the visible badge — see main.css's own note on why that has
      to be `min-*-size` growth rather than an `::after` hit-area expander.
    -->
    <button
      type="button"
      data-feedback-ui
      class="tap absolute -top-1 -right-1 z-10 flex size-6 items-center justify-center rounded-full bg-(--ui-bg-elevated) text-(--ui-text-muted) ring-1 ring-(--ui-border) hover:text-(--ui-text-highlighted)"
      aria-label="Hide the feedback button for this browsing session"
      @click="dismissForSession"
    >
      <UIcon name="i-lucide-x" class="size-3" />
    </button>
  </div>

  <FeedbackDialog v-model:open="open" :screenshot="screenshot" />
</template>
