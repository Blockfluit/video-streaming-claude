<script setup lang="ts">
import { creditRoleSchema, type CreditRoleName, type Page } from '@video/shared'

/**
 * Attaching people to a video or a collection.
 *
 * Until this existed `/admin/people` could create a person and show a count of
 * their credits, and there was no way anywhere in the app to *make* one — the
 * whole credits API was write-only in theory and unreachable in practice.
 *
 * Inherited credits are listed but not editable here. They belong to the
 * collection, and editing one from an episode would silently change every other
 * episode; the panel links to where it can be edited instead.
 *
 * Both the list and the picker were built when a hand-curated library meant a
 * dozen credits and a few dozen people. An import makes that ninety-five and a
 * hundred and eleven on a single film, so the list searches and scrolls, and the
 * picker asks the server rather than filtering a page it already holds.
 */
interface Credit {
  id: string
  role: string
  characterName: string | null
  /**
   * TMDB's raw job. The API has always sent it and this component never read
   * it, so every unmapped crew member — seventy-four of them on one film —
   * rendered as the identical word "Other".
   */
  jobTitle: string | null
  department: string | null
  position: number
  inherited?: boolean
  person: { id: string, slug: string, name: string }
}

interface Person { id: string, name: string }

const props = defineProps<{
  /** Exactly one. The parent is named explicitly on every write. */
  videoId?: string
  collectionId?: string
}>()

const api = useApi()
const toast = useToast()

const parentPath = computed(() =>
  props.videoId ? `/videos/${props.videoId}` : `/collections/${props.collectionId}`,
)
const cacheKey = computed(() => `credits-editor-${props.videoId ?? props.collectionId}`)

const { data, refresh } = await useApiData<Page<Credit>>(
  cacheKey.value,
  () => `${parentPath.value}/credits`,
)

// Straight off the shared enum, so a role added to the schema appears here
// without a second list to keep in step.
const ROLES = creditRoleSchema.options.map(role => ({
  label: roleLabel(role),
  value: role,
}))

const role = ref<CreditRoleName>('ACTOR')
const characterName = ref('')
const busy = ref(false)

/** Only the ones that live on this parent can be reordered or removed here. */
const own = computed(() => (data.value?.items ?? []).filter(c => !c.inherited))
const inherited = computed(() => (data.value?.items ?? []).filter(c => c.inherited))

/**
 * Filtering the credits already on this record.
 *
 * Local, not a request: they all arrived in one response — `MAX_CREDITS` is 500
 * and the endpoint does not page — so there is nothing to fetch. Debounced only
 * to keep a long list from re-rendering on every keystroke.
 */
const filterInput = ref('')
const filter = ref('')

let filterTimer: ReturnType<typeof setTimeout> | undefined
watch(filterInput, (value) => {
  clearTimeout(filterTimer)
  filterTimer = setTimeout(() => { filter.value = value.trim().toLowerCase() }, 250)
})
onBeforeUnmount(() => clearTimeout(filterTimer))

const filtering = computed(() => filter.value.length > 0)

const shown = computed(() => {
  if (!filtering.value) return own.value

  // Name, role, job and character — the four things somebody would type looking
  // for a row among ninety-five.
  return own.value.filter(credit =>
    [credit.person.name, credit.role, credit.jobTitle, credit.characterName]
      .some(field => field?.toLowerCase().includes(filter.value)),
  )
})

/**
 * What to call one row.
 *
 * Deliberately not named `roleLabel`: that is the shared helper in
 * `app/utils/credits.ts` this delegates to, and a local binding of the same
 * name would shadow the auto-import — turning the call below into a recursive
 * one rather than a compile error.
 */
function creditLabel(credit: Credit): string {
  // The job title is what distinguishes two OTHER credits, so it wins the label
  // where there is one.
  return credit.jobTitle && credit.role === 'OTHER' ? credit.jobTitle : roleLabel(credit.role)
}

