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
 */
interface Credit {
  id: string
  role: string
  characterName: string | null
  inherited: boolean
  person: { id: string, slug: string, name: string }
}

const props = defineProps<{ videoId: string }>()

const { data } = await useApiData<Page<Credit>>(
  `credits-${props.videoId}`,
  `/videos/${props.videoId}/credits`,
)

/** Sentence case from the enum, so a new role needs no change here. */
function roleLabel(role: string): string {
  return role.charAt(0) + role.slice(1).toLowerCase()
}

/**
 * Grouped by role, preserving the order the API sent.
 *
 * The sort is total and deliberate on the server (role, position,
 * collection-before-video, name, id); re-sorting here would throw that away and
 * make the panel reshuffle between requests.
 */
const groups = computed(() => {
  const byRole = new Map<string, Credit[]>()
  for (const credit of data.value?.items ?? []) {
    const list = byRole.get(credit.role)
    if (list) list.push(credit)
    else byRole.set(credit.role, [credit])
  }
  return [...byRole].map(([role, credits]) => ({ role, credits }))
})
</script>

<template>
  <section v-if="groups.length" class="space-y-4">
    <h2 class="text-sm font-semibold tracking-wide text-(--ui-text-muted) uppercase">
      Cast and crew
    </h2>

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
                Marked, not hidden: an inherited credit is edited on the show,
                and editing it from an episode would change every other episode.
              -->
              <span
                v-if="credit.inherited"
                class="text-xs text-(--ui-text-dimmed)"
                title="From the collection"
              >series</span>
            </span>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>
