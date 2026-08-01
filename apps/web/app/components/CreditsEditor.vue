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
 */
interface Credit {
  id: string
  role: string
  characterName: string | null
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
  label: role.charAt(0) + role.slice(1).toLowerCase(),
  value: role,
}))

const personId = ref('')
const role = ref<CreditRoleName>('ACTOR')
const characterName = ref('')
const busy = ref(false)

/**
 * Everyone, fetched once, filtered in the browser.
 *
 * The first version bound `v-model:search-term` and refetched `/people?q=` on
 * every keystroke. That kept the menu in a state where selecting an option did
 * not close it — the popover stayed expanded with its search box focused, so
 * the character name typed next went into the *search field* and the credit
 * saved with no character at all. Local filtering removes the interaction
 * rather than fighting it, and a private library's cast list is small.
 */
const { data: people } = await useApiData<Page<Person>>(
  'credits-people',
  '/people?limit=100',
)

const personOptions = computed(() =>
  (people.value?.items ?? []).map(p => ({ label: p.name, value: p.id })),
)

/** Only the ones that live on this parent can be reordered or removed here. */
const own = computed(() => (data.value?.items ?? []).filter(c => !c.inherited))
const inherited = computed(() => (data.value?.items ?? []).filter(c => c.inherited))

async function add() {
  if (!personId.value) return
  busy.value = true
  try {
    await api(`${parentPath.value}/credits`, {
      method: 'POST',
      body: {
        personId: personId.value,
        role: role.value,
        characterName: characterName.value || undefined,
      },
    })
    personId.value = ''
    characterName.value = ''
    await refresh()
    toast.add({ title: 'Credit added', color: 'success' })
  }
  catch (error) {
    // A duplicate person+role on the same parent comes back 409 by design.
    toast.add({
      title: (error as { data?: { message?: string } })?.data?.message ?? 'Could not add that credit',
      color: 'error',
    })
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
 * so a reorder cannot be used to renumber credits on something else.
 */
async function move(index: number, delta: number) {
  const list = [...own.value]
  const target = index + delta
  if (target < 0 || target >= list.length) return

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
</script>

<template>
  <section class="space-y-4">
    <h2 class="text-sm font-semibold tracking-wide text-(--ui-text-muted) uppercase">
      Cast and crew
    </h2>

    <ul v-if="own.length" class="space-y-2">
      <li
        v-for="(credit, index) in own"
        :key="credit.id"
        class="flex items-center gap-3 rounded-md border border-(--ui-border) bg-(--ui-bg-elevated) p-2"
      >
        <div class="min-w-0 grow">
          <p class="truncate text-sm font-medium">{{ credit.person.name }}</p>
          <p class="text-xs text-(--ui-text-muted)">
            {{ credit.role.charAt(0) + credit.role.slice(1).toLowerCase() }}
            <span v-if="credit.characterName">— {{ credit.characterName }}</span>
          </p>
        </div>

        <UButton
          size="xs"
          color="neutral"
          variant="subtle"
          icon="i-lucide-arrow-up"
          :disabled="index === 0"
          :aria-label="`Move ${credit.person.name} up`"
          @click="move(index, -1)"
        />
        <UButton
          size="xs"
          color="neutral"
          variant="subtle"
          icon="i-lucide-arrow-down"
          :disabled="index === own.length - 1"
          :aria-label="`Move ${credit.person.name} down`"
          @click="move(index, 1)"
        />
        <UButton
          size="xs"
          color="error"
          variant="subtle"
          icon="i-lucide-x"
          :aria-label="`Remove ${credit.person.name}`"
          @click="remove(credit)"
        />
      </li>
    </ul>
    <p v-else class="text-sm text-(--ui-text-muted)">Nobody is credited yet.</p>

    <!-- Shown so it is obvious why a name appears on the episode with no controls. -->
    <div v-if="inherited.length" class="space-y-1">
      <p class="text-xs tracking-wide text-(--ui-text-dimmed) uppercase">From the collection</p>
      <p class="text-sm text-(--ui-text-muted)">
        {{ inherited.map(c => c.person.name).join(', ') }}
      </p>
    </div>

    <div class="flex flex-wrap items-end gap-2 border-t border-(--ui-border) pt-4">
      <UFormField label="Person" class="grow">
        <!--
          The explicit aria-label matters. USelectMenu's trigger ships with
          aria-label="Show popup", which shadows the visible "Search people"
          text — so the accessible name of the control that picks a person is
          "Show popup", which says nothing about what it does.
        -->
        <USelectMenu
          v-model="personId"
          :items="personOptions"
          value-key="value"
          placeholder="Search people"
          aria-label="Person to credit"
          class="w-full"
        />
      </UFormField>
      <UFormField label="Role">
        <USelect v-model="role" :items="ROLES" class="w-40" />
      </UFormField>
      <UFormField label="Character">
        <UInput v-model="characterName" placeholder="Optional" class="w-44" />
      </UFormField>
      <UButton :loading="busy" :disabled="!personId" @click="add">Add credit</UButton>
    </div>
  </section>
</template>
