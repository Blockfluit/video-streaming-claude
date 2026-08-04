<script setup lang="ts">
import type { Page } from '@video/shared'

/**
 * Cast and crew under the player.
 *
 * The API has served this since step 16 and nothing ever asked for it, so the
 * merge rules — a show's credits inherited by every episode, the episode's own
 * winning a clash — were reachable only from a test. An inherited credit is
 * marked, because that is the difference between "the series' director" and
 * "the director of this episode".
 *
 * An import stores **every** crew member, which is a couple of hundred people on
 * a film, so the panel shows the top-billed cast and the jobs that have a
 * heading of their own, keeping the rest behind a toggle. The trimming is here
 * rather than in the API on purpose: the whole list already arrives in one
 * response, so expanding costs nothing and a future people search has the data.
 */
interface Credit {
  id: string
  role: string
  characterName: string | null
  jobTitle: string | null
  department: string | null
  inherited: boolean
  person: { id: string, slug: string, name: string, imdbId: string | null }
}

const props = defineProps<{ videoId: string }>()

const { data } = await useApiData<Page<Credit>>(
  `credits-${props.videoId}`,
  `/videos/${props.videoId}/credits`,
)

const expanded = ref(false)

/**
 * How many of the cast are shown before expanding.
 *
 * Roughly a poster's billing block — enough to include anybody a viewer came
 * looking for, and few enough that the crew below is still on the screen.
 */
const TOP_BILLED = 12

/** Sentence case from the enum, so a new role needs no change here. */
function roleLabel(role: string): string {
  return role.charAt(0) + role.slice(1).toLowerCase()
}

const all = computed(() => data.value?.items ?? [])

/**
 * `OTHER` is every job the library has no role of its own for — the two hundred.
 * It is always the last group, because the server orders roles by the enum's own
 * declaration and `OTHER` is declared last.
 */
const isMinor = (credit: Credit) => credit.role === 'OTHER'

const hiddenCount = computed(() => {
  const cast = all.value.filter(credit => credit.role === 'ACTOR').length
  return Math.max(cast - TOP_BILLED, 0) + all.value.filter(isMinor).length
})

/**
 * Grouped by role, preserving the order the API sent.
 *
 * The sort is total and deliberate on the server (role, position,
 * collection-before-video, name, id); re-sorting here would throw that away and
 * make the panel reshuffle between requests.
 */
const groups = computed(() => {
  const byRole = new Map<string, Credit[]>()

  for (const credit of all.value) {
    if (!expanded.value && isMinor(credit)) continue

    const list = byRole.get(credit.role)
    if (list) list.push(credit)
    else byRole.set(credit.role, [credit])
  }

  return [...byRole].map(([role, credits]) => ({
    role,
    // Only the cast is truncated. Six directors is not a wall of names, and
    // clipping the crew would hide the one person somebody came looking for.
    credits: !expanded.value && role === 'ACTOR' ? credits.slice(0, TOP_BILLED) : credits,
  }))
})
</script>

<template>
  <section v-if="all.length" class="space-y-4">
    <div class="flex items-center justify-between gap-3">
      <h2 class="text-sm font-semibold tracking-wide text-(--ui-text-muted) uppercase">
        Cast and crew
      </h2>
      <UButton
        v-if="hiddenCount > 0 || expanded"
        size="xs"
        color="neutral"
        variant="ghost"
        @click="expanded = !expanded"
      >
        {{ expanded ? 'Show less' : `Show all ${all.length} credits` }}
      </UButton>
    </div>

    <div class="space-y-4">
      <div v-for="group in groups" :key="group.role" class="space-y-2">
        <h3 class="text-xs font-medium tracking-wide text-(--ui-text-dimmed) uppercase">
          {{ roleLabel(group.role) }}
        </h3>
        <ul class="flex flex-wrap gap-2">
          <li v-for="credit in group.credits" :key="credit.id">
            <span
              class="inline-flex items-center gap-2 rounded-full border border-(--ui-border-accented) bg-(--ui-bg-elevated) px-3 py-1.5 text-sm"
            >
              <span class="font-medium">{{ credit.person.name }}</span>
              <span v-if="credit.characterName" class="text-(--ui-text-muted)">
                as {{ credit.characterName }}
              </span>
              <!--
                The raw job, which is the only thing telling two OTHER credits
                apart — without it a costume designer and a stunt coordinator both
                read as "Other" and nothing distinguishes them.
              -->
              <span
                v-else-if="credit.jobTitle && credit.role === 'OTHER'"
                class="text-(--ui-text-muted)"
              >
                {{ credit.jobTitle }}
              </span>
              <!--
                Marked, not hidden: an inherited credit is edited on the show,
                and editing it from an episode would change every other episode.
              -->
              <span
                v-if="credit.inherited"
                class="text-xs text-(--ui-text-dimmed)"
                title="From the collection"
              >series</span>
              <ImdbLink :imdb-id="credit.person.imdbId" kind="person" :label="credit.person.name" />
            </span>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>
