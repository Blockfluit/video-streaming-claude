<script setup lang="ts">
import { PASSWORD_MIN_LENGTH, USERNAME_RULES, redeemSchema, type RedeemInput } from '@video/shared'

/**
 * Redeeming an invite, or the bootstrap token that creates the first admin.
 *
 * One form for both: the API cannot tell the caller which kind of token they
 * hold before they present it, and neither can this page. The rules shown are
 * the shared ones, so the hint under the field and the check on the server are
 * the same rule.
 */
definePageMeta({ layout: false })

const api = useApi()
const user = useSessionUser()

const state = reactive<RedeemInput>({ token: '', username: '', password: '' })
const pending = ref(false)
const failure = ref<string | null>(null)

async function submit() {
  pending.value = true
  failure.value = null

  try {
    user.value = await api<SessionUser>('/auth/redeem', { method: 'POST', body: state })
    // Redeeming signs them in, so there is nowhere to send them but in.
    await navigateTo('/')
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode

    failure.value =
      status === 409
        ? 'That username is taken.'
        : status === 400
          // Unknown, expired, revoked and already-used all answer identically
          // on purpose — telling them apart turns a spent token into a probe.
          ? 'That token cannot be used. Ask for a new invite.'
          : 'Could not complete setup. The library may be unreachable.'
  } finally {
    pending.value = false
  }
}

useHead({ title: 'Set up' })
</script>

<template>
  <div class="min-h-screen flex items-center justify-center p-6">
    <UCard class="w-full max-w-sm">
      <template #header>
        <h1 class="text-lg font-semibold">Redeem an invite</h1>
      </template>

      <UForm :schema="redeemSchema" :state="state" class="space-y-4" @submit="submit">
        <UFormField label="Token" name="token" required>
          <UInput v-model="state.token" autofocus class="w-full" />
        </UFormField>

        <UFormField label="Username" name="username" required :hint="USERNAME_RULES">
          <UInput v-model="state.username" autocomplete="username" class="w-full" />
        </UFormField>

        <UFormField
          label="Password"
          name="password"
          required
          :hint="`At least ${PASSWORD_MIN_LENGTH} characters.`"
        >
          <UInput
            v-model="state.password"
            type="password"
            autocomplete="new-password"
            class="w-full"
          />
        </UFormField>

        <UAlert v-if="failure" color="error" variant="subtle" :title="failure" />

        <UButton type="submit" block :loading="pending">Create account</UButton>
      </UForm>

      <template #footer>
        <p class="text-sm text-(--ui-text-muted)">
          Already have an account? <ULink to="/login">Sign in.</ULink>
        </p>
      </template>
    </UCard>
  </div>
</template>
