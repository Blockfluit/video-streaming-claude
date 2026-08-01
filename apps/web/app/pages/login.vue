<script setup lang="ts">
import { loginSchema, type LoginInput } from '@video/shared'

/**
 * The form validates against the API's own schema, imported from
 * `@video/shared`. A sign-in form that disagrees with the endpoint behind it
 * produces the worst kind of error: the client says the input is fine and the
 * server says it is not.
 */
definePageMeta({ layout: false })

const route = useRoute()
const api = useApi()
const user = useSessionUser()

const state = reactive<LoginInput>({ username: '', password: '' })
const pending = ref(false)
const failure = ref<string | null>(null)

async function submit() {
  pending.value = true
  failure.value = null

  try {
    user.value = await api<SessionUser>('/auth/login', { method: 'POST', body: state })
    // Sanitised: the value came back through the URL, so anyone can write it.
    await navigateTo(safeRedirect(route.query.redirect))
  } catch (error) {
    // The API answers a wrong password and an unknown account identically, so
    // there is one message to show and nothing to distinguish.
    failure.value =
      (error as { statusCode?: number }).statusCode === 401
        ? 'Invalid username or password.'
        : 'Could not sign in. The library may be unreachable.'
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center p-6">
    <UCard class="w-full max-w-sm">
      <template #header>
        <h1 class="text-lg font-semibold">Sign in</h1>
      </template>

      <UForm :schema="loginSchema" :state="state" class="space-y-4" @submit="submit">
        <UFormField label="Username" name="username" required>
          <UInput
            v-model="state.username"
            autocomplete="username"
            autofocus
            class="w-full"
          />
        </UFormField>

        <UFormField label="Password" name="password" required>
          <UInput
            v-model="state.password"
            type="password"
            autocomplete="current-password"
            class="w-full"
          />
        </UFormField>

        <UAlert
          v-if="failure"
          color="error"
          variant="subtle"
          :title="failure"
        />

        <UButton type="submit" block :loading="pending">Sign in</UButton>
      </UForm>

      <template #footer>
        <p class="text-sm text-(--ui-text-muted)">
          Have an invite? <ULink to="/setup">Redeem it here.</ULink>
        </p>
      </template>
    </UCard>
  </div>
</template>
