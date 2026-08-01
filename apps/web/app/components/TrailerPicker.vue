<script setup lang="ts">
/**
 * Choosing a trailer, by pasting or by searching.
 *
 * Paste always works and needs nothing configured. Search needs a
 * `YOUTUBE_API_KEY` on the API, and the endpoint says so itself with a 503 —
 * which is what this asks rather than carrying its own idea of whether the
 * feature is on.
 *
 * Searching happens **on submit**, never as you type. A `search.list` call
 * spends 100 quota units of a 10,000/day default, so a debounced field would
 * empty the whole install's daily allowance in one editing session.
 *
 * The parsing is `parseYoutubeId` from `@video/shared` — the same function the
 * API validates with, so what this accepts and what the server accepts cannot
 * drift.
 */
import { parseYoutubeId, youtubeEmbedUrl, type Page } from '@video/shared'

const props = defineProps<{ modelValue: string | null, inherited?: string | null }>()
const emit = defineEmits<{ 'update:modelValue': [string | null] }>()

interface TrailerResult {
  youtubeId: string
  title: string
  channelTitle: string | null
  thumbnailUrl: string | null
}

const api = useApi()
const toast = useToast()

const pasted = ref('')
const query = ref('')
const results = ref<TrailerResult[]>([])
const searching = ref(false)
/** Set from the endpoint's own 503, rather than guessed at. */
const searchUnavailable = ref<string | null>(null)

/** What the preview shows: the saved trailer, or a valid paste before saving. */
const previewId = computed(() => parseYoutubeId(pasted.value) ?? props.modelValue)

const previewSrc = computed(() =>
  previewId.value ? youtubeEmbedUrl(previewId.value, { controls: true, mute: false }) : null,
)

const pasteError = computed(() =>
  pasted.value.trim().length > 0 && parseYoutubeId(pasted.value) === null
    ? 'Not a YouTube video URL or id'
    : undefined,
)

function choose(id: string | null): void {
  pasted.value = ''
  emit('update:modelValue', id)
}

async function search(): Promise<void> {
  if (query.value.trim().length === 0) return

  searching.value = true
  try {
    const page = await api<Page<TrailerResult>>(
      `/trailers/search?q=${encodeURIComponent(query.value.trim())}`,
    )
    results.value = page.items
    searchUnavailable.value = null
    if (page.items.length === 0) toast.add({ title: 'Nothing found', color: 'neutral' })
  } catch (error) {
    const status = (error as { statusCode?: number, status?: number }).statusCode
      ?? (error as { status?: number }).status
    const message = apiMessage(error, 'Search failed')

    // 503 is "not configured" or "quota spent" — both mean stop offering it and
    // say why, rather than leaving a box that fails every time it is used.
    if (status === 503) searchUnavailable.value = message
    else toast.add({ title: message, color: 'error' })
  } finally {
    searching.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <div v-if="!searchUnavailable" class="space-y-2">
      <UFormField label="Search YouTube" hint="Searches on Enter — the daily quota is small">
        <div class="flex gap-2">
          <UInput
            v-model="query"
            placeholder="Dune Part Two official trailer"
            class="grow"
            aria-label="Search YouTube for a trailer"
            @keyup.enter="search"
          />
          <UButton
            color="neutral"
            variant="subtle"
            icon="i-lucide-search"
            :loading="searching"
            @click="search"
          >
            Search
          </UButton>
        </div>
      </UFormField>

      <ul v-if="results.length" class="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <li v-for="result in results" :key="result.youtubeId">
          <button
            type="button"
            class="w-full space-y-1 rounded-md p-1 text-left transition-colors hover:bg-(--ui-bg-elevated)"
            :class="result.youtubeId === modelValue ? 'ring-1 ring-(--ui-border-accented)' : ''"
            :aria-label="`Use ${result.title} as the trailer`"
            @click="choose(result.youtubeId)"
          >
            <img
              v-if="result.thumbnailUrl"
              :src="result.thumbnailUrl"
              alt=""
              loading="lazy"
              class="aspect-video w-full rounded object-cover bg-(--ui-bg-elevated)"
            >
            <p class="line-clamp-2 text-xs font-medium">{{ result.title }}</p>
            <p v-if="result.channelTitle" class="truncate text-xs text-(--ui-text-muted)">
              {{ result.channelTitle }}
            </p>
          </button>
        </li>
      </ul>
    </div>

    <!-- Not an error: paste is the path that always works. -->
    <UAlert
      v-else
      color="neutral"
      variant="subtle"
      icon="i-lucide-info"
      :description="searchUnavailable"
    />

    <UFormField
      label="Or paste a link"
      hint="A YouTube URL or an 11-character id"
      :error="pasteError"
    >
      <div class="flex gap-2">
        <UInput
          v-model="pasted"
          placeholder="https://www.youtube.com/watch?v=…"
          class="grow"
          aria-label="Paste a YouTube URL or id"
        />
        <UButton
          color="neutral"
          variant="subtle"
          :disabled="parseYoutubeId(pasted) === null"
          @click="choose(parseYoutubeId(pasted))"
        >
          Use
        </UButton>
      </div>
    </UFormField>

    <div v-if="previewSrc" class="space-y-2">
      <iframe
        :src="previewSrc"
        title="Trailer preview"
        allow="encrypted-media"
        referrerpolicy="strict-origin-when-cross-origin"
        class="aspect-video w-full rounded-md border-0 bg-black"
      />
      <div class="flex items-center gap-2">
        <p class="grow text-xs text-(--ui-text-muted)">
          Saved as <code>{{ modelValue ?? '—' }}</code>
        </p>
        <UButton
          v-if="modelValue"
          color="neutral"
          variant="ghost"
          size="xs"
          icon="i-lucide-x"
          aria-label="Remove the trailer"
          @click="choose(null)"
        >
          Remove
        </UButton>
      </div>
    </div>

    <p v-else-if="inherited" class="text-xs text-(--ui-text-muted)">
      No trailer of its own — the collection's will be used.
    </p>
  </div>
</template>
