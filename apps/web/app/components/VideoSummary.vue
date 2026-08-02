<script setup lang="ts">
/**
 * A video's title page — what you read before deciding to watch it.
 *
 * This used to be the player with the description underneath, which meant a
 * stream started loading before anyone had decided they wanted it, and the
 * cast and synopsis sat below the fold of a video element. Playback now lives
 * at its own route and this page is what a card opens.
 */
interface SummaryVideo {
  id: string
  slug: string
  title: string
  description: string | null
  tags: string[]
  state: string
  durationSec: number | null
  width: number | null
  height: number | null
  orderIndex: number | null
  seasonId: string | null
}

const props = defineProps<{
  video: SummaryVideo
  collection: { id: string, slug: string, title: string }
  season?: { slug: string, number: number | null } | null
  /** The rest of the collection, already ordered, for the shelf at the bottom. */
  siblings: (SummaryVideo & { seasonId: string | null })[]
  /** Built by the page, which is what knows each sibling's season slug. */
  linkTo: (entry: { slug: string, seasonId?: string | null }) => string
}>()

const { isAdmin } = useSession()

/**
 * Where this viewer got to, which decides whether the button says Play or
 * Resume. The player fetches the same thing to offer a resume once the metadata
 * arrives; asking here as well is what lets the button name a time before
 * anyone has committed to loading a stream.
 */
const { data: stats } = await useApiData<{ mine: { lastPositionSec: number } | null }>(
  () => `summary-stats-${props.video.id}`,
  () => `/videos/${props.video.id}/stats`,
  { watch: [() => props.video.id] },
)

/** Under 5s in is not worth resuming; that is where the player draws it too. */
const resumeAt = computed(() => {
  const position = stats.value?.mine?.lastPositionSec ?? 0
  const duration = props.video.durationSec ?? 0
  return position > 5 && duration > 0 && position < duration * 0.95 ? position : null
})

const episodeLabel = computed(() => {
  const season = props.season?.number
  const episode = props.video.orderIndex
  if (season === null || season === undefined) return null
  return episode === null ? `Season ${season}` : `S${season} E${episode}`
})

const otherEpisodes = computed(() => props.siblings.filter(entry => entry.id !== props.video.id))
</script>

<template>
  <div>
    <HeroBackdrop :image="`/api/videos/${video.id}/thumbnail`" size="tall">
      <div class="rise max-w-2xl space-y-4">
        <!--
          The collection in muted text with a red rule beside it, never in red
          type: red on near-black passes WCAG and still reads poorly at 12px.
        -->
        <NuxtLink
          :to="`/c/${collection.slug}`"
          class="flex w-fit items-center gap-2 text-xs font-semibold tracking-[0.2em] text-(--ui-text-muted) uppercase transition-colors hover:text-(--ui-text)"
        >
          <span aria-hidden="true" class="h-3 w-0.5 rounded-full bg-(--ui-primary)" />
          {{ collection.title }}
        </NuxtLink>

        <h1 class="text-4xl font-bold tracking-tight text-white sm:text-5xl">{{ video.title }}</h1>

        <div class="flex flex-wrap items-center gap-3 text-sm text-(--ui-text-muted)">
          <span v-if="episodeLabel">{{ episodeLabel }}</span>
          <span v-if="runtime(video.durationSec)">{{ runtime(video.durationSec) }}</span>
          <QualityBadge :width="video.width" :height="video.height" />
          <UBadge v-if="video.state !== 'PUBLISHED'" color="warning" variant="subtle">
            {{ video.state }}
          </UBadge>
        </div>

        <p v-if="video.description" class="text-(--ui-text-toned)">{{ video.description }}</p>

        <div class="flex flex-wrap items-center gap-3 pt-2">
          <!-- The one real call to action on the screen, so it is the solid one. -->
          <UButton
            :to="playPath(video)"
            size="lg"
            icon="i-lucide-play"
            class="font-semibold"
          >
            {{ resumeAt === null ? 'Play' : `Resume from ${timecode(resumeAt)}` }}
          </UButton>
          <AddToListButton :video-id="video.id" label />
          <!--
            Straight to this video's editor, so fixing a title or a marker does
            not mean walking back through the admin library to find the row you
            were just looking at.
          -->
          <UButton
            v-if="isAdmin"
            :to="`/admin/videos/${video.id}`"
            color="neutral"
            variant="subtle"
            icon="i-lucide-pencil"
          >
            Edit
          </UButton>
        </div>
      </div>
    </HeroBackdrop>

    <div class="page-shell relative z-1 -mt-4 space-y-8 pb-24">
      <div v-if="video.tags?.length" class="flex flex-wrap gap-2">
        <UBadge
          v-for="tag in video.tags"
          :key="tag"
          color="neutral"
          variant="subtle"
          :to="`/browse?tag=${encodeURIComponent(tag)}`"
        >
          {{ tag }}
        </UBadge>
      </div>

      <CreditsPanel :video-id="video.id" />

      <MediaRow
        v-if="otherEpisodes.length"
        :title="`More from ${collection.title}`"
        :empty="false"
        :to="`/c/${collection.slug}`"
      >
        <MediaCard
          v-for="entry in otherEpisodes"
          :key="entry.id"
          class="w-56 sm:w-64"
          :to="linkTo(entry)"
          :title="entry.title"
          :subtitle="runtime(entry.durationSec)"
          :image-url="`/api/videos/${entry.id}/thumbnail`"
          :width="entry.width"
          :height="entry.height"
          :badge="entry.state === 'PUBLISHED' ? null : entry.state"
        />
      </MediaRow>
    </div>
  </div>
</template>
