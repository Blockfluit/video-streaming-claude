<script setup lang="ts">
import type { FilmographyCredit } from '~/utils/credits'

/**
 * A person, and what they worked on.
 *
 * Open to any signed-in viewer. The filmography is filtered by the caller's
 * visibility **server-side** and capped there too, so a director's page never
 * becomes a way to read the draft library — there is deliberately no filter
 * here, and adding one would only hide rows the server already decided to send.
 *
 * The cards **describe** rather than play. `links.ts` sets out the rule: a
 * surface inside a collection plays, because opening a show and picking an
 * episode is the decision already made. Nobody arrives here having decided
 * anything — they arrive from a name in a cast list, which is the moment the
 * question is still *what to watch* — so `videoPath`, never `playPath`. (This
 * page used to call `watchPath`, which no longer exists: it was renamed
 * precisely because it named the one route it did not build.)
 *
 * It also spent a long time unreachable, committed one directory too deep at
 * `apps/web/apps/web/app/pages/…`, where Nuxt never looks. Nothing caught that:
 * the path matches no glob in the repo, so it was not routed, not typechecked
 * and not linted, and the app's only link to it went to a 404.
 */
interface PersonDetail {
  id: string
  slug: string
  name: string
  bio: string | null
  /** One word about what they do, from the import. Usually absent. */
  knownFor: string | null
  imdbId: string | null
  credits: FilmographyCredit[]
}

const route = useRoute()
const slug = computed(() => String(route.params.slug))

const { data: person, error, status } = await useApiData<PersonDetail>(
  () => `person-${slug.value}`,
  () => `/people/${encodeURIComponent(slug.value)}`,
  { watch: [slug], lazy: true },
)

// A slug nobody holds is a 404, the same call `/v/:slug` makes. Rendering an
// empty page instead would read as "this person has no credits yet".
//
// In a watcher rather than in setup, and `showError` rather than a throw: under
// `lazy` the request has not been made when setup runs, so `error` is null here
// and the throw would never fire. `immediate` keeps the server behaving as it
// did, where the fetch blocks and the error is already set.
watch(error, (failure) => {
  if (failure) showError({ statusCode: 404, statusMessage: 'No such person', fatal: true })
}, { immediate: true })

/** Grouped by role, in the server's order. Pure and specced — see `credits.ts`. */
const groups = computed(() => filmography(person.value?.credits ?? []))

useHead(() => ({ title: person.value?.name ?? 'Person' }))
</script>

<template>
  <div v-if="person" class="page-shell space-y-8 pt-24 pb-16">
    <div class="space-y-3">
      <!--
        What they are known for, as an eyebrow. Muted type with an accent rule
        beside it rather than accent-coloured type: colour marks things here and
        never sets type.
      -->
      <p
        v-if="person.knownFor"
        class="flex items-center gap-2 text-xs font-semibold tracking-[0.2em] text-(--ui-text-muted) uppercase"
      >
        <span aria-hidden="true" class="h-3 w-0.5 rounded-full bg-(--ui-primary)" />
        {{ person.knownFor }}
      </p>

      <div class="flex flex-wrap items-center gap-3">
        <h1 class="text-4xl font-bold tracking-tight">{{ person.name }}</h1>
        <!--
          `kind="person"` is load-bearing: the component defaults to a title id,
          and an `nm…` checked against `tt` renders no link at all.
        -->
        <ImdbLink :imdb-id="person.imdbId" kind="person" :label="person.name" />
      </div>

      <p v-if="person.bio" class="max-w-2xl text-(--ui-text-toned)">{{ person.bio }}</p>
    </div>

    <div v-for="group in groups" :key="group.role" class="space-y-3">
      <h2 class="text-sm font-semibold tracking-wide text-(--ui-text-muted) uppercase">
        {{ group.label }}
      </h2>
      <!--
        Posters throughout, which is `MediaCard`'s default and why no `shape` is
        passed. This grid used to ask for `still` on videos and `poster` on
        collections, so one row held two aspect ratios — and the video half
        asked `/videos/:id/thumbnail`, a route that no longer exists. The URLs
        come from `artwork.ts` for exactly that reason.
      -->
      <div class="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-4">
        <MediaCard
          v-for="card in group.cards"
          :key="card.creditId"
          class="w-full"
          :to="card.kind === 'collection' ? collectionPath(card) : videoPath(card)"
          :title="card.title"
          :subtitle="card.subtitle"
          :image-url="card.kind === 'collection' ? collectionPoster(card) : videoPoster(card)"
        />
      </div>
    </div>

    <p v-if="groups.length === 0" class="py-20 text-center text-(--ui-text-muted)">
      No credits recorded yet.
    </p>
  </div>

  <!-- The name and the filmography under it, in outline. -->
  <div
    v-else-if="status !== 'success'"
    class="page-shell space-y-8 pt-24 pb-16"
    role="status"
    aria-label="Loading this person"
  >
    <div class="space-y-3">
      <div class="skeleton h-3 w-28" />
      <div class="skeleton h-10 w-72" />
      <div class="skeleton h-4 w-full max-w-2xl" />
    </div>

    <div class="space-y-3">
      <div class="skeleton h-6 w-32" />
      <SkeletonPosterGrid :count="6" />
    </div>
  </div>
</template>
