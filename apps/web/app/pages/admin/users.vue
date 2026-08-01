<script setup lang="ts">
import { DEFAULT_INVITE_TTL_HOURS, MAX_INVITE_TTL_HOURS, type Page } from '@video/shared'

/**
 * Accounts and invite tokens.
 *
 * A minted token is shown **once** and never again — only its hash is stored,
 * so there is no way to retrieve it later. The copy button is the feature.
 *
 * The invite table is an audit surface: the row is the only record of who
 * invited whom and whether it was ever used, which is why revoking soft-deletes
 * rather than dropping it.
 */
definePageMeta({ layout: 'admin', middleware: 'admin' })

interface Account {
  id: string
  username: string
  displayName: string
  role: 'ADMIN' | 'USER'
  isActive: boolean
  createdAt: string
}

/** Whoever minted a token, or whoever spent it. */
interface InvitePerson {
  id: string
  displayName: string
  username: string
}

interface Invite {
  id: string
  kind: 'BOOTSTRAP' | 'INVITE'
  grantsRole: 'ADMIN' | 'USER'
  /** Computed by the API, not a column — `redeemed → revoked → expired`. */
  state: 'VALID' | 'REDEEMED' | 'REVOKED' | 'EXPIRED'
  expiresAt: string
  redeemedAt: string | null
  revokedAt: string | null
  createdAt: string
  createdBy: InvitePerson | null
  redeemedUser: InvitePerson | null
}

/**
 * Green means *this one can still let someone in*. With four states there is
 * only one colour worth spending on the state you can still act on, so a spent
 * token is grey rather than green — the "used by" and "redeemed" columns are
 * what carry its story.
 */
const STATE_TONE: Record<string, string> = {
  VALID: 'success',
  REDEEMED: 'neutral',
  REVOKED: 'error',
  EXPIRED: 'warning',
}

/**
 * Presets rather than a free-form number of hours: nothing to mistype, and no
 * way to send a value the API will refuse. The ends come from the shared
 * constants because they are the API's bounds, not this form's.
 */
const EXPIRY_OPTIONS = [
  { label: '24 hours', value: 24 },
  { label: '7 days', value: DEFAULT_INVITE_TTL_HOURS },
  { label: '30 days', value: 30 * 24 },
  { label: '90 days', value: MAX_INVITE_TTL_HOURS },
]

const ROLE_OPTIONS = [
  { label: 'Viewer', value: 'USER' },
  { label: 'Admin', value: 'ADMIN' },
]

const api = useApi()
const toast = useToast()
const { user } = useSession()

const { data: users, refresh: refreshUsers } = await useApiData<Page<Account>>(
  'admin-users',
  '/admin/users?limit=100',
)
const { data: invites, refresh: refreshInvites } = await useApiData<Page<Invite>>(
  'admin-invites',
  '/admin/invites?limit=100',
)

/** Held in memory only. Navigating away loses it, which is the point. */
const freshToken = ref<string | null>(null)

const expiresInHours = ref<number>(DEFAULT_INVITE_TTL_HOURS)
const grantsRole = ref<string>('USER')
const minting = ref(false)

/** The invite a revoke is being confirmed for. */
const confirming = ref<Invite | null>(null)
const revoking = ref(false)

/** UModal writes its own open state, so it needs a boolean of its own. */
const confirmingOpen = computed({
  get: () => confirming.value !== null,
  set: (open: boolean) => {
    if (!open) confirming.value = null
  },
})

/**
 * A null minter means two different things, and neither is missing data.
 * BOOTSTRAP is minted at startup with no admin present; anything else lost its
 * creator when that account was deleted. An em dash here would read as a bug.
 */
function creatorLabel(invite: Invite): string {
  return invite.kind === 'BOOTSTRAP' ? 'system' : 'deleted account'
}

/**
 * Expiry earns no column of its own — it says something in only two of the four
 * states, and the one it says nothing about already has a column for its date.
 */
function statusDetail(invite: Invite): string | null {
  if (invite.state === 'VALID') return `expires ${shortDate(invite.expiresAt) ?? '—'}`
  if (invite.state === 'EXPIRED') return `expired ${shortDate(invite.expiresAt) ?? '—'}`
  if (invite.state === 'REVOKED') return `revoked ${shortDate(invite.revokedAt) ?? '—'}`

  return null
}

async function mint() {
  minting.value = true
  try {
    const response = await api<{ token: string }>('/admin/invites', {
      method: 'POST',
      body: { expiresInHours: expiresInHours.value, grantsRole: grantsRole.value },
    })
    freshToken.value = response.token
    await refreshInvites()
  } catch (error) {
    toast.add({ title: apiMessage(error, 'Could not mint an invite.'), color: 'error' })
  } finally {
    minting.value = false
  }
}

