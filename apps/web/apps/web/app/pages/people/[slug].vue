<script setup lang="ts">
/**
 * A person and what they worked on. The filmography is filtered by the caller's
 * visibility server-side, so this never becomes a way to read the draft library.
 */
interface Credit {
  id: string
  role: string
  characterName: string | null
  collection: { id: string, slug: string, title: string, year: number | null } | null
  video: {
    id: string
    slug: string
    title: string
    collection: { slug: string, title: string } | null
  } | null
}

const route = useRoute()
const { data: person } = await useApiData<{
  name: string
  bio: string | null
  credits: Credit[]
}>(`person-${route.params.slug}`, `/people/${route.params.slug}`)

/** Grouped by role, because that is how a filmography reads. */
const byRole = computed(() => {
  const groups = new Map<string, Credit[]>()
  for (const credit of person.value?.credits ?? []) {
    const bucket = groups.get(credit.role)
    bucket ? bucket.push(credit) : groups.set(credit.role, [credit])
  }
  return [...groups.entries()]
})
</script>

<template>
  <div v-if="person" class="mx-auto max-w-5xl px-4 pt-24 pb-24 sm:px-8">
    <h1 class="text-4xl font-bold tracking-tight">{{ person.name }}</h1>
    <p v-if="person.bio" class="mt-3 max-w-2xl text-white/70">{{ person.bio }}</p>

    <div v-for="[role, credits] in byRole" :key="role" class="mt-10 space-y-3">
      <h2 class="text-sm font-semibold tracking-wide text-white/50 uppercase">{{ role }}</h2>
      <div class="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-4">
        <MediaCard
          v-for="credit in credits"
          :key="credit.id"
          class="w-full"
          :to="credit.collection
            ? `/c/${credit.collection.slug}`
            : watchPath(credit.video!) ?? '#'"
          :title="credit.collection?.title ?? credit.video!.title"
          :subtitle="credit.characterName ?? credit.video?.collection?.title"
          :image-url="credit.collection
            ? `/api/collections/${credit.collection.id}/poster`
            : `/api/videos/${credit.video!.id}/thumbnail`"
          :shape="credit.collection ? 'poster' : 'still'"
        />
      </div>
    </div>

    <p v-if="byRole.length === 0" class="py-20 text-center text-white/40">
      No credits recorded yet.
    </p>
  </div>
</template>
