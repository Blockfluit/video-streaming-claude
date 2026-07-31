<script setup lang="ts">
/**
 * The My List toggle, used on cards, collection pages and under the player.
 *
 * Toggles **optimistically** and reconciles against the server: waiting a round
 * trip to fill in a heart makes the whole page feel broken. Both endpoints are
 * idempotent, so a double-click cannot produce two entries or a half state.
 */
const props = defineProps<{
  videoId?: string
  collectionId?: string
  saved?: boolean
  label?: boolean
}>()

const api = useApi()
const toast = useToast()

const isSaved = ref(props.saved ?? false)
watch(() => props.saved, value => { isSaved.value = value ?? false })

const busy = ref(false)
const body = computed(() =>
  props.collectionId ? { collectionId: props.collectionId } : { videoId: props.videoId },
)

async function toggle() {
  const previous = isSaved.value
  isSaved.value = !previous
  busy.value = true

  try {
    await api('/me/watchlist', { method: previous ? 'DELETE' : 'POST', body: body.value })
  } catch {
    // Put it back rather than leaving the icon lying about what is saved.
    isSaved.value = previous
    toast.add({ title: 'Could not update your list.', color: 'error' })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UButton
    :icon="isSaved ? 'i-lucide-check' : 'i-lucide-plus'"
    :color="isSaved ? 'primary' : 'neutral'"
    variant="solid"
    :loading="busy"
    :aria-label="isSaved ? 'Remove from my list' : 'Add to my list'"
    @click.prevent.stop="toggle"
  >
    <span v-if="label">{{ isSaved ? 'In my list' : 'My list' }}</span>
  </UButton>
</template>
