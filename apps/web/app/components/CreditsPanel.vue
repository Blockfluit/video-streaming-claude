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
const TOP_BILLED = 8

// `roleLabel` lives in `app/utils/credits.ts` — this panel, the credits editor
// and a person's own page all sentence-case a role, and three copies of one
// line is how they drift.

const all = computed(() => data.value?.items ?? [])

const cast = computed(() => all.value.filter(credit => credit.role === 'ACTOR'))

/** The billing block: as many as fit on a poster, in the order the server sent. */
const topBilled = computed(() => cast.value.slice(0, TOP_BILLED))

/**
 * Collapsed, the panel is the cast and **one line** of crew.
 *
 * It used to cap only the cast and hide `OTHER`, leaving every key-crew group at
 * full length — so a film with one director, one composer and one editor spent
 * three headings on three names, and a series with forty producers spent rather
 * more. Reported as "the list of people credited is very large", which it was:
 * seven headings holding a dozen chips took more room than the cast did.
 */
const headline = computed(() => headlineCrew(all.value))

const hiddenCount = computed(() => Math.max(all.value.length - topBilled.value.length, 0))

/**
 * Everybody, grouped by role — the expanded view only.
 *
 * The order is total and deliberate on the server (role, position,
 * collection-before-video, name, id); re-sorting here would throw that away and
 * make the panel reshuffle between requests.
 */
const groups = computed(() => {
  const byRole = new Map<string, Credit[]>()

  for (const credit of all.value) {
    const list = byRole.get(credit.role)
    if (list) list.push(credit)
    else byRole.set(credit.role, [credit])
  }

  return [...byRole].map(([role, credits]) => ({ role, credits }))
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

    <!--
      Collapsed: the billing block, then one line naming the crew people
      actually look for. Everyone else is a button away.
    -->
    <div v-if="!expanded" class="space-y-3">
      <ul class="flex flex-wrap gap-2">
        <li v-for="credit in topBilled" :key="credit.id">
          <span
            class="inline-flex items-center gap-2 rounded-full border border-(--ui-border-accented) bg-(--ui-bg-elevated) px-3 py-1.5 text-sm"
          >
            <!--
              A name is the way to that person's filmography.

              Underlined on hover rather than tinted: an accent colour is how
              this app *marks* things, never how it sets type, and saturated
              red on a raised surface reads badly at this size however well it
              scores. The focus ring is the browser's own, left alone.
            -->
            <NuxtLink
              :to="`/people/${credit.person.slug}`"
              class="rounded-sm font-medium hover:underline focus-visible:underline"
            >{{ credit.person.name }}</NuxtLink>
            <span v-if="credit.characterName" class="text-(--ui-text-muted)">
              as {{ credit.characterName }}
            </span>
            <ImdbLink :imdb-id="credit.person.imdbId" kind="person" :label="credit.person.name" />
          </span>
        </li>
      </ul>

      <p v-if="headline.length" class="text-sm text-(--ui-text-muted)">
        <!--
          The separators are inside the interpolation, not trailing whitespace in
          the template: Vue trims a text node's edges, so `{{ label }} ` rendered
          as "Directed byDan Trachtenberg".
        -->
        <template v-for="(group, index) in headline" :key="group.label">
          <span v-if="index > 0" aria-hidden="true">{{ ' · ' }}</span>
          <span>{{ group.label }}</span>
          <!--
            The names are links now, so the comma-joining moved out of
            `join(', ')` and into a loop — and the separators between them are
            subject to exactly the same trimming as the ones between groups,
            which is why they are interpolated too rather than typed as
            whitespace between the tags.
          -->
          <template v-for="(person, place) in group.people" :key="person.slug">
            <span>{{ place > 0 ? ', ' : ' ' }}</span>
            <NuxtLink
              :to="`/people/${person.slug}`"
              class="rounded-sm text-(--ui-text-toned) hover:underline focus-visible:underline"
            >{{ person.name }}</NuxtLink>
          </template>
          <span v-if="group.more">{{ ` and ${group.more} more` }}</span>
        </template>
      </p>
    </div>

    <div v-else class="space-y-4">
      <div v-for="group in groups" :key="group.role" class="space-y-2">
        <h3 class="text-xs font-medium tracking-wide text-(--ui-text-dimmed) uppercase">
          {{ roleLabel(group.role) }}
        </h3>
        <ul class="flex flex-wrap gap-2">
          <li v-for="credit in group.credits" :key="credit.id">
            <span
              class="inline-flex items-center gap-2 rounded-full border border-(--ui-border-accented) bg-(--ui-bg-elevated) px-3 py-1.5 text-sm"
            >
              <!--
              A name is the way to that person's filmography.

              Underlined on hover rather than tinted: an accent colour is how
              this app *marks* things, never how it sets type, and saturated
              red on a raised surface reads badly at this size however well it
              scores. The focus ring is the browser's own, left alone.
            -->
            <NuxtLink
              :to="`/people/${credit.person.slug}`"
              class="rounded-sm font-medium hover:underline focus-visible:underline"
            >{{ credit.person.name }}</NuxtLink>
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