/**
 * Adding a person, searched on the server.
 *
 * This was a `USelectMenu` over `/people?limit=100` filtered in the browser, on
 * the reasoning that a private library's cast list is small. Importing a single
 * film made it a hundred and eleven, and 100 is `MAX_PAGE_LIMIT` — so the people
 * an import had just created were exactly the ones that could not be picked.
 *
 * Deliberately **not** a `USelectMenu` with its search term bound to a refetch.
 * This component is the one that tried that: replacing the options while the
 * popover is open leaves it stuck open with its own search box focused, so the
 * character name typed next lands in the search field and the credit saves with
 * no character. `RowEntryPicker` cites this as its reason for a plain input with
 * results underneath, which has no popover to get stuck.
 */
const personSearch = ref('')
const personResults = ref<Person[]>([])
const chosen = ref<Person | null>(null)
const searching = ref(false)

const PEOPLE_LIMIT = 8

let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(personSearch, () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(runPersonSearch, 250)
})
onBeforeUnmount(() => clearTimeout(searchTimer))

/** Only the newest search may write the results, whatever order they arrive in. */
let latest = 0

async function runPersonSearch(): Promise<void> {
  const mine = (latest += 1)
  const q = personSearch.value.trim()
  if (q.length === 0) {
    personResults.value = []
    return
  }

  searching.value = true
  try {
    const page = await api<Page<Person>>(
      `/people?limit=${PEOPLE_LIMIT}&q=${encodeURIComponent(q)}`,
    )
    if (mine !== latest) return
    personResults.value = page.items
  }
  catch {
    if (mine === latest) personResults.value = []
  }
  finally {
    if (mine === latest) searching.value = false
  }
}

function choose(person: Person) {
  chosen.value = person
  personSearch.value = ''
  personResults.value = []
}

async function add() {
  if (!chosen.value) return
  busy.value = true
  try {
    await api(`${parentPath.value}/credits`, {
      method: 'POST',
      body: {
        personId: chosen.value.id,
        role: role.value,
        characterName: characterName.value || undefined,
      },
    })
    chosen.value = null
    characterName.value = ''
    await refresh()
    toast.add({ title: 'Credit added', color: 'success' })
  }
  catch (error) {
    // A duplicate person+role on the same parent comes back 409 by design.
    toast.add({ title: apiMessage(error, 'Could not add that credit'), color: 'error' })
  }
  finally {
    busy.value = false
  }
}

async function remove(credit: Credit) {
  await api(`/credits/${credit.id}`, { method: 'DELETE' })
  await refresh()
}

/**
 * Moves one credit and sends the **complete** order back.
 *
 * `PATCH /credits/reorder` requires every id exactly once and names its parent,
 * so a reorder cannot be used to renumber credits on something else. The index
 * is into `own` rather than into what is on screen — which is why the controls
 * are hidden while a filter is active.
 */
async function move(credit: Credit, delta: number) {
  const list = [...own.value]
  const index = list.findIndex(c => c.id === credit.id)
  const target = index + delta
  if (index === -1 || target < 0 || target >= list.length) return

  const [moved] = list.splice(index, 1)
  if (!moved) return
  list.splice(target, 0, moved)

  await api('/credits/reorder', {
    method: 'PATCH',
    body: {
      ...(props.videoId ? { videoId: props.videoId } : { collectionId: props.collectionId }),
      creditIds: list.map(c => c.id),
    },
  })
  await refresh()
}

const isFirst = (credit: Credit) => own.value[0]?.id === credit.id
const isLast = (credit: Credit) => own.value[own.value.length - 1]?.id === credit.id
</script>

