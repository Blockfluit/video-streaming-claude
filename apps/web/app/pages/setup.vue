<script setup lang="ts">
import { USERNAME_RULES, redeemFormSchema, type RedeemFormInput } from '@video/shared'

/**
 * Redeeming an invite, or the bootstrap token that creates the first admin.
 *
 * One form for both: the API cannot tell the caller which kind of token they
 * hold before they present it, and neither can this page. The rules shown are
 * the shared ones, so the hint under the field and the check on the server are
 * the same rule.
 */
definePageMeta({ layout: 'auth' })

const api = useApi()
const user = useSessionUser()
const route = useRoute()

/**
 * An invite link carries its token: `/setup?token=…`. Prefilling the field is
 * the entire point of the link — 43 characters of base64 retyped out of a chat
 * message is where an invite goes to die.
 *
 * A repeated query parameter arrives as an array, and `?token=` with no value
 * as null; both collapse to an empty field rather than rendering `undefined`
 * into the box.
 */
const linked = route.query.token
const linkedToken = (Array.isArray(linked) ? linked[0] : linked) ?? ''

/**
 * Arriving by link, the token is a question already answered, so it collapses
 * to a line of confirmation instead of a box to read and check. It stays
 * reachable: a link can carry a stale or wrong token, and "the field is filled
 * in and I cannot get at it" is a dead end.
 *
 * The input is only ever hidden by *not rendering* the collapsed row — it is
 * never detached from the form — so the value posted is the value shown.
 */
const editingToken = ref(!linkedToken)

const state = reactive<RedeemFormInput>({
  token: linkedToken,
  username: '',
  password: '',
  confirmPassword: '',
})

const pending = ref(false)
const failure = ref<string | null>(null)

async function submit() {
  pending.value = true
  failure.value = null

  try {
    // `redeemBody` is what keeps the confirmation out of the request: the form
    // has a field the endpoint does not declare, and that is the one place the
    // difference is resolved.
    user.value = await api<SessionUser>('/auth/redeem', {
      method: 'POST',
      body: redeemBody(state),
    })
    // Redeeming signs them in, so there is nowhere to send them but in.
    await navigateTo('/')
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode

    failure.value =
      status === 409
        ? 'That username is taken.'
        : status === 400
          ? // Unknown, expired, revoked and already-used all answer identically
            // on purpose — telling them apart turns a spent token into a probe.
            'That token cannot be used. Ask for a new invite.'
          : 'Could not complete setup. The library may be unreachable.'
  } finally {
    pending.value = false
  }
}

useHead({ title: 'Set up' })
</script>

<template>
  <div>
    <UCard>
      <template #header>
        <h1 class="text-lg font-semibold text-(--ui-text-highlighted)">Create your account</h1>
        <p class="mt-1 text-sm text-(--ui-text-muted)">Redeem your invite to join the library.</p>
      </template>

      <UForm :schema="redeemFormSchema" :state="state" class="space-y-6" @submit="submit">
        <!--
          Two groups, because four stacked fields read as one undifferentiated
          list and these are answers to two different questions: what you were
          given, and who you want to be. `fieldset`/`legend` rather than a
          styled heading — the grouping is real, so it should be real to a
          screen reader too, not just visible.
        -->
        <fieldset>
          <legend
            class="mb-3 text-xs font-semibold uppercase tracking-wider text-(--ui-text-dimmed)"
          >
            Your invite
          </legend>

          <UFormField v-if="editingToken" label="Token" name="token" required>
            <UInput v-model="state.token" :autofocus="!linkedToken" class="w-full" />
          </UFormField>

          <div v-else class="flex items-center gap-2 text-sm text-(--ui-text-muted)">
            <UIcon name="i-lucide-check" class="size-4 shrink-0" />
            <!-- Short enough to stay on one line beside the button: wrapped, it
                 leaves the tick floating between two lines it does not belong
                 to either of. -->
            <span class="grow">Token applied from your link.</span>
            <UButton variant="subtle" color="neutral" size="xs" @click="editingToken = true">
              Change
            </UButton>
          </div>
        </fieldset>

        <div class="border-t border-(--ui-border)" />

        <fieldset class="space-y-4">
          <!-- No bottom margin: the `space-y-4` above already sets the gap, and
               adding one here stacks with it rather than collapsing. -->
          <legend class="text-xs font-semibold uppercase tracking-wider text-(--ui-text-dimmed)">
            Your account
          </legend>

          <!--
            `help`, not `hint`. A hint is right-aligned on the label's own row,
            which is fine for the two-word ones used elsewhere in the app and
            wraps this sentence into three ragged lines pressed up against the
            word "Username". Help text is a full-width block under the field —
            and under is also where the password rules answer, so the two
            explanations line up instead of arriving from different directions.
          -->
          <UFormField label="Username" name="username" required :help="USERNAME_RULES">
            <UInput
              v-model="state.username"
              :autofocus="Boolean(linkedToken)"
              autocomplete="username"
              class="w-full"
            />
          </UFormField>

          <div>
            <UFormField label="Password" name="password" required>
              <UInput
                v-model="state.password"
                type="password"
                autocomplete="new-password"
                class="w-full"
              />
            </UFormField>

            <UFormField label="Confirm password" name="confirmPassword" required class="mt-4">
              <UInput
                v-model="state.confirmPassword"
                type="password"
                autocomplete="new-password"
                class="w-full"
              />
            </UFormField>

            <!--
              Both rules live under the pair rather than one under each box: the
              match is a property of the two together, and hanging it off the
              second field alone reads as a complaint about that field.
            -->
            <PasswordChecks :password="state.password" :confirm="state.confirmPassword" />
          </div>
        </fieldset>

        <UAlert v-if="failure" color="error" variant="subtle" :title="failure" />

        <UButton type="submit" block variant="solid" :loading="pending">Create account</UButton>
      </UForm>

      <template #footer>
        <!--
          Underlined, and a tier brighter than the sentence around it. Accent
          colour is not available to mark a link here — it never sets type in
          this app — so without the underline the only thing distinguishing
          "Sign in." from the words before it is a slight shift in grey, which
          is not a signal anyone reads as "this is the way out".
        -->
        <p class="text-sm text-(--ui-text-muted)">
          Already have an account?
          <ULink
            to="/login"
            class="text-(--ui-text) underline underline-offset-2 hover:text-(--ui-text-highlighted)"
          >
            Sign in.
          </ULink>
        </p>
      </template>
    </UCard>
  </div>
</template>
