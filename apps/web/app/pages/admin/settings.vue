<script setup lang="ts">
import { MIN_TITLES_FOR_MATCH_CEILING, MIN_TITLES_FOR_MATCH_FLOOR } from '@video/shared'

/**
 * App-wide settings. One field today — the "% Match" gate — with room to
 * grow: see `AppSettings` in `schema.prisma`.
 */
definePageMeta({ layout: 'admin', middleware: 'admin' })

interface Settings {
  minTitlesForMatch: number
  updatedAt: string | null
}

const api = useApi()
const toast = useToast()

const { data: settings, refresh } = await useApiData<Settings>('admin-settings', '/admin/settings')

const form = reactive({ minTitlesForMatch: MIN_TITLES_FOR_MATCH_FLOOR })

/** Re-seeds whenever the record actually changes, not on every refresh — see CLAUDE.md's admin-form rule. */
function resetForm() {
  if (!settings.value) return
  form.minTitlesForMatch = settings.value.minTitlesForMatch
}
resetForm()
watch(() => settings.value?.updatedAt, resetForm)

const saving = ref(false)

async function save() {
  saving.value = true
  try {
    await api('/admin/settings', {
      method: 'PATCH',
      body: { minTitlesForMatch: form.minTitlesForMatch },
    })
    await refresh()
    toast.add({ title: 'Settings saved', color: 'success' })
  } catch (error) {
    toast.add({ title: apiMessage(error, 'Could not save settings.'), color: 'error' })
  } finally {
    saving.value = false
  }
}

useHead({ title: 'Settings' })
</script>

<template>
  <div class="space-y-8">
    <div>
      <h1 class="text-2xl font-bold tracking-tight">Settings</h1>
      <p class="text-sm text-(--ui-text-muted)">App-wide configuration.</p>
    </div>

    <UCard>
      <template #header>
        <h2 class="font-semibold">Match %</h2>
      </template>

      <UFormField
        label="Minimum titles watched before showing a Match %"
        description="Below this, a viewer's taste profile is too new to score anything on — no badge, no Recommended row."
        class="w-full sm:w-80"
      >
        <UInput
          v-model.number="form.minTitlesForMatch"
          type="number"
          :min="MIN_TITLES_FOR_MATCH_FLOOR"
          :max="MIN_TITLES_FOR_MATCH_CEILING"
          class="w-full"
        />
      </UFormField>

      <template #footer>
        <UButton :loading="saving" @click="save">Save</UButton>
      </template>
    </UCard>
  </div>
</template>
