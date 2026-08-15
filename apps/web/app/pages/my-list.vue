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
  /** Every collection this video is in; empty for a standalone one. */
  collections: { collection: { slug: string, title: string } }[]
  bannerKey: string | null
}

interface SavedItem {
  id: string
  video: CardVideo | null
  collection: {
    id: string
    slug: string
    title: string
    year: number | null
    posterKey: string | null
    /** What it holds, which is what its chip says. */
    seasonsHere?: number | null
    videosHere?: number | null
  } | null
  next: { id: string, video: CardVideo } | null
}

const api = useApi()
const toast = useToast()

/*
 * `lazy` so the page paints straight away on a client-side navigation instead
 * of leaving the previous screen frozen. A hard load is unaffected — the server
 * still awaits this and still renders the list into the HTML.
 */
const { data, refresh, status } = await useApiData<Page<SavedItem>>(
  'my-list',
  '/me/watchlist?limit=100',
  { lazy: true },
)
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

    <div v-if="items.length" class="poster-grid">
      <div v-for="item in items" :key="item.id" class="relative group/item">
        <MediaCard
          class="w-full"
          :to="
            item.collection
              ? collectionPath(item.collection)
              : videoPath(item.video!)
          "
          :title="item.collection?.title ?? item.video!.title"
          :subtitle="item.collection ? item.next?.video.title : collectionTitle(item.video!)"
          :image-url="
            item.collection
              ? collectionPoster(item.collection)
              : videoPoster(item.video!)
          "
          :width="item.collection ? item.next?.video.width : item.video!.width"
          :height="item.collection ? item.next?.video.height : item.video!.height"
          :kind="item.collection ? collectionChip(item.collection) : null"
        />

        <!--
          Visible at rest, not only on hover. This is the *only* way to take
          something off the list, and gating it behind hover left a control a
          keyboard user could tab to and see nothing of — an invisible tab stop.
          It stays quiet at 70% and comes forward on hover.

          `z-2` is what makes it usable, and it is not decoration. The card under
          it raises *itself* — `.card-lift:hover` scales it and takes
          `z-index: 1` — and nobody can reach a control sitting on a card without
          crossing the card first. At `z-index: auto` the button was therefore
          covered by the very gesture that reaches for it: plainly there at rest,
          gone the instant you went for it, and a click landing on the card's
          link instead. Anything laid over a `.card-lift` has to outrank it.
        -->
        <UButton
          icon="i-lucide-x"
          color="neutral"
          size="xs"
          class="absolute top-1.5 left-1.5 z-2 opacity-70 transition group-hover/item:opacity-100 focus-visible:opacity-100"
          :aria-label="`Remove ${item.collection?.title ?? item.video!.title}`"
          @click="remove(item)"
        />
      </div>
    </div>

    <!--
      On `status`, not on `items`. This page renders from a local ref so a
      removal can be optimistic, and that ref starts empty — so an `items`-based
      test cannot tell "not fetched yet" from "nothing saved", which is exactly
      the distinction the placeholder is here to draw.
    -->
    <div v-else-if="status !== 'success'" role="status" aria-label="Loading your list">
      <SkeletonPosterGrid />
    </div>

    <p v-else class="py-20 text-center text-(--ui-text-muted)">
      Nothing saved yet. Add something from a collection or the player.
    </p>
  </div>
</template>