<template>
  <section class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h2 class="text-sm font-semibold tracking-wide text-(--ui-text-muted) uppercase">
        Cast and crew
      </h2>
      <UInput
        v-if="own.length > 8"
        v-model="filterInput"
        icon="i-lucide-search"
        placeholder="Filter by name, role or job"
        aria-label="Filter cast and crew"
        class="w-full sm:w-64"
      />
    </div>

    <p v-if="own.length" class="text-xs text-(--ui-text-muted)">
      {{ filtering ? `${shown.length} of ${own.length}` : `${own.length}` }}
      {{ own.length === 1 ? 'credit' : 'credits' }}
      <!--
        Said out loud rather than letting the arrows silently vanish: reordering
        works on positions in the whole list, so "down" in a filtered view means
        a place the reader cannot see.
      -->
      <span v-if="filtering"> · clear the filter to reorder</span>
    </p>

    <!--
      Bounded rather than growing the page. Ninety-five of these is about five
      thousand pixels, which buries everything below it on the screen.
    -->
    <ul
      v-if="shown.length"
      class="scroll-pane max-h-[28rem] space-y-2 overflow-y-auto rounded-md border border-(--ui-border) p-2"
    >
      <li
        v-for="credit in shown"
        :key="credit.id"
        class="flex items-center gap-3 rounded-md border border-(--ui-border) bg-(--ui-bg-elevated) p-2"
      >
        <div class="min-w-0 grow">
          <p class="truncate text-sm font-medium">{{ credit.person.name }}</p>
          <p class="truncate text-xs text-(--ui-text-muted)">
            {{ creditLabel(credit) }}
            <span v-if="credit.characterName">— {{ credit.characterName }}</span>
          </p>
        </div>

        <!--
          Three icon buttons at ~24px, two of them a mis-tap away from the one
          that removes the credit. `.tap` is a coarse-pointer floor, so the
          desktop row is unchanged.
        -->
        <template v-if="!filtering">
          <UButton
            size="xs"
            color="neutral"
            variant="subtle"
            icon="i-lucide-arrow-up"
            class="tap justify-center"
            :disabled="isFirst(credit)"
            :aria-label="`Move ${credit.person.name} up`"
            @click="move(credit, -1)"
          />
          <UButton
            size="xs"
            color="neutral"
            variant="subtle"
            icon="i-lucide-arrow-down"
            class="tap justify-center"
            :disabled="isLast(credit)"
            :aria-label="`Move ${credit.person.name} down`"
            @click="move(credit, 1)"
          />
        </template>
        <UButton
          size="xs"
          color="error"
          variant="subtle"
          icon="i-lucide-x"
          class="tap justify-center"
          :aria-label="`Remove ${credit.person.name}`"
          @click="remove(credit)"
        />
      </li>
    </ul>
    <p v-else-if="filtering" class="text-sm text-(--ui-text-muted)">Nobody here matches that.</p>
    <p v-else class="text-sm text-(--ui-text-muted)">Nobody is credited yet.</p>

    <!-- Shown so it is obvious why a name appears on the episode with no controls. -->
    <div v-if="inherited.length" class="space-y-1">
      <p class="text-xs tracking-wide text-(--ui-text-dimmed) uppercase">From the collection</p>
      <p class="text-sm text-(--ui-text-muted)">
        {{ inherited.map(c => c.person.name).join(', ') }}
      </p>
    </div>

    <div class="space-y-2 border-t border-(--ui-border) pt-4">
      <div class="flex flex-wrap items-end gap-2">
        <UFormField label="Person" class="min-w-56 grow">
          <div v-if="chosen" class="flex items-center gap-2">
            <span class="truncate text-sm font-medium">{{ chosen.name }}</span>
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              aria-label="Pick somebody else"
              @click="chosen = null"
            >
              Change
            </UButton>
          </div>
          <UInput
            v-else
            v-model="personSearch"
            icon="i-lucide-search"
            placeholder="Search people"
            aria-label="Search for a person to credit"
            class="w-full"
          />
        </UFormField>
        <UFormField label="Role">
          <USelect v-model="role" :items="ROLES" class="w-full sm:w-40" />
        </UFormField>
        <UFormField label="Character">
          <UInput v-model="characterName" placeholder="Optional" class="w-full sm:w-44" />
        </UFormField>
        <UButton :loading="busy" :disabled="!chosen" @click="add">Add credit</UButton>
      </div>

      <!-- Results underneath, so there is no popover to get stuck open. -->
      <ul v-if="personResults.length" class="space-y-1">
        <li v-for="person in personResults" :key="person.id">
          <button
            type="button"
            class="w-full rounded-md px-3 py-1.5 text-left text-sm transition-colors hover:bg-(--ui-bg-elevated)"
            @click="choose(person)"
          >
            {{ person.name }}
          </button>
        </li>
      </ul>
      <p v-else-if="personSearch && !searching" class="text-sm text-(--ui-text-muted)">
        Nobody by that name yet — add them on the People page first.
      </p>
    </div>
  </section>
</template>
