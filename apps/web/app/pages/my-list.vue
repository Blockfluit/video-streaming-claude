<script setup lang="ts">
import type { Page } from '@video/shared'

/**
 * Saved collections and videos, newest first, each with a remove action.
 *
 * Removal is optimistic — the row goes immediately and comes back if the
 * request fails. Waiting for a round trip to un-heart something makes the whole
 * page feel broken.
 */
interface CardVideo {
  id: string
  slug: string
  title: string
  durationSec: number | null
  width: number | null
  height: number | null
  collection: { slug: string, title: string } | null
  season: { slug: string } | null
}

interface SavedItem {
  id: string
  video: CardVideo | null
  collection: { id: string, slug: string, title: string, year: number | null } | null
  next: { id: string, video: CardVideo } | null
}

const api = useApi()
const toast = useToast()

const { data, refresh } = await useApiData<Page<SavedItem>>('my-list', '/me/watchlist?limit=100')
const items = ref<SavedItem[]>([])
watchEffect(() => {
  items.value = data.value?.items ?? []
})

async function remove(item: SavedItem) {
  const before = items.value
  items.value = items.value.filter(row => row.id !== item.id)

  try {
    await api('/me/watchlist', {
      method: 'DELETE',
      body: item.collection ? { collectionId: item.collection.id } : { videoId: item.video!.id },
    })
  } catch {
    // Put it back rather than leaving the page lying about what is saved.
    items.value = before
    toast.add({ title: 'Could not remove that.', color: 'error' })
    await refresh()
  }
}

useHead({ title: 'My List' })
</script>

<template>
  <div class="page-shell space-y-6 pt-24 pb-16">
    <h1 class="text-2xl font-semibold">My list</h1>

    <div
      v-if="items.length"
      class="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-4"
    >
      <div v-for="item in items" :key="item.id" class="relative group/item">
        <MediaCard
          class="w-full"
          :to="
            item.collection
              ? (item.next ? overviewPath(item.next.video) : null) ?? collectionPath(item.collection)
              : overviewPath(item.video!) ?? '/browse'
          "
          :title="item.collection?.title ?? item.video!.title"
          :subtitle="item.collection ? item.next?.video.title : item.video!.collection?.title"
          :image-url="
            item.collection
              ? `/api/collections/${item.collection.id}/poster`
              : `/api/videos/${item.video!.id}/thumbnail`
          "
          :width="item.collection ? item.next?.video.width : item.video!.width"
          :height="item.collection ? item.next?.video.height : item.video!.height"
        />

        <UButton
          icon="i-lucide-x"
          color="neutral"
          size="xs"
          class="absolute top-1.5 left-1.5 opacity-0 group-hover/item:opacity-100 transition"
          :aria-label="`Remove ${item.collection?.title ?? item.video!.title}`"
          @click="remove(item)"
        />
      </div>
    </div>

    <p v-else class="py-20 text-center text-(--ui-text-muted)">
      Nothing saved yet. Add something from a collection or the player.
    </p>
  </div>
</template>