async function copy() {
  if (!freshToken.value) return
  await navigator.clipboard.writeText(freshToken.value)
  toast.add({ title: 'Copied', color: 'success' })
}

async function revoke(invite: Invite) {
  revoking.value = true
  try {
    await api(`/admin/invites/${invite.id}`, { method: 'DELETE' })
    confirming.value = null
    await refreshInvites()
    toast.add({ title: 'Invite revoked', color: 'success' })
  } catch (error) {
    // A 404 here means it was spent or revoked between this list loading and
    // the click — the server's own words say which.
    toast.add({ title: apiMessage(error, 'Could not revoke that invite.'), color: 'error' })
  } finally {
    revoking.value = false
  }
}

async function update(account: Account, body: Record<string, unknown>) {
  try {
    await api(`/admin/users/${account.id}`, { method: 'PATCH', body })
    await refreshUsers()
  } catch (error) {
    // The API refuses to strand the library without an admin — demote,
    // deactivate or delete the last one and this is the message.
    toast.add({ title: apiMessage(error, 'That change was refused.'), color: 'error' })
  }
}

useHead({ title: 'Accounts' })
</script>

<template>
  <div class="space-y-8">
    <div>
      <h1 class="text-2xl font-bold tracking-tight">Accounts</h1>
      <p class="text-sm text-(--ui-text-muted)">There is no sign-up. People get in by invite.</p>
    </div>

    <UCard>
      <template #header><h2 class="font-semibold">Invites</h2></template>

      <div class="mb-4 flex flex-wrap items-end gap-2">
        <UFormField label="Expires in">
          <!--
            An explicit aria-label on every @nuxt/ui trigger: the component ships
            one of its own that shadows the visible label, so without this the
            accessible name of the control describes the popup, not the job.
          -->
          <USelect
            v-model="expiresInHours"
            :items="EXPIRY_OPTIONS"
            aria-label="How long the invite lasts"
            class="w-40"
          />
        </UFormField>
        <UFormField label="Grants">
          <USelect
            v-model="grantsRole"
            :items="ROLE_OPTIONS"
            aria-label="Role the invite grants"
            class="w-32"
          />
        </UFormField>
        <UButton icon="i-lucide-plus" :loading="minting" @click="mint">Mint a token</UButton>
      </div>

      <UAlert
        v-if="freshToken"
        color="primary"
        variant="subtle"
        icon="i-lucide-key-round"
        class="mb-4"
        title="Copy this now — it is not shown again"
      >
        <template #description>
          <div class="mt-2 flex items-center gap-2">
            <code class="grow rounded bg-black/40 px-2 py-1 font-mono text-xs break-all">
              {{ freshToken }}
            </code>
            <UButton size="xs" icon="i-lucide-copy" @click="copy">Copy</UButton>
          </div>
        </template>
      </UAlert>

      <!-- Eight columns will not fit a narrow viewport; the nowrap cells arm the scroll. -->
      <div v-if="invites?.items?.length" class="overflow-x-auto">
        <table aria-label="Invites" class="w-full text-sm">
          <thead class="bg-(--ui-bg-elevated) text-left text-xs text-(--ui-text-muted) uppercase">
            <tr>
              <th class="p-3">Kind</th>
              <th class="p-3">Grants</th>
              <th class="p-3">Created by</th>
              <th class="p-3">Created</th>
              <th class="p-3">Status</th>
              <th class="p-3">Used by</th>
              <th class="p-3">Redeemed</th>
              <th class="p-3" />
            </tr>
          </thead>
          <tbody class="divide-y divide-(--ui-border)">
            <tr v-for="invite in invites.items" :key="invite.id" class="hover:bg-white/[0.03]">
              <td class="p-3">
                <UBadge color="neutral" variant="subtle" size="sm">{{ invite.kind }}</UBadge>
              </td>

              <td class="p-3">
                <UBadge
                  :color="invite.grantsRole === 'ADMIN' ? 'primary' : 'neutral'"
                  variant="subtle"
                  size="sm"
                >
                  {{ invite.grantsRole }}
                </UBadge>
              </td>

              <td class="p-3">
                <template v-if="invite.createdBy">
                  <p class="font-medium">{{ invite.createdBy.displayName }}</p>
                  <p class="text-xs text-(--ui-text-muted)">{{ invite.createdBy.username }}</p>
                </template>
                <span v-else class="text-(--ui-text-muted)">{{ creatorLabel(invite) }}</span>
              </td>

              <td class="p-3 whitespace-nowrap text-(--ui-text-muted)">
                {{ shortDate(invite.createdAt) }}
              </td>

              <td class="p-3 whitespace-nowrap">
                <UBadge
                  :color="(STATE_TONE[invite.state] as any) ?? 'neutral'"
                  variant="subtle"
                  size="sm"
                >
                  {{ invite.state }}
                </UBadge>
                <p v-if="statusDetail(invite)" class="mt-1 text-xs text-(--ui-text-muted)">
                  {{ statusDetail(invite) }}
                </p>
              </td>

              <td class="p-3">
                <template v-if="invite.redeemedUser">
                  <p class="font-medium">{{ invite.redeemedUser.displayName }}</p>
                  <p class="text-xs text-(--ui-text-muted)">{{ invite.redeemedUser.username }}</p>
                </template>
                <span v-else class="text-(--ui-text-muted)">—</span>
              </td>

              <td class="p-3 whitespace-nowrap text-(--ui-text-muted)">
                {{ shortDate(invite.redeemedAt) ?? '—' }}
              </td>

              <td class="p-3 text-right">
                <!--
                  Only a VALID token can be revoked to any effect. An expired one
                  still has both columns null, so the API would take it, but
                  `tokenState` already refuses it and nothing on screen changes.
                -->
                <UButton
                  v-if="invite.state === 'VALID'"
                  size="xs"
                  color="error"
                  variant="subtle"
                  icon="i-lucide-ban"
                  :aria-label="`Revoke invite created ${dateTime(invite.createdAt)}`"
                  @click="confirming = invite"
                >
                  Revoke
                </UButton>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="text-sm text-(--ui-text-muted)">No invites yet.</p>
    </UCard>

    <UCard>
      <template #header><h2 class="font-semibold">People</h2></template>
      <table class="w-full text-sm">
        <tbody class="divide-y divide-(--ui-border)">
          <tr v-for="account in users?.items ?? []" :key="account.id">
            <td class="py-3">
              <p class="font-medium">
                {{ account.displayName }}
                <span v-if="account.id === user?.id" class="text-xs text-(--ui-text-muted)">(you)</span>
              </p>
              <p class="text-xs text-(--ui-text-muted)">{{ account.username }}</p>
            </td>
            <td class="py-3">
              <UBadge :color="account.role === 'ADMIN' ? 'primary' : 'neutral'" variant="subtle">
                {{ account.role }}
              </UBadge>
            </td>
            <td class="py-3">
              <UBadge :color="account.isActive ? 'success' : 'error'" variant="subtle">
                {{ account.isActive ? 'active' : 'disabled' }}
              </UBadge>
            </td>
            <td class="py-3 text-right">
              <div class="flex justify-end gap-2">
                <UButton
                  size="xs"
                  color="neutral" variant="subtle"
                  @click="update(account, { role: account.role === 'ADMIN' ? 'USER' : 'ADMIN' })"
                >
                  Make {{ account.role === 'ADMIN' ? 'viewer' : 'admin' }}
                </UButton>
                <UButton
                  size="xs"
                  variant="subtle"
                  :color="account.isActive ? 'error' : 'neutral'"
                  @click="update(account, { isActive: !account.isActive })"
                >
                  {{ account.isActive ? 'Disable' : 'Enable' }}
                </UButton>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </UCard>

    <!--
      The title states the situation rather than asking "are you sure?", and the
      button names the consequence. Revoking destroys nothing — the row survives
      as the record of who invited whom — but there is no un-revoke, and that is
      what earns a dialog here.
    -->
    <UModal v-model:open="confirmingOpen" title="This invite can still be used">
      <template #body>
        <div v-if="confirming" class="space-y-3 text-sm">
          <p>
            Minted by
            <strong>{{ confirming.createdBy?.displayName ?? creatorLabel(confirming) }}</strong>
            on {{ shortDate(confirming.createdAt) }}, granting
            <strong>{{ confirming.grantsRole }}</strong>. It expires on
            {{ shortDate(confirming.expiresAt) }}.
          </p>
          <p class="text-(--ui-text-muted)">
            Anyone holding this token can create an account with it until then.
            Revoking stops that immediately and cannot be undone — minting a
            replacement is the only way back.
          </p>
          <p class="text-(--ui-text-muted)">
            The invite stays in this list either way. It is the only record of
            who invited whom.
          </p>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full gap-2">
          <UButton color="neutral" variant="subtle" @click="confirming = null">Cancel</UButton>
          <UButton
            class="ml-auto"
            color="error"
            :loading="revoking"
            @click="confirming && revoke(confirming)"
          >
            Revoke this invite
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
