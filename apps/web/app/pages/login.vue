<script setup lang="ts">
import { loginSchema, type LoginInput } from '@video/shared'

/**
 * The form validates against the API's own schema, imported from
 * `@video/shared`. A sign-in form that disagrees with the endpoint behind it
 * produces the worst kind of error: the client says the input is fine and the
 * server says it is not.
 */
definePageMeta({ layout: 'auth' })

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

useHead({ title: 'Sign in' })
</script>

<template>
  <div>
    <UCard>
      <template #header>
        <h1 class="text-lg font-semibold text-(--ui-text-highlighted)">Sign in</h1>
        <p class="mt-1 text-sm text-(--ui-text-muted)">Welcome back.</p>
      </template>

      <UForm :schema="loginSchema" :state="state" class="space-y-4" @submit="submit">
        <!--
          `autocomplete="username"` and `type="password"` below are how the
          whole browser suite signs in (`e2e/auth.setup.ts`), as is this form's
          submit button being named exactly "Sign in". They are ordinary correct
          markup and would be here anyway — but changing any of the three fails
          every browser test in the project, not just an auth one.
        -->
        <UFormField label="Username" name="username" required>
          <UInput v-model="state.username" autocomplete="username" autofocus class="w-full" />
        </UFormField>

        <UFormField label="Password" name="password" required>
          <UInput
            v-model="state.password"
            type="password"
            autocomplete="current-password"
            class="w-full"
          />
        </UFormField>

        <UAlert v-if="failure" color="error" variant="subtle" :title="failure" />

        <!--
          The one real call to action on the screen, so this is the one place a
          solid button is right. Everything else here is a link.
        -->
        <UButton type="submit" block variant="solid" :loading="pending">Sign in</UButton>
      </UForm>

      <template #footer>
        <!-- Underlined and a tier brighter: accent colour never sets type here,
             so an unmarked link is only a slight shift in grey. -->
        <p class="text-sm text-(--ui-text-muted)">
          Have an invite?
          <ULink
            to="/setup"
            class="text-(--ui-text) underline underline-offset-2 hover:text-(--ui-text-highlighted)"
          >
            Redeem it here.
          </ULink>
        </p>
      </template>
    </UCard>
  </div>
</template>
